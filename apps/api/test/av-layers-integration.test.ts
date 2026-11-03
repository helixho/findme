import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type RawSession, selectSessions } from "../src/dogfood/freeze.js";
import { LayersRunner } from "../src/dogfood/layers.js";
import { hash } from "../src/dogfood/model.js";
import type { createCodexGateway } from "../src/llm/codex-cli.js";
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "av-layer-synthetic-"));
  const input: RawSession[] = ["a", "b"].map((id) => ({
    id,
    sourceUuid: null,
    rootId: null,
    project: "synthetic",
    time: "2026-01-01",
    messages: [
      { id: `m-${id}`, role: "user", time: "2026-01-01", text: `我在 ${id} 项目选择先休息。` },
    ],
    fingerprint: "",
    groupId: "",
    selectionReasons: [],
  }));
  const selected = selectSessions(input, 2, 1, "fixed");
  const manifest = {
    format: "findme-av-dogfood-v0.1",
    id: "fake",
    createdAt: "2026-01-01",
    sourceFingerprint: hash(input),
    seed: "fixed",
    requestedSessions: 2,
    requestedHoldout: 1,
    sessions: selected.sessions,
    independence: "unknown",
    holdoutValidation: "pending",
  };
  await writeFile(path.join(directory, "raw.json"), JSON.stringify(selected.raw));
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  return { directory, manifest };
}
describe("full layer pipeline synthetic integration", () => {
  it("builds L1-L3 with complete coverage, holds out evaluation evidence, and resumes without another call", async () => {
    const f = await fixture();
    let calls = 0;
    const l3Payloads: unknown[] = [];
    const fake: ReturnType<typeof createCodexGateway> = {
      describe: (route) => ({ route, model: "synthetic-codex" }),
      extract: async (args) => {
        calls++;
        const payload = JSON.parse(args.text);
        const info = {
          route: args.route,
          model: "synthetic-codex",
          attempt: 1,
          estimate: {
            method: "serialized_utf8_bytes_conservative" as const,
            serializedUtf8Bytes: 10,
            estimatedInputTokens: 10,
          },
        };
        await args.controls?.observer?.beforeAttempt(info);
        let response: unknown;
        if (payload.segments) {
          response = {
            coverage: Object.fromEntries(
              payload.segments.map((s: { key: string }) => [
                s.key,
                { author: "subject", disposition: "personal_evidence", note: "明确自述" },
              ]),
            ),
            evidence: payload.segments.map((s: { key: string; text: string }) => ({
              key: s.key,
              quote: s.text,
              author: "subject",
              about: "self",
              kind: "choice",
              facet: "decision",
              stance: "明确选择",
              statement: "本次选择休息",
              scope: "本次项目",
            })),
          };
        } else {
          l3Payloads.push(payload);
          response = {
            overview: "有限候选",
            claims: [
              {
                text: "本次选择休息",
                scope: "本次项目",
                kind: "observation",
                evidence_ids: [payload.evidence[0].id],
                counterevidence_ids: [],
                alternatives: ["可能是临时状态"],
                uncertainty: "独立性未知",
                verification_question: null,
              },
            ],
            unknowns: [],
            data_limits: ["非总体人格"],
          };
        }
        await args.controls?.observer?.afterAttempt({
          ...info,
          status: "ok",
          errorKind: null,
          latencyMs: 1,
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
            cacheInputTokens: 0,
            cacheOutputTokens: null,
          },
        });
        return args.schema.parse(response);
      },
    };
    try {
      const before = await readFile(path.join(f.directory, "raw.json"));
      await new LayersRunner(f.directory, { extraction: fake, synthesis: fake }).execute();
      const done = JSON.parse(await readFile(path.join(f.directory, "completion.json"), "utf8"));
      expect(done.complete).toBe(true);
      expect(done.processed_segments).toBe(2);
      expect(done.L2_scenes).toBe(2);
      expect(done.L3_claims).toBe(1);
      expect(calls).toBe(4);
      const rows = (await readFile(path.join(f.directory, "L1/evidence.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      const heldout = rows.find((e) => e.split === "holdout");
      expect(heldout).toBeDefined();
      expect(JSON.stringify(l3Payloads)).not.toContain(heldout.id);
      const beforeCalls = calls;
      await new LayersRunner(f.directory, { extraction: fake, synthesis: fake }).execute();
      expect(calls).toBe(beforeCalls);
      expect(await readFile(path.join(f.directory, "raw.json"))).toEqual(before);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
  it("does not label an incomplete L1 run or create L3 as complete", async () => {
    const f = await fixture();
    const fake: ReturnType<typeof createCodexGateway> = {
      describe: (route) => ({ route, model: "synthetic-failure" }),
      extract: async () => {
        throw new Error("SYNTHETIC_FAILURE");
      },
    };
    try {
      await expect(
        new LayersRunner(f.directory, { extraction: fake, synthesis: fake }).execute(),
      ).rejects.toThrow("L1_INCOMPLETE");
      const done = JSON.parse(await readFile(path.join(f.directory, "completion.json"), "utf8"));
      expect(done.complete).toBe(false);
      expect(done.failedJobs).toHaveLength(2);
      await expect(
        readFile(path.join(f.directory, "L3/current-understanding.json")),
      ).rejects.toThrow();
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});
