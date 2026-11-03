import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseCoverageArgs } from "../scripts/av-coverage.js";
import { stableCoverageRecords } from "../src/dogfood/content-coverage.js";
import {
  type CoverageOptions,
  type ReviewSample,
  classificationSchema,
  loadCoverageInventory,
  omissionSamples,
  prepareCoverageOutput,
  reviewSchema,
  runCoverage,
} from "../src/dogfood/content-coverage.js";
import type { FreezeManifest, RawSession } from "../src/dogfood/freeze.js";
import { type LayerEvidence, makePackets, segmentSources } from "../src/dogfood/layers.js";
import { hash } from "../src/dogfood/model.js";
import { BatchStore } from "../src/dogfood/store.js";
import { createCodexGateway } from "../src/llm/codex-cli.js";
import { GatewayRequestError } from "../src/llm/gateway.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const temporary: string[] = [];
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("TEST_FIXTURE_MISSING");
  return value;
};
const json = async <T>(filename: string): Promise<T> =>
  JSON.parse(await readFile(filename, "utf8"));
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(alias = false) {
  const base = await mkdtemp(path.join(tmpdir(), "u1-coverage-"));
  temporary.push(base);
  const batch = path.join(base, "batch");
  const out = path.join(base, "out");
  await mkdir(path.join(batch, "L1"), { recursive: true });
  await mkdir(path.join(batch, "L2"));
  await mkdir(path.join(batch, "L3"));
  const texts = [
    "I prefer practical tools.",
    alias ? "I prefer practical tools." : "I enjoy varied study approaches.",
    "Please prepare a project table.",
    "Quoted article: all people must compete.",
    "That was the part I referred to.",
    "HOLDOUT_SECRET_ONLY",
  ];
  const raw: RawSession[] = texts.map((text, i) => ({
    id: `s${i}`,
    sourceUuid: null,
    rootId: null,
    time: "2025-02-01T00:00:00Z",
    project: "studio",
    machine: "synthetic",
    sourceRevision: "r1",
    sourceSessionId: `original-s${i}`,
    messages: [
      {
        id: `m${i}`,
        role: "user",
        text,
        time: "2025-02-01T00:00:00Z",
        sourceUuid: alias && i < 2 ? "same-original" : null,
      },
    ],
    fingerprint: "",
    groupId: `g${i}`,
    selectionReasons: [],
  }));
  for (const s of raw) s.fingerprint = hash(s.messages);
  const manifest: FreezeManifest = {
    format: "findme-av-dogfood-v0.1",
    id: "synthetic",
    createdAt: "2025-03-01T00:00:00Z",
    sourceFingerprint: hash(raw),
    seed: "test",
    requestedSessions: 6,
    requestedHoldout: 1,
    cutoffBefore: "2025-03-01T00:00:00Z",
    sessions: raw.map(({ messages, ...s }, i) => ({
      ...s,
      split: i === 5 ? "holdout" : "dev",
      messageIds: messages.map((m) => m.id),
    })),
    independence: "unknown",
    holdoutValidation: "pending",
  };
  const segments = segmentSources(raw, manifest);
  const aliases = new Map<string, string>();
  for (const [key, list] of Object.entries(makePackets(segments).aliases))
    for (const segment of list) aliases.set(segment.id, key);
  const dispositions = [
    "personal_evidence",
    "personal_evidence",
    "task_only",
    "context_only",
    "uncertain",
    "personal_evidence",
  ];
  const coverage = segments.map((s, i) => ({
    key: s.id,
    canonicalKey: must(aliases.get(s.id)),
    sessionId: s.sessionId,
    messageId: s.messageId,
    start: s.start,
    end: s.end,
    split: s.split,
    author: i === 3 ? "third_party" : "subject",
    disposition: dispositions[i],
    note: "synthetic coverage",
    judgedBy: "model_candidate",
  }));
  const atoms: LayerEvidence[] = segments.flatMap((s, i) =>
    i === 4
      ? []
      : [
          {
            id: `e${i}`,
            canonicalId: `c${i}`,
            segmentId: s.id,
            sessionId: s.sessionId,
            messageId: s.messageId,
            sourceUuid: s.sourceUuid,
            project: s.project,
            groupId: s.groupId,
            time: s.time,
            split: s.split,
            start: s.start,
            end: s.end,
            quote: s.text,
            author: i === 3 ? "third_party" : "subject",
            about: i === 3 ? "third_party" : i === 2 ? "project" : "self",
            kind: i === 3 ? "quotation" : i === 2 ? "work_requirement" : "evaluation",
            facet: i === 2 ? "instruction" : "evaluation",
            stance: "reported",
            statement: "DERIVED_SUMMARY_NOT_ORIGINAL",
            scope: "studio only",
            eligible: [0, 1, 5].includes(i),
            status: "candidate",
            judgedBy: "model_candidate",
          },
        ],
  );
  const scenes = raw.map((s) => {
    const rows = atoms.filter((a) => a.sessionId === s.id);
    return {
      id: `scene-${s.id}`,
      sessionId: s.id,
      project: s.project,
      groupId: s.groupId,
      split: must(manifest.sessions.find((m) => m.id === s.id)).split,
      time: s.time,
      status: "candidate",
      construction: "synthetic index",
      facets: {
        evaluation: rows.filter((a) => a.facet === "evaluation").map((a) => a.id),
        instruction: rows.filter((a) => a.facet === "instruction").map((a) => a.id),
      },
      evidence_ids: rows.map((a) => a.id),
      eligible_evidence_ids: rows.filter((a) => a.eligible).map((a) => a.id),
      coverage: { segments: 1, processed: 1 },
    };
  });
  const claim = {
    text: "One local preference",
    scope: "synthetic only",
    kind: "observation",
    evidence_ids: ["e0"],
    counterevidence_ids: [],
    alternatives: [],
    uncertainty: "unverified",
    verification_question: null,
  };
  const draft = {
    overview: "A limited synthetic report",
    claims: [claim],
    unknowns: [],
    data_limits: [],
  };
  const objects: Record<string, unknown> = {
    "manifest.json": manifest,
    "raw.json": raw,
    "L3/current-understanding.json": {
      ...draft,
      status: "candidate_owner_review_pending",
      sourceFingerprint: manifest.sourceFingerprint,
      source_cutoff: manifest.cutoffBefore,
      heldoutIncluded: false,
      context_only_ids: ["e2", "e3"],
      selection: { eligible_evidence: 2, final_evidence: 2 },
    },
    "L3/reductions.json": [{ ...draft, claims: [{ ...claim, evidence_ids: ["e0", "e1"] }] }],
    "L3/reduction-source-map.json": [
      { evidence_ids: ["e0", "e1"], context_only_ids: ["e2", "e3"] },
    ],
  };
  for (const [name, value] of Object.entries(objects))
    await writeFile(path.join(batch, name), JSON.stringify(value));
  const lines = async (name: string, rows: unknown[]) =>
    writeFile(path.join(batch, name), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  await lines("L1/coverage.jsonl", coverage);
  await lines("L1/evidence.jsonl", atoms);
  await lines("L2/scenes.jsonl", scenes);
  return { batch, out, base, atoms, coverage, scenes, lines, raw };
}
function mockGateway(failPhase?: string) {
  const payloads: Record<string, unknown>[] = [];
  const timeouts: (number | undefined)[] = [];
  let failure = failPhase;
  const gateway: NonNullable<CoverageOptions["gateway"]> = {
    describe: (route) => ({ route, model: "synthetic-model" }),
    extract: async (args) => {
      const p = JSON.parse(args.text) as Record<string, unknown>;
      payloads.push(p);
      timeouts.push(args.controls?.timeoutMs);
      const info = {
        route: args.route,
        model: "synthetic-model",
        attempt: 1,
        estimate: {
          method: "serialized_utf8_bytes_conservative" as const,
          serializedUtf8Bytes: args.text.length,
          estimatedInputTokens: args.text.length,
        },
      };
      await args.controls?.observer?.beforeAttempt(info);
      const phase = p.records ? "classification" : p.samples ? "screening" : "taxonomy";
      if (failure === phase) {
        failure = undefined;
        await args.controls?.captureRawOutput?.('{"truncated":');
        await args.controls?.observer?.afterAttempt({
          ...info,
          status: "error",
          errorKind: "json_parse",
          latencyMs: 1,
          usage: null,
        });
        throw new GatewayRequestError("json_parse");
      }
      const v =
        phase === "taxonomy"
          ? {
              topics: [
                ...Array.from({ length: 7 }, (_, i) => ({
                  id: `topic_${i}`,
                  title: `Synthetic topic ${i}`,
                })),
                { id: "other_unclear", title: "Other" },
              ],
            }
          : phase === "classification"
            ? {
                assignments: Object.fromEntries(
                  (p.records as { key: string }[]).map((r) => [
                    r.key,
                    { topics: ["topic_0"], status: "assigned", reason: "matched" },
                  ]),
                ),
              }
            : {
                reviews: Object.fromEntries(
                  (p.samples as { id: string }[]).map((r) => [
                    r.id,
                    {
                      outcome: "no_substantive_omission",
                      quote: null,
                      window_index: null,
                      start: null,
                      end: null,
                      reason: "no_omission",
                    },
                  ]),
                ),
              };
      await args.controls?.captureRawOutput?.(JSON.stringify(v));
      const parsed = args.schema.parse(v);
      await args.controls?.observer?.afterAttempt({
        ...info,
        status: "ok",
        errorKind: null,
        latencyMs: 1,
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          cacheInputTokens: 0,
          cacheOutputTokens: null,
        },
      });
      return parsed;
    },
  };
  return { gateway, payloads, timeouts };
}
async function execute(
  f: Awaited<ReturnType<typeof fixture>>,
  extra: Partial<CoverageOptions> = {},
) {
  return runCoverage({ batch: f.batch, out: f.out, repoRoot, ...extra });
}

describe("U1 inventory and source qualification", () => {
  it("reconciles all source segments and distinguishes nomination from final citation", async () => {
    const f = await fixture();
    const i = await loadCoverageInventory(f.batch);
    expect(i.ledger).toHaveLength(6);
    expect(i.canonical).toHaveLength(5);
    expect(i.canonical.filter((c) => c.reduction_nominations.length)).toHaveLength(2);
    expect(i.canonical.filter((c) => c.final_support.length)).toHaveLength(1);
    expect(i.ledger.filter((r) => r.destination === "holdout_metadata_only")).toHaveLength(1);
  });
  it("accepts L3 envelope metadata but refuses inexact original evidence", async () => {
    const f = await fixture();
    must(f.atoms[0]).quote = "Invented wording";
    await f.lines("L1/evidence.jsonl", f.atoms);
    await expect(loadCoverageInventory(f.batch)).rejects.toThrow();
  });
  it("reports missing coverage as pending rather than unknown", async () => {
    const f = await fixture();
    f.coverage.splice(4, 1);
    must(f.scenes[4]).coverage.processed = 0;
    await f.lines("L1/coverage.jsonl", f.coverage);
    await f.lines("L2/scenes.jsonl", f.scenes);
    const i = await loadCoverageInventory(f.batch);
    expect(i.ledger.filter((r) => r.processing_status === "pending")).toHaveLength(1);
    const r = await execute(f);
    expect(r.complete).toBe(false);
  });
  it("merges UUID aliases and propagates exclusions to every identical original", async () => {
    const f = await fixture(true);
    const i = await loadCoverageInventory(f.batch);
    expect(i.canonical.some((c) => c.rows.length === 2)).toBe(true);
    await new BatchStore(f.batch).update((b) => {
      const source = must(b.sources.find((s) => s.originalMessageId === "m0"));
      b.state.sourceReviews[source.id] = { revision: 1, excluded: true, context: [] };
    });
    const after = await loadCoverageInventory(f.batch);
    const group = must(after.canonical.find((c) => c.rows.some((r) => r.id === "e0")));
    expect(group.blocked).toBe(true);
    expect(omissionSamples(after).some((s) => ["m0", "m1"].includes(s.message_id))).toBe(false);
  });
  it("preserves source files and consumes no model calls by default", async () => {
    const f = await fixture();
    const before = await readFile(path.join(f.batch, "raw.json"), "utf8");
    const mock = mockGateway();
    const r = await execute(f, { gateway: mock.gateway });
    expect(r.calls_total).toBe(0);
    expect(mock.payloads).toHaveLength(0);
    expect(await readFile(path.join(f.batch, "raw.json"), "utf8")).toBe(before);
    expect((await stat(f.out)).mode & 0o777).toBe(0o700);
  });
  it("does not send holdout or existing generated summaries into semantic steps", async () => {
    const f = await fixture();
    const mock = mockGateway();
    const r = await execute(f, { gateway: mock.gateway, live: true });
    expect(r.complete).toBe(true);
    expect(JSON.stringify(mock.payloads)).not.toContain("HOLDOUT_SECRET_ONLY");
    expect(JSON.stringify(mock.payloads)).not.toContain("DERIVED_SUMMARY_NOT_ORIGINAL");
  });
  it("reuses successful jobs without additional calls, and dry-run does not replace live latest", async () => {
    const f = await fixture();
    const mock = mockGateway();
    const first = await execute(f, { gateway: mock.gateway, live: true });
    const latest = await readFile(path.join(f.out, "latest.json"), "utf8");
    const second = await execute(f, { gateway: mock.gateway, live: true });
    expect(first.calls_this_run).toBe(3);
    expect(second.calls_this_run).toBe(0);
    await execute(f);
    expect(await readFile(path.join(f.out, "latest.json"), "utf8")).toBe(latest);
  });
  it("retains failed output/unknown usage and requires explicit retry", async () => {
    const f = await fixture();
    const mock = mockGateway("classification");
    const first = await execute(f, { gateway: mock.gateway, live: true });
    expect(first.complete).toBe(false);
    const count = mock.payloads.length;
    const second = await execute(f, { gateway: mock.gateway, live: true });
    expect(second.calls_this_run).toBe(0);
    expect(mock.payloads.length).toBe(count);
    const third = await execute(f, { gateway: mock.gateway, live: true, retryFailed: true });
    expect(third.complete).toBe(true);
    expect(third.calls_this_run).toBe(1);
    expect(mock.timeouts[0]).toBe(120000);
    expect(mock.timeouts.at(-1)).toBe(180000);
    const usage = await json<{ attempts: { status: string; usage: unknown }[] }>(
      path.join(f.out, "usage.json"),
    );
    expect(usage.attempts.filter((a) => a.status === "error")).toHaveLength(1);
    expect(usage.attempts.some((a) => a.usage === null)).toBe(true);
  });
  it("stops at the total request budget and records unprocessed assignments", async () => {
    const f = await fixture();
    const mock = mockGateway();
    const r = await execute(f, { gateway: mock.gateway, live: true, maxCalls: 1 });
    expect(r.complete).toBe(false);
    expect(r.calls_total).toBe(1);
    const summary = await json<{ classification_pending: number; pending_reasons: unknown[] }>(
      path.join(r.directory, "summary.json"),
    );
    expect(summary.classification_pending).toBeGreaterThan(0);
    expect(summary.pending_reasons.length).toBeGreaterThan(0);
  });
  it("rejects output inside source or repo before creating files", async () => {
    const f = await fixture();
    const bad = path.join(f.batch, "must-not-create");
    await expect(prepareCoverageOutput(bad, repoRoot, f.batch)).rejects.toThrow(
      "PROTECTED_OUTPUT_PATH",
    );
    await expect(stat(bad)).rejects.toThrow();
    await expect(
      prepareCoverageOutput(path.join(repoRoot, "u1-output"), repoRoot, f.batch),
    ).rejects.toThrow();
  });
  it("rejects changed input binding rather than silently reusing the old result", async () => {
    const f = await fixture();
    await execute(f);
    must(f.coverage[0]).note = "new review metadata";
    await f.lines("L1/coverage.jsonl", f.coverage);
    await expect(execute(f)).rejects.toThrow("FROZEN_INPUT_CHANGED_USE_NEW_OUT");
  });
  it("records source/atom destinations without cloning the whole transcript", async () => {
    const f = await fixture();
    const r = await execute(f);
    const sourceRows = (await readFile(path.join(r.directory, "source-coverage.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    const atomRows = (await readFile(path.join(r.directory, "evidence-destinations.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    expect(sourceRows).toHaveLength(6);
    expect(atomRows).toHaveLength(5);
    expect(JSON.stringify(sourceRows)).not.toContain("I prefer practical tools");
    expect(must(atomRows.find((r) => r.id === "e0")).original_session_id).toBe("original-s0");
  });
});

describe("U1 transport and omission integrity", () => {
  it("requires exact assignment IDs and forbids unknown topics", () => {
    const schema = classificationSchema(["e1", "e2"], ["topic_0", "other_unclear"]);
    expect(() =>
      schema.parse({
        assignments: { e1: { topics: ["topic_0"], status: "assigned", reason: "matched" } },
      }),
    ).toThrow();
    expect(() =>
      schema.parse({
        assignments: {
          e1: { topics: ["unknown"], status: "assigned", reason: "matched" },
          e2: { topics: [], status: "needs_review", reason: "ambiguous" },
        },
      }),
    ).toThrow();
  });
  it("keeps explicitly unmatched classification instead of fabricating a match", () => {
    const schema = classificationSchema(["e1"], ["topic_0", "other_unclear"]);
    expect(
      schema.parse({
        assignments: { e1: { topics: [], status: "needs_review", reason: "missing_topic" } },
      }).assignments.e1?.status,
    ).toBe("needs_review");
  });
  it("normalizes uniquely exact Unicode quotes rather than trusting model offsets", () => {
    const sample = {
      id: "sample",
      windows: [{ start: 20, end: 43, text: "🧭 I prefer quiet work." }],
    } as ReviewSample;
    const schema = reviewSchema([sample]);
    const v = schema.parse({
      reviews: {
        sample: {
          outcome: "recoverable_personal_expression",
          quote: "I prefer quiet work.",
          window_index: 0,
          start: 0,
          end: 1,
          reason: "direct_expression",
        },
      },
    });
    expect(v.reviews.sample?.start).toBe(23);
    expect(v.reviews.sample?.end).toBe(43);
  });
  it("refuses invented or ambiguous recovery quotes", () => {
    const sample = {
      id: "sample",
      windows: [{ start: 0, end: 13, text: "same and same" }],
    } as ReviewSample;
    const row = {
      outcome: "recoverable_personal_expression",
      quote: "same",
      window_index: null,
      start: null,
      end: null,
      reason: "direct_expression",
    };
    expect(() => reviewSchema([sample]).parse({ reviews: { sample: row } })).toThrow();
    expect(() =>
      reviewSchema([sample]).parse({ reviews: { sample: { ...row, quote: "invented" } } }),
    ).toThrow();
  });
  it("samples only safe dev windows and distinguishes adopted controls", async () => {
    const f = await fixture();
    const i = await loadCoverageInventory(f.batch);
    const samples = omissionSamples(i);
    expect(samples.some((s) => s.category === "adopted_control")).toBe(true);
    expect(samples.every((s) => s.message_id !== "m5")).toBe(true);
    expect(JSON.stringify(samples)).not.toContain("HOLDOUT_SECRET_ONLY");
    for (const s of samples) expect(s.omitted_characters).toBeGreaterThanOrEqual(0);
  });
  it("validates CLI bounds and defaults to no live execution", () => {
    expect(parseCoverageArgs(["--batch", "/tmp/a", "--out", "/tmp/b"])).toMatchObject({
      live: false,
      maxCalls: 40,
    });
    expect(() =>
      parseCoverageArgs(["--batch", "/tmp/a", "--out", "/tmp/b", "--max-calls", "41"]),
    ).toThrow();
    expect(
      parseCoverageArgs([
        "--batch",
        "/tmp/a",
        "--out",
        "/tmp/b",
        "--max-calls",
        "41",
        "--retry-failed",
      ]),
    ).toMatchObject({ maxCalls: 41, retryFailed: true });
    expect(() =>
      parseCoverageArgs([
        "--batch",
        "/tmp/a",
        "--out",
        "/tmp/b",
        "--max-calls",
        "45",
        "--retry-failed",
      ]),
    ).toThrow("MAX_CALLS_0_TO_44_REQUIRED");
    expect(() => parseCoverageArgs(["--batch", "relative", "--out", "/tmp/b"])).toThrow();
  });
});

describe("U1 shared transport schema", () => {
  it("keeps repeated keyed row definitions compact without relaxing exact key validation", async () => {
    const ids = Array.from({ length: 96 }, (_, i) => `r${i}`);
    const topics = Array.from({ length: 18 }, (_, i) => `descriptive_topic_${i}`);
    const valid = {
      assignments: Object.fromEntries(
        ids.map((id) => [id, { topics: [topics[0]], status: "assigned", reason: "matched" }]),
      ),
    };
    let schemaBytes = 0;
    const gateway = createCodexGateway(
      { binary: "mock", version: "mock", model: "mock", effort: "high" },
      async (job) => {
        schemaBytes = Buffer.byteLength(JSON.stringify(job.schema));
        return { text: JSON.stringify(valid), usage: null };
      },
    );
    const schema = classificationSchema(ids, topics);
    const parsed = await gateway.extract({
      route: "extraction_model",
      text: "synthetic schema test",
      schema,
    });
    expect(Object.keys(parsed.assignments)).toEqual(ids);
    expect(schemaBytes).toBeLessThan(25000);
    expect(() =>
      schema.parse({
        assignments: {
          ...valid.assignments,
          extra: { topics: [topics[0]], status: "assigned", reason: "matched" },
        },
      }),
    ).toThrow();
  });
});

it("permits recovery allowance only by explicit retry before reading or writing any input", async () => {
  const args = { batch: "/not/read", out: "/not/written", repoRoot: "/not/read", maxCalls: 41 };
  await expect(runCoverage(args)).rejects.toThrow("RECOVERY_BUDGET_REQUIRES_EXPLICIT_RETRY");
  await expect(runCoverage({ ...args, maxCalls: 45, retryFailed: true })).rejects.toThrow(
    "MAX_CALLS_0_TO_44_REQUIRED",
  );
});

it("keeps immutable coverage identity independent of parallel completion order", () => {
  const a = [
    { kind: "review", canonical_id: "b" },
    { kind: "review", canonical_id: "a" },
  ];
  const b = [a[1], a[0]];
  expect(stableCoverageRecords(a)).toEqual(stableCoverageRecords(b));
  expect(a[0]?.canonical_id).toBe("b");
});
