import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digest, sha256 } from "../src/understanding-baseline/io.js";
import { type JobOptions, jobRunner } from "../src/understanding-baseline/jobs.js";
import { POLICY, PROMPTS, UnderstandingAudit } from "../src/understanding-baseline/policy.js";
import type { Fact, Selection } from "../src/understanding-baseline/prepare.js";
import {
  OVERLAY_VERSION,
  type OverlayProof,
  type QualificationProposal,
  RECOVERY_VERSION,
  type RecoveryPlan,
  executeRecovery,
  projectQualification,
  qualificationAnalysis,
  recoveryPreflight,
  recoverySelection,
  replayRecovery,
  verifyOverlay,
  verifyRecoveryProof,
} from "../src/understanding-baseline/recovery.js";

// Every artifact and provider response below is synthetic; no existing run is opened.
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const inputHash = "a".repeat(64);
const model = "synthetic-model";
const domain = "resources_tradeoffs";
const fresh = async () => {};
const fact: Fact = {
  id: "synthetic-original",
  canonical_id: "synthetic-canonical",
  root_ids: ["synthetic-root"],
  source_id: "synthetic-source",
  quote: "我只在预算允许时考虑这项投入。",
  start: 0,
  end: 17,
  content_author: "subject",
  about: "self",
  kind: "self_report",
  stance: "reported",
  use: "personal_expression",
  scope: "合成预算条件",
  session_id: "synthetic-session",
  message_id: "synthetic-message",
  project: "synthetic-project",
  time: "2026-01-01T00:00:00Z",
  group_id: "synthetic-group",
  facet: "choice",
  proposition_type: "choice",
  proposition: "预算允许时考虑投入",
  purpose: "personal_expression",
  original_facet: "choice",
  provenance: "synthetic",
  qualifier: { start: 0, end: 17, text: "仅讨论预算允许时，未报告已投入。", use: "context" },
};
function selection(): Selection {
  return {
    domain,
    evidence: [structuredClone(fact)],
    omitted: [],
    bytes: 100,
    selected_original_atoms: 1,
    canonical_count: 1,
    scope: "合成单条来源",
    repair_inputs_unavailable: [],
  };
}
function proposal(): QualificationProposal {
  return {
    base_fact_id: fact.id,
    base_fact_hash: digest(fact),
    quote: fact.quote,
    proposition: "仅预算允许时才考虑投入，未表示已经投入。",
    stance: "reported",
    use: "personal_expression",
    purpose: "personal_expression",
    rationale: "保留预算允许这一前提，只表达考虑而非已完成投入，不推断额外结果。",
  };
}
function report(s: Selection) {
  const e = s.evidence.at(-1)!;
  return {
    headline: "合成条件性投入",
    current_understanding: {
      key: "current",
      text: "仅在预算允许时考虑投入。",
      scope: "此合成来源",
      evidence_ids: [e.id],
      counterevidence_ids: [],
      context_ids: [],
      time: e.time,
      status: "reported",
    },
    findings: [],
    resources_conditions_costs: [],
    alternatives: [],
    unknowns: [],
    question: null,
    next_step: null,
    nodes: [
      {
        key: "choice",
        type: "choice",
        text: "预算允许时考虑投入",
        scope: "此合成来源",
        evidence_ids: [e.id],
        time: e.time,
        status: "reported",
        stance: "reported",
        actor: "subject",
        about: "subject",
      },
    ],
    links: [],
  };
}
function audit(hash: string, assigned: { id: string }[]) {
  return UnderstandingAudit.parse({
    input_hash: hash,
    checks: assigned.map((a) => ({
      id: a.id,
      checked: true,
      rationale: "逐项核对合成原文及限定，未继承此前结论。",
      same_context: false,
      concrete_incompatibility: false,
    })),
    issues: [],
  });
}
function overlay(): OverlayProof {
  const p = proposal();
  const projected = projectQualification(fact, p);
  const analysis = qualificationAnalysis(selection(), p, fact);
  const assigned = [{ id: projected.id, key: projected.id, category: "proposition" }];
  return {
    version: OVERLAY_VERSION,
    proposal: p,
    original: structuredClone(fact),
    projected,
    analysis_input: analysis,
    assigned,
    audit: audit(digest(analysis), assigned),
  };
}
async function json(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value));
}
async function snapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(root: string) {
    for (const e of await readdir(root, { withFileTypes: true })) {
      const file = path.join(root, e.name);
      if (e.isDirectory()) await visit(file);
      else result[path.relative(dir, file)] = (await readFile(file)).toString("base64");
    }
  }
  await visit(dir);
  return result;
}
async function fixture(withOverlay = false) {
  const out = await realpath(await mkdtemp(path.join(os.tmpdir(), "u2-recovery-synthetic-")));
  dirs.push(out);
  await mkdir(path.join(out, "jobs"));
  await mkdir(path.join(out, "synthetic-baseline"));
  const base = selection();
  const payload = {
    task: "synthetic-failed-topic",
    selection: base,
    prior_candidate: { text: "不得作为证据的旧候选" },
    prior_assigned: [{ id: "history-only" }],
    review_feedback_unverified: "旧反馈不构成证据",
  };
  const fingerprint = digest([inputHash, POLICY, PROMPTS.topic, model, "topic", payload]);
  const id = `topic-${fingerprint.slice(0, 32)}`;
  const inputFile = path.join(out, "jobs", `${id}-input.json`);
  const rawFile = path.join(out, "jobs", `${id}-raw.txt`);
  const jobFile = path.join(out, "jobs", `${id}.json`);
  await json(inputFile, {
    input_hash: inputHash,
    policy: POLICY,
    prompt: PROMPTS.topic,
    model,
    fingerprint,
    payload,
  });
  await writeFile(rawFile, '{"synthetic_failed_output":true}');
  const error = withOverlay ? "STANCE_ESCALATION" : "TIME_SCOPE_MISMATCH";
  const job = {
    id,
    fingerprint,
    status: "failed",
    error,
    input_file: inputFile,
    raw_file: rawFile,
    input_sha256: sha256(await readFile(inputFile)),
    raw_sha256: sha256(await readFile(rawFile)),
  };
  await json(jobFile, job);
  const attempts = [
    {
      id: "synthetic-attempt-1",
      job: id,
      status: "error",
      timeout_ms: 1,
      info: {},
      usage: null,
      error,
    },
  ];
  await json(path.join(out, "usage.json"), { attempts, integrity: digest(attempts) });
  await json(path.join(out, "progress.json"), { max_calls: 8 });
  await json(path.join(out, "run.json"), { input_hash: inputHash, model });
  const baseline = {
    input_hash: inputHash,
    model,
    status: "partial",
    topics: [{ domain, status: "pending", selection: base }],
  };
  await json(path.join(out, "synthetic-baseline", "baseline.json"), baseline);
  await json(path.join(out, "latest-partial.json"), {
    directory: "synthetic-baseline",
    version: digest(baseline),
    input_hash: inputHash,
  });
  const plan: RecoveryPlan = {
    format: RECOVERY_VERSION,
    input_hash: inputHash,
    model,
    domain,
    failed: {
      job: id,
      fingerprint,
      job_sha256: sha256(await readFile(jobFile)),
      input_sha256: job.input_sha256,
      raw_sha256: job.raw_sha256,
      error,
    },
    error_class: withOverlay ? "proposition_stance_mismatch" : "non_time_label",
    correction_instruction:
      "重新核对合成原文限定、报告时间和条件，只修正已诊断错误，不引入新的事实、主体或完成结果。",
    proposals: withOverlay ? [proposal()] : [],
  };
  return { out, base, plan, inputFile, rawFile, jobFile, job };
}
function gateway(mode: "pass" | "missing-check" | "unknown-history" = "pass", modelName = model) {
  const payloads: Record<string, any>[] = [];
  const fake: NonNullable<JobOptions["gateway"]> = {
    describe: (route) => ({ route, model: modelName }),
    extract: async (args) => {
      const p = JSON.parse(args.text);
      payloads.push(p);
      const value = p.assigned ? audit(p.analysis_input_hash, p.assigned) : report(p.selection);
      if ("checks" in value && p.task === "u2_domain_audit" && mode === "missing-check")
        value.checks.pop();
      if ("issues" in value && p.task === "u2_domain_audit" && mode === "unknown-history")
        value.issues.push({
          code: "synthetic",
          target_id: null,
          evidence_ids: ["history-only"],
          severity: "blocking",
          rationale: "旧候选不能充当原文证据。",
        });
      await args.controls?.captureRawOutput?.(JSON.stringify(value));
      return args.schema.parse(value);
    },
  };
  return { fake, payloads };
}
function execute(
  f: Awaited<ReturnType<typeof fixture>>,
  g: ReturnType<typeof gateway>,
  budget = 8,
) {
  return executeRecovery({
    out: f.out,
    plan: f.plan,
    requestedBudget: budget,
    live: true,
    gateway: g.fake,
    baseSelection: f.base,
    fresh,
  });
}

describe("reason-scoped U2 recovery on synthetic immutable inputs", () => {
  it("preflight binds run/model/domain and rejects unknown plans without touching bytes", async () => {
    const f = await fixture();
    const before = await snapshot(f.out);
    for (const change of [
      { input_hash: "b".repeat(64) },
      { model: "other" },
      { domain: "collaboration" },
      { unexpected: true },
    ])
      await expect(
        recoveryPreflight(f.out, { ...f.plan, ...change }, [domain], 8),
      ).rejects.toThrow();
    await expect(recoveryPreflight(f.out, f.plan, ["unknown-topic"], 8)).rejects.toThrow(
      "UNKNOWN_TOPIC",
    );
    expect(await snapshot(f.out)).toEqual(before);
  });
  it("executes migrated recovery jobs under the continuation model while preserving lineage", async () => {
    const f = await fixture();
    const targetModel = "synthetic-target-model";
    const migration = {
      format: "u2-provider-migration@1",
      input_hash: inputHash,
      source_model: model,
      target_model: targetModel,
      policy: POLICY,
      prompt_hash: digest(PROMPTS),
      preserve_completed_lineage: true,
      continuation_only: true,
    };
    const migrationHash = digest(migration);
    await json(path.join(f.out, "provider-migration.json"), {
      ...migration,
      migration_hash: migrationHash,
    });
    await json(path.join(f.out, "run.json"), {
      input_hash: inputHash,
      model,
      continuation_model: targetModel,
      provider_migration_hash: migrationHash,
      policy: POLICY,
      prompt_hash: digest(PROMPTS),
    });
    const g = gateway("pass", targetModel);
    const result = await executeRecovery({
      out: f.out,
      plan: f.plan,
      requestedBudget: 8,
      live: true,
      gateway: g.fake,
      baseSelection: f.base,
      fresh,
    });
    expect(result.status).toBe("completed");
    expect(result.calls_this_run).toBe(2);
    expect(result.proof?.runtime_model).toBe(targetModel);
    const inputFiles = (await readdir(path.join(f.out, "jobs"))).filter((x) =>
      x.endsWith("-input.json"),
    );
    const migratedInputs = [];
    for (const file of inputFiles) {
      const input = JSON.parse(await readFile(path.join(f.out, "jobs", file), "utf8"));
      if (input.model === targetModel) migratedInputs.push(input);
    }
    expect(migratedInputs).toHaveLength(2);
    expect(migratedInputs.every((x) => x.lineage_model === model)).toBe(true);
  });
  it("requires an actual failed job and exact failed-job bytes", async () => {
    const f = await fixture();
    await json(f.jobFile, { ...f.job, status: "completed" });
    const before = await snapshot(f.out);
    await expect(recoveryPreflight(f.out, f.plan, [domain], 8)).rejects.toThrow(
      "RECOVERY_REQUIRES_FAILED_JOB",
    );
    expect(await snapshot(f.out)).toEqual(before);
    await json(f.jobFile, { ...f.job, error: "OTHER" });
    const changed = await snapshot(f.out);
    await expect(recoveryPreflight(f.out, f.plan, [domain], 8)).rejects.toThrow(
      "RECOVERY_FAILURE_CHANGED",
    );
    expect(await snapshot(f.out)).toEqual(changed);
  });
  it("rejects stale input/raw identities and stale baseline with zero preflight writes", async () => {
    for (const artifact of ["inputFile", "rawFile"] as const) {
      const f = await fixture();
      await writeFile(f[artifact], "changed");
      const before = await snapshot(f.out);
      await expect(recoveryPreflight(f.out, f.plan, [domain], 8)).rejects.toThrow(
        "RECOVERY_FAILURE_ARTIFACT_CHANGED",
      );
      expect(await snapshot(f.out)).toEqual(before);
    }
    const f = await fixture();
    await json(path.join(f.out, "synthetic-baseline", "baseline.json"), {
      input_hash: inputHash,
      model,
      topics: [],
    });
    const before = await snapshot(f.out);
    await expect(recoveryPreflight(f.out, f.plan, [domain], 8)).rejects.toThrow(
      "RECOVERY_BASELINE_CHANGED",
    );
    expect(await snapshot(f.out)).toEqual(before);
  });
  it("counts overlay audit, generation and final audit before accepting cumulative budget", async () => {
    const f = await fixture(true);
    const g = gateway();
    const before = await snapshot(f.out);
    const pre = await recoveryPreflight(f.out, f.plan, [domain], 3);
    await expect(recoveryPreflight(f.out, f.plan, [domain], 72)).rejects.toThrow(
      "MAX_CALLS_0_TO_71_REQUIRED",
    );
    await expect(jobRunner({ out: f.out, inputHash, model, maxCalls: 72, fresh })).rejects.toThrow(
      "MAX_CALLS_0_TO_71_REQUIRED",
    );
    expect(pre.required_calls).toBe(3);
    expect(pre.remaining_requested_budget).toBe(2);
    expect(pre.budget_blocked).toBe(true);
    expect((await execute(f, g, 3)).status).toBe("not_executed");
    expect(g.payloads).toHaveLength(0);
    expect(await snapshot(f.out)).toEqual(before);
    expect((await recoveryPreflight(f.out, f.plan, [domain], 4)).executable).toBe(true);
    expect(await snapshot(f.out)).toEqual(before);
  });
  it("preserves source identity, author, time and context qualifier in overlays", () => {
    const p = overlay();
    const projected = verifyOverlay(p, new Map([[fact.id, fact]]), domain);
    for (const field of [
      "source_id",
      "canonical_id",
      "root_ids",
      "content_author",
      "about",
      "time",
      "qualifier",
      "start",
      "end",
    ] as const)
      expect(projected[field]).toEqual(fact[field]);
    expect(recoverySelection(selection(), [p]).evidence).toEqual([fact, projected]);
    expect(() => recoverySelection(selection(), [p, p])).toThrow("DUPLICATE_RECOVERY_PROPOSAL");
    expect(() =>
      projectQualification(fact, { ...proposal(), actor: "third_party" } as QualificationProposal),
    ).toThrow();
  });
  it("requires complete same-input overlay audit and rejects altered scope or warning issues", () => {
    const p = overlay();
    expect(() =>
      verifyOverlay(
        { ...p, audit: { ...p.audit, checks: [] } },
        new Map([[fact.id, fact]]),
        domain,
      ),
    ).toThrow("INCOMPLETE_SAME_INPUT_AUDIT");
    expect(() =>
      verifyOverlay(
        { ...p, projected: { ...p.projected, time: null } },
        new Map([[fact.id, fact]]),
        domain,
      ),
    ).toThrow("OVERLAY_RECONSTRUCTION_MISMATCH");
    expect(() =>
      verifyOverlay(
        {
          ...p,
          audit: {
            ...p.audit,
            issues: [
              {
                code: "unsupported",
                target_id: p.projected.id,
                evidence_ids: [fact.id],
                severity: "warning",
                rationale: "限定不足，不允许通过。",
              },
            ],
          },
        },
        new Map([[fact.id, fact]]),
        domain,
      ),
    ).toThrow("SEMANTIC_AUDIT_REJECTED");
  });
  it("replays completed recovery through cached jobs without another live call", async () => {
    const f = await fixture(true);
    const g = gateway();
    const result = await execute(f, g);
    expect(result.status).toBe("completed");
    expect(result.calls_this_run).toBe(3);
    const jobs = await jobRunner({
      out: f.out,
      inputHash,
      model,
      live: false,
      gateway: g.fake,
      maxCalls: 1,
      fresh,
    });
    const replay = await replayRecovery(f.out, inputHash, model, f.base, jobs);
    expect(replay?.candidate).toEqual(result.proof?.candidate);
    expect(jobs.callsThisRun).toBe(0);
    expect(JSON.parse(await readFile(path.join(f.out, "progress.json"), "utf8")).max_calls).toBe(8);
    expect(g.payloads).toHaveLength(3);
    const originalRaw = await readFile(f.rawFile);
    await writeFile(f.rawFile, "tampered synthetic raw");
    await expect(replayRecovery(f.out, inputHash, model, f.base, jobs)).rejects.toThrow(
      "RECOVERY_FAILURE_ARTIFACT_CHANGED",
    );
    await rm(f.rawFile);
    await expect(replayRecovery(f.out, inputHash, model, f.base, jobs)).rejects.toThrow();
    await writeFile(f.rawFile, originalRaw);
    expect(g.payloads).toHaveLength(3);
    // Simulate interruption after overlay + generation: remove only synthetic final audit.
    const checkpointFile = path.join(f.out, "recovery", `${digest(f.plan)}.json`);
    const checkpoint = JSON.parse(await readFile(checkpointFile, "utf8"));
    checkpoint.status = "pending";
    delete checkpoint.proof;
    await json(checkpointFile, checkpoint);
    const finalPayload = result.proof!.audit_payload;
    const finalFingerprint = digest([
      inputHash,
      POLICY,
      PROMPTS.audit,
      model,
      "audit",
      finalPayload,
    ]);
    const finalJob = `audit-${finalFingerprint.slice(0, 32)}`;
    await rm(path.join(f.out, "jobs", `${finalJob}.json`));
    const usage = JSON.parse(await readFile(path.join(f.out, "usage.json"), "utf8"));
    usage.attempts = usage.attempts.filter((a: { job: string }) => a.job !== finalJob);
    usage.integrity = digest(usage.attempts);
    await json(path.join(f.out, "usage.json"), usage);
    const before = await snapshot(f.out);
    const interrupted = await recoveryPreflight(f.out, f.plan, [domain], 4);
    expect(interrupted.remaining_stages).toEqual(["topic_audit"]);
    expect(interrupted.required_calls).toBe(1);
    expect(interrupted.executable).toBe(true);
    expect(await snapshot(f.out)).toEqual(before);
    expect((await execute(f, g, 4)).calls_this_run).toBe(1);
    expect(g.payloads).toHaveLength(4);
  });
  it("repeat failed recovery makes no calls and a new instruction requires the new diagnosed failure", async () => {
    const f = await fixture();
    const g = gateway("missing-check");
    expect((await execute(f, g)).status).toBe("failed");
    expect(g.payloads).toHaveLength(2);
    const before = await snapshot(f.out);
    expect((await execute(f, g)).calls_this_run).toBe(0);
    expect(await snapshot(f.out)).toEqual(before);
    expect(g.payloads).toHaveLength(2);
    await expect(
      recoveryPreflight(
        f.out,
        {
          ...f.plan,
          correction_instruction: `${f.plan.correction_instruction}再次核对。`,
          parent_plan_hash: digest(f.plan),
        },
        [domain],
        8,
      ),
    ).rejects.toThrow("RECOVERY_NEW_DIAGNOSED_FAILURE_REQUIRED");
    expect(await snapshot(f.out)).toEqual(before);
    const checkpoint = JSON.parse(
      await readFile(path.join(f.out, "recovery", `${digest(f.plan)}.json`), "utf8"),
    );
    const failedFile = path.join(f.out, "jobs", `${checkpoint.failed_job}.json`);
    const failed = JSON.parse(await readFile(failedFile, "utf8"));
    const diagnosed: RecoveryPlan = {
      ...f.plan,
      parent_plan_hash: digest(f.plan),
      error_class: "revision_history_scope",
      correction_instruction: `${f.plan.correction_instruction}重新审核全部当前对象。`,
      failed: {
        job: failed.id,
        fingerprint: failed.fingerprint,
        job_sha256: sha256(await readFile(failedFile)),
        input_sha256: sha256(await readFile(failed.input_file)),
        raw_sha256: sha256(await readFile(failed.raw_file)),
        error: failed.error,
      },
    };
    const next = await recoveryPreflight(f.out, diagnosed, [domain], 8);
    expect(next.executable).toBe(true);
    expect(next.required_calls).toBe(2);
    expect(await snapshot(f.out)).toEqual(before);
    // Provider failure is durable, but the process crashed before final checkpoint write.
    const checkpointFile = path.join(f.out, "recovery", `${digest(f.plan)}.json`);
    checkpoint.status = "pending";
    delete checkpoint.failed_job;
    delete checkpoint.proof;
    await json(checkpointFile, checkpoint);
    const interruptedBefore = await snapshot(f.out);
    const halted = await recoveryPreflight(f.out, f.plan, [domain], 8);
    expect(halted.required_calls).toBe(0);
    expect(halted.remaining_stages).toEqual([]);
    expect(halted.halted_failure_job).toBe(failed.id);
    expect(await snapshot(f.out)).toEqual(interruptedBefore);
    const finalized = await execute(f, g);
    expect(finalized.status).toBe("failed");
    expect(finalized.calls_this_run).toBe(0);
    expect(g.payloads).toHaveLength(2);
    const restored = JSON.parse(await readFile(checkpointFile, "utf8"));
    expect(restored.status).toBe("failed");
    expect(restored.failed_job).toBe(failed.id);
    expect((await recoveryPreflight(f.out, diagnosed, [domain], 8)).executable).toBe(true);
  });
  it("independent final audit covers every current assigned object and receives no inherited candidate", async () => {
    const f = await fixture();
    const g = gateway();
    const result = await execute(f, g);
    expect(result.status).toBe("completed");
    const generated = g.payloads[0]!;
    const reviewed = g.payloads[1]!;
    expect(generated).not.toHaveProperty("prior_candidate");
    expect(generated).not.toHaveProperty("prior_assigned");
    expect(generated).not.toHaveProperty("review_feedback_unverified");
    expect(reviewed.analysis_input_hash).toBe(digest(generated));
    expect(reviewed.assigned).toHaveLength(2);
    expect(result.proof?.audit.checks.map((c) => c.id)).toEqual(
      reviewed.assigned.map((a: { id: string }) => a.id),
    );
    expect(generated.selection.evidence.map((e: Fact) => e.id)).toEqual([fact.id]);
    expect(reviewed.audited_assertion_scope).toContain("not evidence");
  });
  it("shared reader verification accepts exact proof and rejects changed sources or missing/forged overlay audit", async () => {
    const f = await fixture(true);
    const g = gateway();
    const result = await execute(f, g);
    const proof = result.proof!;
    const current = new Map(f.base.evidence.map((e) => [e.id, e]));
    const readAudit = async (candidate: unknown, checked: unknown) => {
      const payload = g.payloads.find(
        (p) => p.assigned && digest(p.candidate) === digest(candidate),
      )!;
      if (
        !payload ||
        digest(checked) !==
          digest(
            proof.overlays[0]!.projected.id === (candidate as { id?: string }).id
              ? proof.overlays[0]!.audit
              : proof.audit,
          )
      )
        throw new Error("SYNTHETIC_AUDIT_MISSING");
      return { payload };
    };
    expect(
      (await verifyRecoveryProof(proof, current, inputHash, model, domain, readAudit)).evidence,
    ).toHaveLength(2);
    await expect(
      verifyRecoveryProof(
        proof,
        new Map([[fact.id, { ...fact, time: null }]]),
        inputHash,
        model,
        domain,
        readAudit,
      ),
    ).rejects.toThrow("RECOVERY_SOURCE_CHANGED");
    await expect(
      verifyRecoveryProof(proof, current, inputHash, model, domain, async () => {
        throw new Error("SYNTHETIC_AUDIT_MISSING");
      }),
    ).rejects.toThrow("SYNTHETIC_AUDIT_MISSING");
    await expect(
      verifyRecoveryProof(proof, current, inputHash, model, domain, async () => ({
        payload: { task: "forged-approved-overlay" },
      })),
    ).rejects.toThrow("RECOVERY_OVERLAY_AUDIT_BINDING_MISMATCH");
    const forged = structuredClone(proof);
    forged.overlays[0]!.audit.checks = [];
    await expect(
      verifyRecoveryProof(forged, current, inputHash, model, domain, readAudit),
    ).rejects.toThrow("INCOMPLETE_SAME_INPUT_AUDIT");
  });
  it("executes one explicitly linked overlay correction and rejects a third recovery plan", async () => {
    const f = await fixture(true);
    const first = gateway("missing-check");
    expect((await execute(f, first)).status).toBe("failed");
    expect(first.payloads).toHaveLength(3);
    const parentHash = digest(f.plan);
    const checkpoint = JSON.parse(
      await readFile(path.join(f.out, "recovery", `${parentHash}.json`), "utf8"),
    );
    const failedFile = path.join(f.out, "jobs", `${checkpoint.failed_job}.json`);
    const failed = JSON.parse(await readFile(failedFile, "utf8"));
    const second: RecoveryPlan = {
      ...f.plan,
      parent_plan_hash: parentHash,
      correction_instruction: `${f.plan.correction_instruction}针对新失败逐项审核完整对象。`,
      proposals: [{ ...proposal(), rationale: `${proposal().rationale}本次独立复核明确条件。` }],
      failed: {
        job: failed.id,
        fingerprint: failed.fingerprint,
        job_sha256: sha256(await readFile(failedFile)),
        input_sha256: sha256(await readFile(failed.input_file)),
        raw_sha256: sha256(await readFile(failed.raw_file)),
        error: failed.error,
      },
    };
    const next = gateway();
    f.plan = second;
    const recovered = await execute(f, next);
    expect(recovered.status).toBe("completed");
    expect(recovered.calls_this_run).toBe(3);
    expect(next.payloads).toHaveLength(3);
    expect(recovered.proof!.base_selection).toEqual(f.base);
    expect(recovered.proof!.overlays).toHaveLength(1);
    const before = await snapshot(f.out);
    await expect(
      recoveryPreflight(
        f.out,
        {
          ...second,
          parent_plan_hash: digest(second),
          correction_instruction: `${second.correction_instruction}第三次修改。`,
        },
        [domain],
        12,
      ),
    ).rejects.toThrow("RECOVERY_CHAIN_EXHAUSTED");
    expect(await snapshot(f.out)).toEqual(before);
  });
  it("rejects audit use of recovery history as evidence instead of inheriting approval", async () => {
    const f = await fixture();
    const g = gateway("unknown-history");
    const result = await execute(f, g);
    expect(result.status).toBe("failed");
    expect(result.proof).toBeNull();
    const auditJob = (await readdir(path.join(f.out, "jobs"))).find((name) =>
      /^audit-[a-f0-9]{32}\.json$/.test(name),
    )!;
    expect(JSON.parse(await readFile(path.join(f.out, "jobs", auditJob), "utf8")).error).toBe(
      "UNKNOWN_AUDIT_REFERENCE",
    );
  });
});
