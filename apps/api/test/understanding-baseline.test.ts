import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OldClaimReview, UnderstandingAudit, UnderstandingReport, UseRepairs } from "@findme/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseUnderstandingArgs } from "../scripts/understanding-baseline.js";
import { loadCoverageInventory } from "../src/dogfood/content-coverage.js";
import { createCodexGateway } from "../src/llm/codex-cli.js";
import { type OldClaim, loadInputs } from "../src/understanding-baseline/input.js";
import { digest, prepareOutput, sha256 } from "../src/understanding-baseline/io.js";
import { type Attempt, jobRunner } from "../src/understanding-baseline/jobs.js";
import {
  POLICY,
  PROMPTS,
  REPORT_NULL_TOKEN_NORMALIZER,
  REPORT_TIME_NORMALIZER,
  assignReport,
  normalizeReportTimes,
  validateAudit,
  validateOld,
  validateReport,
} from "../src/understanding-baseline/policy.js";
import {
  DOMAINS,
  type Fact,
  type Selection,
  facts,
  navigation,
  repairRequests,
  resolveRepairs,
  selectDomain,
} from "../src/understanding-baseline/prepare.js";
import {
  applyProviderMigration,
  providerMigrationPreflight,
} from "../src/understanding-baseline/provider-migration.js";
import {
  type UnderstandingOptions,
  runUnderstanding,
} from "../src/understanding-baseline/runner.js";
import { writeUnderstandingSources } from "./helpers/understanding-source-fixture.js";
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const temporary: string[] = [];
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const put = async (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2));
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(withRepairs = true) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "u2-synthetic-")));
  temporary.push(base);
  return writeUnderstandingSources(base, withRepairs, repoRoot);
}

function makeReport(selection: {
  evidence: Fact[];
}) {
  const e = selection.evidence.find((e) => e.use !== "context") ?? selection.evidence[0];
  const basis = {
    evidence_ids: e.use === "context" ? [] : [e.id],
    counterevidence_ids: [],
    context_ids: e.use === "context" ? [e.id] : [],
    scope: `local ${e.project}`,
    time: e.time,
    status: e.use === "context" ? "unknown" : "reported",
  };
  const finding = (key: string) => ({
    key,
    text: e.use === "context" ? "原文不足以形成个人判断。" : "本人在该局部情境如此表达。",
    ...basis,
  });
  return {
    headline: "局部理解",
    current_understanding: finding("current"),
    findings: [finding("f1"), finding("f2")],
    resources_conditions_costs: [],
    alternatives: ["可能只适用于当前情境。"],
    unknowns: ["尚未核实独立事件。"],
    question: null,
    next_step: null,
    nodes: [
      {
        key: "node",
        type: e.use === "context" ? "unknown" : "goal",
        actor: "subject",
        about: e.about === "self" ? "subject" : e.about,
        stance: e.stance,
        text: "局部候选命题",
        evidence_ids: [e.id],
        scope: basis.scope,
        time: basis.time,
        status: basis.status,
      },
    ],
    links: [],
  };
}
type MockPayload = {
  protocol?: string;
  task: string;
  requests: { id: string; rows: Fact[] }[];
  assigned: { id: string; category?: string }[];
  correction?: string;
  analysis_input_hash: string;
  old_claims: OldClaim[];
  selection: Selection;
};
function mockGateway(
  options: {
    failTask?: string;
    issueTask?: string;
    projectRepair?: boolean;
    semanticAbstention?: "pass" | "reject";
    onCall?: (p: MockPayload) => Promise<void>;
    alterResult?: (p: MockPayload, result: unknown) => unknown;
  } = {},
) {
  const payloads: MockPayload[] = [];
  const gateway: NonNullable<UnderstandingOptions["gateway"]> = {
    describe: (route) => ({ route, model: "synthetic-model" }),
    extract: async (args) => {
      const p = JSON.parse(args.text) as MockPayload;
      payloads.push(p);
      await options.onCall?.(p);
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
      if (p.task === options.failTask) {
        await args.controls?.captureRawOutput?.('{"broken":');
        await args.controls?.observer?.afterAttempt({
          ...info,
          status: "error",
          errorKind: "json_parse",
          latencyMs: 1,
          usage: null,
        });
        throw new Error("SYNTHETIC_PROVIDER_ERROR");
      }
      let result: unknown;
      if (p.task === "u2_scoped_use_and_variant_mapping")
        result = {
          repairs: p.requests.map((r: MockPayload["requests"][number]) => {
            const e = r.rows[0];
            const promote = options.projectRepair && r.id === "sample:sample-0";
            return {
              request_id: r.id,
              decision: promote ? "propositions" : "no_change",
              reason: "checked original, retain local scope",
              propositions: promote
                ? [
                    {
                      evidence_id: e.id,
                      source_id: e.source_id,
                      quote: e.quote,
                      start: null,
                      end: null,
                      type: "goal",
                      stance: "reported",
                      about: "project",
                      kind: "self_report",
                      purpose: "project_report",
                      proposition: options.semanticAbstention
                        ? "本人经常忘记同步配置。"
                        : "本人报告该项目目标。",
                      scope: "subject reported project only",
                      reason: "explicit original self report",
                    },
                  ]
                : [],
            };
          }),
        };
      else if (p.task.endsWith("audit"))
        result = {
          input_hash: p.analysis_input_hash,
          checks: p.assigned.map((a: MockPayload["assigned"][number]) => ({
            id: a.id,
            checked: true,
            rationale: "synthetic checked original",
            same_context: false,
            concrete_incompatibility: false,
          })),
          issues:
            options.semanticAbstention &&
            p.task === "u2_repair_audit" &&
            (p.correction || p.assigned.some((a) => a.category === "proposition"))
              ? !p.correction || options.semanticAbstention === "reject"
                ? [
                    {
                      code: "false_actor",
                      target_id: p.correction
                        ? null
                        : required(p.assigned.find((a) => a.category === "proposition")).id,
                      evidence_ids: [],
                      severity: "warning",
                      rationale: "原文未指定遗忘者。",
                    },
                  ]
                : []
              : p.task === options.issueTask
                ? [
                    {
                      code: "manufactured_conflict",
                      target_id: p.assigned[0].id,
                      evidence_ids: [],
                      severity: "warning",
                      rationale: "compatible conditions",
                    },
                  ]
                : [],
        };
      else if (p.task === "u2_old_five_reconciliation")
        result = {
          dispositions: p.old_claims.map((o: OldClaim, i: number) => ({
            old_id: o.id,
            disposition: i === 2 ? "reclassified" : "unchanged",
            new_kind: i === 2 ? "compatible_conditions" : o.kind,
            text: o.text,
            scope: o.scope,
            evidence_ids: [
              p.selection.evidence.find(
                (e: Fact) =>
                  e.use !== "context" &&
                  e.root_ids.some((id: string) => o.evidence_ids.includes(id)),
              )?.id ?? p.selection.evidence.find((e: Fact) => e.use !== "context").id,
            ],
            reason: "synthetic scoped support; reclassification is policy correction",
            shared_context: null,
            incompatibility: null,
          })),
        };
      else result = makeReport(p.selection);
      if (p.protocol === "u2-compact-repairs@1") {
        const full = UseRepairs.parse(result);
        result = {
          assignments: Object.fromEntries(
            full.repairs.map((r, i) => [
              `r${i}`,
              {
                decision: r.decision,
                reason: r.reason,
                propositions: r.propositions.map((prop) => {
                  const { evidence_id, source_id, start, end, reason, ...fields } = prop;
                  return { ...fields, anchor_index: 0, quote: null };
                }),
              },
            ]),
          ),
        };
      }
      if (options.alterResult) result = options.alterResult(p, result);
      await args.controls?.captureRawOutput?.(JSON.stringify(result));
      await args.controls?.observer?.afterAttempt({
        ...info,
        status: "ok",
        errorKind: null,
        latencyMs: 1,
        usage: null,
      });
      return args.schema.parse(result);
    },
  };
  return { gateway, payloads };
}
// All files, text, credentials and model responses in this suite are synthetic.
describe("U2 private CLI vertical slice", () => {
  it("parses absolute paths, capped cumulative budget, help and bounded domains", () => {
    expect(parseUnderstandingArgs(["--help"])).toEqual({ help: true });
    expect(
      parseUnderstandingArgs(["--batch", "/b", "--coverage", "/c", "--out", "/o"]).maxCalls,
    ).toBe(40);
    for (const extra of [
      ["--max-calls", "41"],
      ["--topic", "personality"],
      ["--live", "--live"],
      ["--bad"],
      ["--batch", "relative"],
    ])
      expect(() =>
        parseUnderstandingArgs(["--batch", "/b", "--coverage", "/c", "--out", "/o", ...extra]),
      ).toThrow();
  });
  it("dry-runs all inventory and nine/eight repairs without calls, preserving corrected/new topics", async () => {
    const f = await fixture();
    const m = mockGateway();
    const result = await runUnderstanding({ ...f.options, gateway: m.gateway });
    expect(result.complete).toBe(false);
    expect(result.calls_total).toBe(0);
    expect(m.payloads).toHaveLength(0);
    const plan = await json(path.join(result.directory, "plan.json"));
    expect(plan.navigation).toHaveLength(f.inv.canonical.length);
    expect(
      plan.navigation.find((n: ReturnType<typeof navigation>[number]) => n.canonical_id === "c4")
        .domains,
    ).toEqual(expect.arrayContaining(["resources_tradeoffs", "unresolved"]));
    expect(
      plan.navigation.find((n: ReturnType<typeof navigation>[number]) => n.canonical_id === "c4")
        .topics,
    ).toContain("fresh_unmapped_topic");
    const repairs = await json(path.join(result.directory, "repairs.json"));
    expect(repairs.requests).toHaveLength(17);
    expect(await json(path.join(result.directory, "baseline.json"))).toMatchObject({
      status: "partial",
      coverage: {
        mapped_inventory: f.inv.canonical.length,
        exhaustive_semantic_interpretation: false,
      },
    });
    expect((await stat(path.join(result.directory, "baseline.json"))).mode & 0o777).toBe(0o600);
  });
  it("runs generation + isolated audits, old five including reclassified, replay is zero calls/same version", async () => {
    const f = await fixture();
    const m = mockGateway({ projectRepair: true });
    const before = f.inv.bytes;
    const result = await runUnderstanding({ ...f.options, live: true, gateway: m.gateway });
    expect(result.status).toBe("ready_candidate");
    expect(result.calls_total).toBeLessThanOrEqual(22);
    expect(JSON.stringify(m.payloads)).not.toContain("HOLDOUT_SECRET_SYNTHETIC");
    const baseline = await json(path.join(result.directory, "baseline.json"));
    expect(baseline.old_claim_review.dispositions).toHaveLength(5);
    expect(baseline.old_claim_review.dispositions[2].disposition).toBe("reclassified");
    expect(baseline.old_claim_review.dispositions[1].text).toBe("旧认识 2：局部认识原句。");
    expect(baseline.all_topic_versions).toHaveLength(8);
    expect((await json(path.join(result.directory, "repairs.json"))).overlays[0]).toMatchObject({
      use: "project_report",
      content_author: "subject",
      provenance: "reviewed_model",
    });
    const second = await runUnderstanding({ ...f.options, live: true, gateway: m.gateway });
    expect(second.calls_this_run).toBe(0);
    expect(second.version).toBe(result.version);
    expect((await loadCoverageInventory(f.batch)).bytes).toEqual(before);
    const dryReplay = await runUnderstanding({ ...f.options });
    expect(dryReplay.calls_this_run).toBe(0);
    expect(dryReplay.version).toBe(result.version);
  });
  it("retains failed audit drafts, requires explicit retry, reuses successful analysis", async () => {
    const f = await fixture();
    const m = mockGateway({ failTask: "u2_domain_audit", projectRepair: true });
    const first = await runUnderstanding({ ...f.options, live: true, gateway: m.gateway });
    expect(first.complete).toBe(false);
    const second = await runUnderstanding({ ...f.options, live: true, gateway: m.gateway });
    expect(second.calls_this_run).toBe(0);
    const fixed = mockGateway({ projectRepair: true });
    const third = await runUnderstanding({
      ...f.options,
      live: true,
      gateway: fixed.gateway,
      retryFailed: true,
    });
    expect(third.complete).toBe(true);
    expect(fixed.payloads.some((p) => p.task === "u2_domain_understanding")).toBe(false);
    const usage = await json(path.join(f.out, "usage.json"));
    expect(usage.attempts.some((a: Attempt) => a.status === "error")).toBe(true);
    expect(usage.attempts.every((a: Attempt) => a.usage === null)).toBe(true);
    expect(
      usage.attempts
        .filter((a: Attempt) => a.status === "ok")
        .some((a: Attempt) => a.timeout_ms === 180000),
    ).toBe(true);
  });
  it("semantic correctness warning rejects candidate; repair failure retains original conservative use", async () => {
    const f = await fixture();
    const m = mockGateway({ projectRepair: true, issueTask: "u2_repair_audit" });
    const result = await runUnderstanding({ ...f.options, live: true, gateway: m.gateway });
    expect(result.complete).toBe(false);
    const repair = await json(path.join(result.directory, "repairs.json"));
    expect(repair.overlays).toEqual([]);
    expect(repair.unavailable).toHaveLength(17);
    const baseline = await json(path.join(result.directory, "baseline.json"));
    expect(baseline.overall).toBeNull();
    expect(baseline.topics[0].selection.repair_inputs_unavailable.length).toBeGreaterThan(0);
  });
  it("topic/model switches do not reset cumulative budget; exhausted and interrupted attempts remain", async () => {
    const f = await fixture();
    const m = mockGateway();
    const first = await runUnderstanding({
      ...f.options,
      live: true,
      gateway: m.gateway,
      maxCalls: 2,
      topic: "collaboration",
    });
    expect(first.calls_total).toBe(2);
    expect(first.complete).toBe(false);
    const second = await runUnderstanding({
      ...f.options,
      live: true,
      gateway: m.gateway,
      maxCalls: 2,
      topic: "resources_tradeoffs",
    });
    expect(second.calls_this_run).toBe(0);
    expect(second.calls_total).toBe(2);
    const usage = await json(path.join(f.out, "usage.json"));
    usage.attempts[0].status = "reserved";
    usage.integrity = digest(usage.attempts);
    await put(path.join(f.out, "usage.json"), usage);
    await runUnderstanding({ ...f.options });
    expect((await json(path.join(f.out, "usage.json"))).attempts[0].status).toBe("interrupted");
  });
  it("enforces the per-invocation provider call cap independently of cumulative budget", async () => {
    const f = await fixture();
    const m = mockGateway();
    const result = await runUnderstanding({
      ...f.options,
      live: true,
      gateway: m.gateway,
      maxCalls: 10,
      maxCallsThisRun: 1,
      topic: "collaboration",
    });
    expect(result.calls_this_run).toBe(1);
    expect(result.calls_total).toBe(1);
    expect((await json(path.join(f.out, "usage.json"))).attempts).toHaveLength(1);
  });
  it("rejects a provider/model switch before mutating an existing U2 run", async () => {
    const f = await fixture();
    const m = mockGateway();
    await runUnderstanding({
      ...f.options,
      live: true,
      gateway: m.gateway,
      maxCalls: 1,
      topic: "collaboration",
    });
    const runBefore = await readFile(path.join(f.out, "run.json"), "utf8");
    const pointerBefore = await readFile(path.join(f.out, "latest-partial.json"), "utf8");
    const changedGateway = {
      ...m.gateway,
      describe: (route: string) => ({ route, model: "different-provider-model" }),
    };
    await expect(
      runUnderstanding({
        ...f.options,
        live: true,
        gateway: changedGateway,
        maxCalls: 1,
        topic: "collaboration",
      }),
    ).rejects.toThrow("OUTPUT_MODEL_CHANGED");
    expect(await readFile(path.join(f.out, "run.json"), "utf8")).toBe(runBefore);
    expect(await readFile(path.join(f.out, "latest-partial.json"), "utf8")).toBe(pointerBefore);
  });
  it("applies provider migration as a zero-call metadata action and preserves the published pointer", async () => {
    const f = await fixture();
    const m = mockGateway();
    await runUnderstanding({
      ...f.options,
      live: true,
      gateway: m.gateway,
      maxCalls: 0,
      topic: "collaboration",
    });
    const usageBefore = await readFile(path.join(f.out, "usage.json"), "utf8");
    const progressBefore = await readFile(path.join(f.out, "progress.json"), "utf8");
    const pointerBefore = await readFile(path.join(f.out, "latest-partial.json"), "utf8");
    const preflight = await providerMigrationPreflight({
      out: f.out,
      batch: f.batch,
      coverage: f.coverage,
      targetModel: "target-model",
    });
    expect(preflight.calls_required).toBe(0);
    expect(preflight.already_applied).toBe(false);
    const applied = await applyProviderMigration({
      out: f.out,
      batch: f.batch,
      coverage: f.coverage,
      targetModel: "target-model",
    });
    expect(applied.already_applied).toBe(true);
    expect((await json(path.join(f.out, "run.json"))).continuation_model).toBe("target-model");
    expect(await readFile(path.join(f.out, "usage.json"), "utf8")).toBe(usageBefore);
    expect(await readFile(path.join(f.out, "progress.json"), "utf8")).toBe(progressBefore);
    expect(await readFile(path.join(f.out, "latest-partial.json"), "utf8")).toBe(pointerBefore);

    const targetGateway = {
      ...m.gateway,
      describe: (route: string) => ({ route, model: "target-model" }),
    };
    await expect(
      runUnderstanding({
        ...f.options,
        live: true,
        gateway: targetGateway,
        maxCalls: 0,
        topic: "collaboration",
      }),
    ).resolves.toMatchObject({ calls_this_run: 0 });
  });
  it("reuses completed lineage jobs and assigns only new jobs to the continuation model", async () => {
    const out = await realpath(await mkdtemp(path.join(tmpdir(), "u2-job-lineage-")));
    temporary.push(out);
    const schema = z.object({ value: z.string() }).strict();
    const calls: string[] = [];
    const fakeGateway = (modelName: string, value: string) =>
      ({
        describe: (route: string) => ({ route, model: modelName }),
        extract: async (args: any) => {
          calls.push(modelName);
          const info = {
            route: args.route,
            model: modelName,
            attempt: 1,
            estimate: {
              method: "serialized_utf8_bytes_conservative" as const,
              serializedUtf8Bytes: args.text.length,
              estimatedInputTokens: args.text.length,
            },
          };
          await args.controls?.observer?.beforeAttempt(info);
          const result = { value };
          await args.controls?.captureRawOutput?.(JSON.stringify(result));
          await args.controls?.observer?.afterAttempt({
            ...info,
            latencyMs: 1,
            status: "ok",
            errorKind: null,
            usage: null,
          });
          return args.schema.parse(result);
        },
      }) as NonNullable<UnderstandingOptions["gateway"]>;
    const fresh = async () => {};
    const inputHash = "f".repeat(64);
    const base = await jobRunner({
      out,
      inputHash,
      model: "lineage-model",
      gateway: fakeGateway("lineage-model", "base"),
      live: true,
      maxCalls: 3,
      fresh,
    });
    expect(await base.job("repair", { key: "same" }, schema)).toEqual({ value: "base" });

    const continued = await jobRunner({
      out,
      inputHash,
      model: "lineage-model",
      continuationModel: "target-model",
      gateway: fakeGateway("target-model", "target"),
      live: true,
      maxCalls: 3,
      fresh,
    });
    expect(await continued.job("repair", { key: "same" }, schema)).toEqual({ value: "base" });
    expect(await continued.job("repair", { key: "new" }, schema)).toEqual({ value: "target" });
    expect(calls).toEqual(["lineage-model", "target-model"]);
    const targetFingerprint = digest([
      inputHash,
      POLICY,
      PROMPTS.repair,
      "target-model",
      "repair",
      { key: "new" },
    ]);
    const input = await json(
      path.join(out, "jobs", `repair-${targetFingerprint.slice(0, 32)}-input.json`),
    );
    expect(input).toMatchObject({
      model: "target-model",
      lineage_model: "lineage-model",
      provider_migration: "u2-continuation-model@1",
    });
  });
  it("empty domain is no_evidence with no call, aliases don't become independent, distinct facets preserved", async () => {
    const f = await fixture(false);
    const input = await loadInputs(f.batch, f.coverage);
    const all = facts(input, []);
    const selected = selectDomain(
      "collaboration",
      all.filter((e) => e.canonical_id === "c1"),
    );
    expect(selected.canonical_count).toBe(1);
    expect(selected.selected_original_atoms).toBe(1);
    expect(new Set(selected.evidence.map((e) => e.proposition_type))).toEqual(
      new Set(["evaluation", "preference"]),
    );
    const duplicate = selectDomain("collaboration", [
      ...selected.evidence,
      { ...required(selected.evidence[0]), id: "synthetic-alias" },
    ]);
    expect(duplicate.evidence).toHaveLength(selected.evidence.length);
    expect(duplicate.omitted.some((o) => o.reason === "duplicate_semantic_proposition")).toBe(true);
    expect(required(navigation(input).find((n) => n.canonical_id === "c1")).facets).toEqual(
      expect.arrayContaining(["evaluation", "preference"]),
    );
    const selectedLimit = selectDomain("overall", all, new Set(), 1);
    expect(selectedLimit.selected_original_atoms).toBe(1);
    expect(selectedLimit.omitted.some((o) => o.reason === "bounded_input_budget_unanalysed")).toBe(
      true,
    );
    // Clear only synthetic memberships to make an intentionally empty domain.
    const file = path.join(f.directory, "evidence-destinations.jsonl");
    const rows = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    for (const d of rows)
      if (d.topic_mapping?.topics.includes("media_library")) d.topic_mapping.topics = ["unknown"];
    await writeFile(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    const m = mockGateway();
    const result = await runUnderstanding({
      ...f.options,
      live: true,
      gateway: m.gateway,
      topic: "daily_conditions",
    });
    expect((await json(path.join(result.directory, "topics/daily_conditions.json"))).status).toBe(
      "no_evidence",
    );
    expect(m.payloads.some((p) => p.task === "u2_domain_understanding")).toBe(false);
  });
});
describe("U2 source and immutable runtime integrity", () => {
  it("rejects source-mismatched review opinions even with a recomputed review hash", async () => {
    const f = await fixture();
    required(f.review.topic_review[0]).source_quote = "an invented quotation";
    await f.updateReview();
    await expect(loadInputs(f.batch, f.coverage)).rejects.toThrow("REVIEW_TOPIC_REFERENCE_INVALID");
  });
  it("refuses traversal and output inside frozen inputs", async () => {
    const f = await fixture();
    await expect(
      prepareOutput(path.join(f.batch, "new-output"), [repoRoot, f.batch, f.coverage]),
    ).rejects.toThrow("PROTECTED_OUTPUT_PATH");
    await put(path.join(f.coverage, "latest.json"), { version: "escape", directory: f.batch });
    await expect(loadInputs(f.batch, f.coverage)).rejects.toThrow();
  });
  it("refuses a missing result artifact without silently rerunning accepted models", async () => {
    const f = await fixture();
    const m = mockGateway({ projectRepair: true });
    const first = await runUnderstanding({ ...f.options, live: true, gateway: m.gateway });
    expect(first.complete).toBe(true);
    const calls = m.payloads.length;
    await rm(path.join(first.directory, "report.md"));
    await expect(
      runUnderstanding({ ...f.options, live: true, gateway: m.gateway }),
    ).rejects.toThrow();
    expect(m.payloads.length).toBe(calls);
    await expect(readFile(path.join(f.out, "latest-ready.json"))).rejects.toThrow();
  });
  it("refuses deleted raw transport in a completed stage cache", async () => {
    const f = await fixture();
    const m = mockGateway({ projectRepair: true });
    const first = await runUnderstanding({ ...f.options, live: true, gateway: m.gateway });
    expect(first.complete).toBe(true);
    const usage = await json(path.join(f.out, "usage.json"));
    const job = await json(path.join(f.out, "jobs", `${usage.attempts[0].job}.json`));
    await rm(job.raw_file);
    const calls = m.payloads.length;
    await expect(
      runUnderstanding({ ...f.options, live: true, gateway: m.gateway }),
    ).rejects.toThrow();
    expect(m.payloads.length).toBe(calls);
  });
  it("respects a single remaining reservation across concurrent jobs and writes consistent usage snapshots", async () => {
    const f = await fixture();
    await mkdir(f.out);
    const m = mockGateway();
    const input = await loadInputs(f.batch, f.coverage);
    const jobs = await jobRunner({
      out: f.out,
      inputHash: input.input_hash,
      model: "synthetic-model",
      gateway: m.gateway,
      live: true,
      maxCalls: 1,
      fresh: input.fresh,
    });
    const calls = await Promise.all(
      [0, 1].map((i) =>
        jobs.job(
          "audit",
          {
            task: "synthetic_audit",
            analysis_input_hash: "a".repeat(64),
            assigned: [],
            discriminator: i,
          },
          UnderstandingAudit,
        ),
      ),
    );
    expect(calls.filter(Boolean)).toHaveLength(1);
    expect(m.payloads).toHaveLength(1);
    const usage = await json(path.join(f.out, "usage.json"));
    expect(usage.attempts).toHaveLength(1);
    expect(digest(usage.attempts)).toBe(usage.integrity);
  });
  it("clears current pointers when input changes during a model call", async () => {
    const f = await fixture();
    await mkdir(f.out);
    await put(path.join(f.out, "latest-ready.json"), { version: "prior" });
    let changed = false;
    const m = mockGateway({
      projectRepair: true,
      onCall: async () => {
        if (changed) return;
        changed = true;
        const file = path.join(f.directory, "topics.json");
        const value = await json(file);
        await put(file, { ...value, sourceChanged: true });
      },
    });
    await expect(
      runUnderstanding({ ...f.options, live: true, gateway: m.gateway }),
    ).rejects.toThrow("INPUT_CHANGED");
    await expect(readFile(path.join(f.out, "latest-ready.json"))).rejects.toThrow();
    expect((await json(path.join(f.out, "usage.json"))).attempts.length).toBeGreaterThan(0);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("MISSING_REQUIRED_REFERENCE");
  return value;
}

describe("U2 proposition purpose regression", () => {
  it("reviews project self-reports outside the sampled repair list without automatically promoting them", async () => {
    const f = await fixture(false);
    const input = await loadInputs(f.batch, f.coverage);
    const requests = repairRequests(input);
    const request = required(requests.find((r) => r.kind === "project_report"));
    expect(
      request.rows.every(
        (e) => e.content_author === "subject" && e.kind === "self_report" && e.about === "project",
      ),
    ).toBe(true);
    expect(
      facts(input, [])
        .filter((e) => e.canonical_id === request.canonical_id)
        .every((e) => e.use === "context"),
    ).toBe(true);
    expect(
      requests.every((r) =>
        r.rows.every((e) => e.kind !== "quotation" && e.content_author !== "unknown"),
      ),
    ).toBe(true);
  });
  it("preserves two audited propositions on one original span as one source contribution", async () => {
    const f = await fixture(false);
    const input = await loadInputs(f.batch, f.coverage);
    const request = required(repairRequests(input).find((r) => r.kind === "project_report"));
    const e = required(request.rows[0]);
    const propositions = ["role", "goal"].map((type) => ({
      evidence_id: e.id,
      source_id: e.source_id,
      quote: e.quote,
      start: null,
      end: null,
      type,
      stance: "reported",
      about: "project",
      kind: "self_report",
      purpose: "project_report",
      proposition: type === "role" ? "本人报告承担规划角色" : "本人报告本次原型目标",
      scope: "仅本次项目自述",
      reason: "同一句中的角色与目标分开，不增加独立来源",
    }));
    const repaired = resolveRepairs(
      input,
      [request],
      UseRepairs.parse({
        repairs: [
          {
            request_id: request.id,
            decision: "propositions",
            reason: "分别保留角色和目标",
            propositions,
          },
        ],
      }),
    );
    const selected = selectDomain(
      "role_direction",
      facts(input, repaired).filter((a) => a.canonical_id === request.canonical_id),
    );
    expect(selected.evidence).toHaveLength(2);
    expect(selected.canonical_count).toBe(1);
    expect(new Set(selected.evidence.map((a) => a.proposition_type))).toEqual(
      new Set(["role", "goal"]),
    );
    expect(
      selected.evidence.every(
        (a) => a.use === "project_report" && a.provenance === "reviewed_model",
      ),
    ).toBe(true);
  });
  it("checks repaired outcome meaning independently of its old goal facet", async () => {
    const f = await fixture(false);
    const input = await loadInputs(f.batch, f.coverage);
    const fact = {
      ...required(facts(input, []).find((e) => e.use === "personal_expression")),
      proposition_type: "outcome",
      original_facet: "goal",
      facet: "goal",
      purpose: "project_report",
      use: "project_report",
      about: "project",
      kind: "self_report",
      stance: "reported",
    } satisfies Fact;
    const selection = selectDomain("role_direction", [fact]);
    const candidate = UnderstandingReport.parse(makeReport(selection));
    required(candidate.nodes[0]).type = "outcome";
    expect(() => validateReport(candidate, selection)).not.toThrow();
    const wrong = { ...fact, proposition_type: "goal" };
    expect(() => validateReport(candidate, selectDomain("role_direction", [wrong]))).toThrow(
      "PLAN_IS_NOT_OUTCOME",
    );
  });
});

describe("U2 retained unpublished model output recovery", () => {
  it("revalidates intact failed transport without a new provider call or changing historical failure", async () => {
    const f = await fixture();
    await mkdir(f.out);
    const m = mockGateway();
    const input = await loadInputs(f.batch, f.coverage);
    const jobs = await jobRunner({
      out: f.out,
      inputHash: input.input_hash,
      model: "synthetic-model",
      gateway: m.gateway,
      live: true,
      maxCalls: 1,
      fresh: input.fresh,
    });
    const payload = { task: "synthetic_audit", analysis_input_hash: "a".repeat(64), assigned: [] };
    await jobs.job("repair", payload, UnderstandingAudit, () => {
      throw new Error("REPAIR_AUTHOR_OR_USE_ESCALATION");
    });
    expect(m.payloads).toHaveLength(1);
    const candidate = await jobs.retainedRepair(payload, UnderstandingAudit);
    expect(candidate?.input_hash).toBe(payload.analysis_input_hash);
    expect(m.payloads).toHaveLength(1);
    expect(jobs.attempts[0]?.status).toBe("error");
    const checkpoint = await json(path.join(f.out, "jobs", `${jobs.attempts[0]?.job}.json`));
    expect(checkpoint.status).toBe("failed");
    await writeFile(checkpoint.raw_file, "{}");
    await expect(jobs.retainedRepair(payload, UnderstandingAudit)).rejects.toThrow();
  });
});

describe("U2 report serialization resume projections", () => {
  async function retained(stage: "topic" | "overall" = "topic", token = "null") {
    const f = await fixture(false);
    const input = await loadInputs(f.batch, f.coverage);
    const selection = selectDomain(
      "collaboration",
      facts(input, []).filter((e) => e.canonical_id === "c1"),
    );
    const payload = { task: "synthetic_report", selection };
    const draft = UnderstandingReport.parse(makeReport(selection));
    required(draft.current_understanding).time = token;
    for (const x of draft.findings) x.time = token;
    const fingerprint = digest([
      input.input_hash,
      POLICY,
      PROMPTS[stage],
      "synthetic-model",
      stage,
      payload,
    ]);
    const id = `${stage}-${fingerprint.slice(0, 32)}`;
    await mkdir(path.join(f.out, "jobs"), { recursive: true });
    const raw = path.join(f.out, "jobs", `${id}-attempt-1-raw.txt`);
    const checkpoint = path.join(f.out, "jobs", `${id}.json`);
    const inputFile = path.join(f.out, "jobs", `${id}-input.json`);
    await put(raw, draft);
    await put(inputFile, {
      fingerprint,
      input_hash: input.input_hash,
      policy: POLICY,
      prompt: PROMPTS[stage],
      model: "synthetic-model",
      payload,
    });
    await put(checkpoint, {
      id,
      fingerprint,
      status: "failed",
      error: "TIME_SCOPE_MISMATCH",
      result: draft,
      result_hash: digest(draft),
      raw_file: raw,
    });
    const attempt: Attempt = {
      id: "attempt-1",
      job: id,
      status: "error",
      error: "TIME_SCOPE_MISMATCH",
      timeout_ms: 120000,
      info: {
        route: "extraction_model",
        model: "synthetic-model",
        attempt: 1,
        estimate: {
          method: "serialized_utf8_bytes_conservative",
          serializedUtf8Bytes: 1,
          estimatedInputTokens: 1,
        },
      },
      usage: null,
    };
    await put(path.join(f.out, "usage.json"), {
      attempts: [attempt],
      integrity: digest([attempt]),
    });
    const m = mockGateway();
    const jobs = await jobRunner({
      out: f.out,
      inputHash: input.input_hash,
      model: "synthetic-model",
      gateway: m.gateway,
      live: true,
      retryFailed: true,
      maxCalls: 1,
      fresh: input.fresh,
    });
    const recover = () =>
      jobs.job(stage, payload, UnderstandingReport, (r) => validateReport(r, selection));
    return {
      f,
      input,
      selection,
      payload,
      draft,
      checkpoint,
      raw,
      inputFile,
      jobs,
      m,
      recover,
      id,
      stage,
    };
  }
  it.each([
    ["topic", "null"],
    ["overall", "null"],
    ["topic", ""],
    ["overall", ""],
    ["topic", "/null/"],
    ["overall", "/null/"],
  ] as const)(
    "recovers retained %s time token %j without calls; projection is versioned and preserves history",
    async (stage, token) => {
      const f = await retained(stage, token);
      const version = token === "null" ? REPORT_TIME_NORMALIZER : REPORT_NULL_TOKEN_NORMALIZER;
      if (token !== "null")
        expect(
          normalizeReportTimes(f.draft, f.selection, REPORT_TIME_NORMALIZER).current_understanding
            ?.time,
        ).toBe(token);
      const historical = await readFile(f.checkpoint, "utf8");
      const raw = await readFile(f.raw, "utf8");
      const result = await f.recover();
      expect(required(required(result).current_understanding).time).toBeNull();
      expect(required(result).nodes).toEqual(f.draft.nodes);
      expect(f.m.payloads).toHaveLength(0);
      expect(f.jobs.callsThisRun).toBe(0);
      expect(f.jobs.attempts).toHaveLength(1);
      expect(required(f.jobs.attempts[0]).status).toBe("error");
      expect(await readFile(f.checkpoint, "utf8")).toBe(historical);
      expect(await readFile(f.raw, "utf8")).toBe(raw);
      const projectionFile = path.join(f.f.out, "jobs", `${f.id}-${version}.json`);
      const projection = await json(projectionFile);
      expect(projection.transform).toMatchObject({
        version,
        raw_sha256: sha256(raw),
        dependency_hash: digest(JSON.parse(historical)),
      });
      expect(projection.projection_hash).toBe(digest([projection.transform, result]));
      expect(f.jobs.provenance(stage, f.payload)).toMatchObject({
        projection_hash: projection.projection_hash,
      });
      expect(await f.recover()).toEqual(result);
      projection.transform.version = "tampered";
      await put(projectionFile, projection);
      await expect(f.recover()).rejects.toThrow("REPORT_PROJECTION_INTEGRITY");
    },
  );
  it.each(["raw", "result", "input"] as const)(
    "refuses tampered retained %s without another provider call",
    async (which) => {
      const f = await retained();
      if (which === "raw") await put(f.raw, { ...f.draft, headline: "tampered" });
      if (which === "result") {
        const saved = await json(f.checkpoint);
        saved.result.headline = "tampered";
        saved.result_hash = digest(saved.result);
        await put(f.checkpoint, saved);
      }
      if (which === "input") {
        const saved = await json(f.inputFile);
        saved.payload.task = "tampered";
        await put(f.inputFile, saved);
      }
      await expect(f.recover()).rejects.toThrow(/RETAINED_(RAW|INPUT)_INTEGRITY/);
      expect(f.m.payloads).toHaveLength(0);
    },
  );
  it.each(["2027-01-01", "status", "unknown", " ", "NULL"])(
    "does not erase an invented date or arbitrary label %j",
    async (badTime) => {
      const f = await retained();
      required(f.draft.nodes[0]).time = badTime;
      const saved = await json(f.checkpoint);
      saved.result = f.draft;
      saved.result_hash = digest(f.draft);
      await put(f.checkpoint, saved);
      await put(f.raw, f.draft);
      expect(await f.recover()).toBeUndefined();
      expect(f.jobs.pending.some((p) => p.reason === "cumulative_call_budget_exhausted")).toBe(
        true,
      );
      const changed = await f.jobs.job(
        "topic",
        { ...f.payload, task: "changed" },
        UnderstandingReport,
      );
      expect(changed).toBeUndefined();
      expect(required(f.jobs.usedJobs.at(-1)).job).not.toBe(f.id);
      expect(f.m.payloads).toHaveLength(0);
    },
  );
  it.each(["null", "", "/null/"])(
    "fresh time token %j preserves raw and version; replay is zero calls",
    async (token) => {
      const f = await fixture(false);
      const input = await loadInputs(f.batch, f.coverage);
      const selection = selectDomain(
        "collaboration",
        facts(input, []).filter((e) => e.canonical_id === "c1"),
      );
      const payload = { task: "synthetic_report", selection };
      let calls = 0;
      const gateway = mockGateway().gateway;
      gateway.extract = async (args) => {
        calls++;
        const draft = UnderstandingReport.parse(makeReport(selection));
        required(draft.current_understanding).time = token;
        await args.controls?.captureRawOutput?.(JSON.stringify(draft));
        return args.schema.parse(draft);
      };
      const options = {
        out: f.out,
        inputHash: input.input_hash,
        model: "synthetic-model",
        gateway,
        live: true,
        maxCalls: 1,
        fresh: input.fresh,
      };
      const jobs = await jobRunner(options);
      const result = await jobs.job("topic", payload, UnderstandingReport, (r) =>
        validateReport(r, selection),
      );
      expect(required(required(result).current_understanding).time).toBeNull();
      const checkpoint = await json(
        path.join(f.out, "jobs", `${required(jobs.attempts[0]).job}.json`),
      );
      expect((await json(checkpoint.raw_file)).current_understanding.time).toBe(token);
      expect(checkpoint.transform.version).toBe(
        token === "null" ? REPORT_TIME_NORMALIZER : REPORT_NULL_TOKEN_NORMALIZER,
      );
      const replay = await jobRunner(options);
      expect(
        await replay.job("topic", payload, UnderstandingReport, (r) =>
          validateReport(r, selection),
        ),
      ).toEqual(result);
      expect(replay.provenance("topic", payload)).toEqual(jobs.provenance("topic", payload));
      expect(calls).toBe(1);
      expect(replay.callsThisRun).toBe(0);
    },
  );
});
describe("U2 semantic abstention requires a new isolated audit", () => {
  it("resumes rejected same-input audit, removes false actor, preserves history and replays checkpoints", async () => {
    const f = await fixture();
    const m = mockGateway({ projectRepair: true, semanticAbstention: "pass" });
    const first = await runUnderstanding({
      ...f.options,
      live: true,
      gateway: m.gateway,
      maxCalls: 4,
    });
    const firstRepair = await json(path.join(first.directory, "repairs.json"));
    expect(firstRepair.overlays).toEqual([]);
    const oldAudits = m.payloads.filter((p) => p.task === "u2_repair_audit");
    expect(oldAudits).toHaveLength(2);
    const usage = await json(path.join(f.out, "usage.json"));
    const rejectedAttempt = usage.attempts.find(
      (a: Attempt) => a.error === "SEMANTIC_AUDIT_REJECTED",
    );
    const rejectedFile = path.join(f.out, "jobs", `${rejectedAttempt.job}.json`);
    const historical = await readFile(rejectedFile, "utf8");
    expect(JSON.parse(historical).error).toBe("SEMANTIC_AUDIT_REJECTED");
    const resumed = mockGateway({ projectRepair: true, semanticAbstention: "pass" });
    const second = await runUnderstanding({ ...f.options, live: true, gateway: resumed.gateway });
    expect(second.complete).toBe(true);
    const audits = resumed.payloads.filter((p) => p.task === "u2_repair_audit");
    expect(audits).toHaveLength(1);
    const corrected = audits[0] as unknown as {
      candidate: UseRepairs;
      correction: string;
      rejected_proposals: { original: UseRepairs["repairs"][number] }[];
    };
    expect(corrected.correction).toBe("u2-audit-abstention@1");
    expect(
      required(corrected.candidate.repairs.find((r) => r.request_id === "sample:sample-0"))
        .decision,
    ).toBe("unknown");
    expect(
      corrected.rejected_proposals.some((r) =>
        r.original.propositions.some((p) => p.proposition === "本人经常忘记同步配置。"),
      ),
    ).toBe(true);
    expect(await readFile(rejectedFile, "utf8")).toBe(historical);
    expect(resumed.payloads.some((p) => p.task === "u2_scoped_use_and_variant_mapping")).toBe(
      false,
    );
    const replay = await runUnderstanding({ ...f.options, live: true, gateway: resumed.gateway });
    expect(replay.calls_this_run).toBe(0);
    expect(replay.version).toBe(second.version);
  });
  it("a second audit rejection cannot trigger another correction or apply unaudited overlays", async () => {
    const f = await fixture();
    const m = mockGateway({ projectRepair: true, semanticAbstention: "reject" });
    const result = await runUnderstanding({ ...f.options, live: true, gateway: m.gateway });
    expect(result.complete).toBe(false);
    expect(m.payloads.filter((p) => p.task === "u2_repair_audit")).toHaveLength(3);
    expect(m.payloads.filter((p) => p.task === "u2_repair_audit" && p.correction)).toHaveLength(1);
    expect((await json(path.join(result.directory, "repairs.json"))).overlays).toEqual([]);
  });
});

describe("U2 bounded report revision replay", () => {
  it.each(["semantic", "incomplete", "unknown_reference"])(
    "recovers %s feedback with a new audited report and zero-call normal replay",
    async (kind) => {
      const f = await fixture(false);
      const options = { ...f.options, topic: "collaboration" as const };
      const failed = mockGateway({
        alterResult: (p, value) => {
          if (p.task !== "u2_domain_audit") return value;
          const audit = UnderstandingAudit.parse(value);
          if (kind === "incomplete") audit.checks.pop();
          else
            audit.issues = [
              {
                code: "unverified_synthetic_feedback",
                target_id: kind === "unknown_reference" ? "invented-id" : p.assigned[0].id,
                evidence_ids: [],
                severity: "warning",
                rationale: "这是待核查意见，不是新的本人事实。",
              },
            ];
          return audit;
        },
      });
      const first = await runUnderstanding({ ...options, live: true, gateway: failed.gateway });
      const usage = await json(path.join(f.out, "usage.json"));
      const failedAttempt = usage.attempts.find((a: Attempt) => a.status === "error");
      const failedFile = path.join(f.out, "jobs", `${failedAttempt.job}.json`);
      const retainedBytes = await readFile(failedFile, "utf8");
      const blocked = await runUnderstanding({ ...options, live: true, gateway: failed.gateway });
      expect(blocked.calls_this_run).toBe(0);
      const limited = await runUnderstanding({
        ...options,
        live: true,
        retryFailed: true,
        maxCalls: first.calls_total,
        gateway: failed.gateway,
      });
      expect(limited.calls_this_run).toBe(0);
      const fixed = mockGateway();
      const resumed = await runUnderstanding({
        ...options,
        live: true,
        retryFailed: true,
        gateway: fixed.gateway,
      });
      expect(resumed.calls_this_run).toBe(2);
      expect((await json(path.join(resumed.directory, "topics/collaboration.json"))).status).toBe(
        "ready_candidate",
      );
      const revision = fixed.payloads.find(
        (p) => p.task === "u2_domain_understanding",
      ) as unknown as Record<string, unknown>;
      expect(revision.report_revision).toBe("u2-report-review-repair@1");
      expect(revision.review_feedback_unverified).toBeTruthy();
      expect(await readFile(failedFile, "utf8")).toBe(retainedBytes);
      const replay = await runUnderstanding(options);
      expect(replay.calls_this_run).toBe(0);
      expect(replay.version).toBe(resumed.version);
      const liveReplay = await runUnderstanding({ ...options, live: true, gateway: fixed.gateway });
      expect(liveReplay.calls_this_run).toBe(0);
      expect(liveReplay.version).toBe(resumed.version);
    },
  );

  it("stops after a second rejected audit without another candidate or blind audit retry", async () => {
    const f = await fixture(false);
    const options = { ...f.options, topic: "collaboration" as const, live: true };
    const rejected = mockGateway({ issueTask: "u2_domain_audit" });
    await runUnderstanding({ ...options, gateway: rejected.gateway });
    const second = await runUnderstanding({
      ...options,
      gateway: rejected.gateway,
      retryFailed: true,
    });
    expect(second.calls_this_run).toBe(2);
    const fresh = mockGateway();
    const third = await runUnderstanding({ ...options, gateway: fresh.gateway, retryFailed: true });
    expect(third.calls_this_run).toBe(0);
    expect((await json(path.join(third.directory, "topics/collaboration.json"))).status).toBe(
      "partial",
    );
  });
});
