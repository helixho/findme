import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OldClaimReview,
  UNDERSTANDING_VERSION,
  UnderstandingAudit,
  UnderstandingReport,
} from "@findme/core";
import { afterEach, describe, expect, it } from "vitest";
import { boundedSelection, feedbackFact } from "../src/understanding-app/dependencies.js";
import { createPrivateUnderstandingHost } from "../src/understanding-app/host.js";
import { UnderstandingQualification } from "../src/understanding-app/qualification-schema.js";
import {
  type QualificationCheckpoint,
  type QualificationInput,
  qualificationFacts,
  verifyQualification,
} from "../src/understanding-app/qualification.js";
import { latestPublication, readBaseline } from "../src/understanding-app/read.js";
import { PrivateUnderstandingRepository } from "../src/understanding-app/repository.js";
import { understandingRoutes } from "../src/understanding-app/routes.js";
import { readState, writeState } from "../src/understanding-app/state.js";
import { loadInputs } from "../src/understanding-baseline/input.js";
import { digest, sha256 } from "../src/understanding-baseline/io.js";
import { POLICY, PROMPTS, assignReport } from "../src/understanding-baseline/policy.js";
import {
  DOMAINS,
  type Selection,
  facts,
  selectDomain,
} from "../src/understanding-baseline/prepare.js";
import { writeUnderstandingSources } from "./helpers/understanding-source-fixture.js";
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const temporary: string[] = [];
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const put = async (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2));
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("REQUIRED");
  return value;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function sources(withRepairs = false) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "u2-synthetic-")));
  temporary.push(base);
  return writeUnderstandingSources(base, withRepairs, repoRoot);
}

function report(selection: Selection, text = "本人在局部情境中偏好明确的协作条件。") {
  const e = required(
    selection.evidence.find(
      (e) => e.use === "personal_expression" && e.source_id.startsWith("u3-feedback:"),
    ) ?? selection.evidence.find((e) => e.use === "personal_expression"),
  );
  return UnderstandingReport.parse({
    headline: "有范围的协作理解",
    current_understanding: {
      key: "current",
      text,
      scope: e.scope,
      time: e.time,
      status: "reported",
      evidence_ids: [e.id],
      counterevidence_ids: [],
      context_ids: [],
    },
    findings: [],
    resources_conditions_costs: [],
    alternatives: ["也可能仅适用于本次协作。"],
    unknowns: ["独立经历尚未核实。"],
    question: null,
    next_step: null,
    nodes: [],
    links: [],
  });
}
function audit(
  payload: { analysis_input_hash: string; assigned: { id: string }[] },
  reject = false,
) {
  return UnderstandingAudit.parse({
    input_hash: payload.analysis_input_hash,
    checks: payload.assigned.map((a) => ({
      id: a.id,
      checked: true,
      rationale: "合成审核：原文与范围相符。",
      same_context: false,
      concrete_incompatibility: false,
    })),
    issues: reject
      ? [
          {
            code: "synthetic_rejection",
            target_id: null,
            evidence_ids: [],
            severity: "blocking",
            rationale: "合成拒绝：未保留限定条件。",
          },
        ]
      : [],
  });
}
async function fixture(config: { complete?: boolean; overall?: boolean } = {}) {
  const f = await sources();
  const input = await loadInputs(f.batch, f.coverage);
  const out = f.out;
  await mkdir(path.join(out, "jobs"), { recursive: true });
  const model = "synthetic-model";
  const jobs: { stage: string; job: string; status: string }[] = [];
  const all = facts(input, []);
  async function savedAudit(
    candidate: unknown,
    analysis: unknown,
    assigned: { id: string; key: string; category: string }[],
  ) {
    const payload = {
      analysis_input: analysis,
      analysis_input_hash: digest(analysis),
      candidate,
      assigned,
    };
    const a = audit(payload);
    const fingerprint = digest([input.input_hash, POLICY, PROMPTS.audit, model, "audit", payload]);
    const id = `audit-${fingerprint.slice(0, 32)}`;
    const inputFile = path.join(out, "jobs", `${id}-input.json`);
    const rawFile = path.join(out, "jobs", `${id}-raw.json`);
    await put(inputFile, {
      fingerprint,
      input_hash: input.input_hash,
      policy: POLICY,
      prompt: PROMPTS.audit,
      model,
      payload,
    });
    // Provider JSON key order is arbitrary; accepted schema content must still match.
    await put(rawFile, { issues: a.issues, checks: a.checks, input_hash: a.input_hash });
    await put(path.join(out, "jobs", `${id}.json`), {
      id,
      fingerprint,
      status: "completed",
      result: a,
      result_hash: digest(a),
      raw_file: rawFile,
      raw_sha256: sha256(await readFile(rawFile)),
      input_file: inputFile,
      input_sha256: sha256(await readFile(inputFile)),
    });
    jobs.push({ stage: "audit", job: id, status: "completed" });
    return a;
  }
  const topics = [];
  for (const domain of Object.keys(DOMAINS) as (keyof typeof DOMAINS)[]) {
    const selection = selectDomain(
      domain,
      config.complete && !["collaboration", "judgment_learning", "unresolved"].includes(domain)
        ? []
        : all.filter((e) => e.canonical_id === (domain === "judgment_learning" ? "c2" : "c1")),
    );
    const ready = domain === "collaboration" || domain === "judgment_learning";
    const candidate = ready ? report(selection) : null;
    const assigned = candidate
      ? assignReport(candidate, digest({ task: "synthetic-topic", selection }))
      : [];
    const a = candidate
      ? await savedAudit(candidate, { task: "synthetic-topic", selection }, assigned)
      : null;
    const status = ready
      ? "ready_candidate"
      : domain === "unresolved"
        ? "context_required"
        : config.complete
          ? "no_evidence"
          : "partial";
    const version = digest([
      input.input_hash,
      POLICY,
      model,
      domain,
      selection,
      candidate,
      a,
      status,
    ]);
    topics.push({ domain, status, version, selection, candidate, assigned, audit: a });
  }
  const oldSelection = selectDomain("old_claims", all);
  const old = OldClaimReview.parse({
    dispositions: input.old.map((o) => ({
      old_id: o.id,
      disposition: "needs_review",
      text: null,
      scope: o.scope,
      new_kind: null,
      evidence_ids: [],
      reason: "合成旧认识待本人复核。",
      shared_context: null,
      incompatibility: null,
    })),
  });
  const oldAudit = await savedAudit(
    old,
    { selection: oldSelection },
    input.old.map((o) => ({ id: o.id, key: o.id, category: "old_disposition" })),
  );
  const overallSelection = selectDomain(
    "overall",
    all.filter((e) => ["c1", "c2"].includes(e.canonical_id)),
  );
  const overall = config.overall ? report(overallSelection) : null;
  const overallAssigned = overall
    ? assignReport(overall, digest({ selection: overallSelection }))
    : [];
  const overallAudit = overall
    ? await savedAudit(overall, { selection: overallSelection }, overallAssigned)
    : null;
  const baseline = {
    format: UNDERSTANDING_VERSION,
    policy: POLICY,
    prompt_hash: digest(PROMPTS),
    model,
    input_hash: input.input_hash,
    source_version_directory: input.source_version_directory,
    status: "partial",
    overall,
    overall_audit: overallAudit,
    overall_assigned: overallAssigned,
    overall_selection: overallSelection,
    topics,
    old_claim_review: old,
    jobs,
  };
  const version = digest(baseline);
  const directory = path.join(out, "versions", version);
  await mkdir(path.join(directory, "topics"), { recursive: true });
  const files: Record<string, unknown> = {
    "input-hashes.json": input.artifacts,
    "plan.json": { topic: null },
    "source-refs.json": all,
    "repairs.json": { batches: [], overlays: [] },
    "context.json": [],
    "baseline.json": baseline,
    "old-claim-review.json": {
      candidate: old,
      audit: oldAudit,
      selection: oldSelection,
      status: "ready_candidate",
    },
    "unresolved.json": [],
    ...Object.fromEntries(topics.map((t) => [`topics/${t.domain}.json`, t])),
  };
  for (const [name, value] of Object.entries(files)) await put(path.join(directory, name), value);
  await writeFile(path.join(directory, "report.md"), "Synthetic report");
  const hashes = Object.fromEntries(
    await Promise.all(
      [...Object.keys(files), "report.md"].map(async (name) => [
        name,
        sha256(await readFile(path.join(directory, name))),
      ]),
    ),
  );
  await put(path.join(directory, "manifest.json"), {
    format: UNDERSTANDING_VERSION,
    version,
    status: "partial",
    input_hash: input.input_hash,
    files: hashes,
  });
  await put(path.join(out, "run.json"), {
    format: UNDERSTANDING_VERSION,
    batch: f.batch,
    coverage: f.coverage,
    input_hash: input.input_hash,
    model,
    policy: POLICY,
    prompt_hash: digest(PROMPTS),
  });
  await put(path.join(out, "latest-partial.json"), {
    version,
    directory,
    input_hash: input.input_hash,
  });
  const options = {
    repoRoot,
    batch: f.batch,
    coverage: f.coverage,
    baselineDir: out,
    stateDir: path.join(f.base, "u3-feedback"),
  };
  const repository = new PrivateUnderstandingRepository(options);
  const view = await repository.read();
  const t = required(view.topics.find((t) => t.domain === "collaboration"));
  const body = {
    baseline_version: view.baseline_version,
    input_hash: view.input_hash,
    domain: t.domain,
    report_version: t.version,
    finding_key: "current",
    type: "supplement" as const,
    note: "我现在会先确认协作范围，再决定是否参与。",
  };
  return { ...f, options, repository, directory, body, view, t };
}
function qualification(p: QualificationInput) {
  return UnderstandingQualification.parse({
    notes: p.notes.map((n) => ({
      note_id: n.id,
      reason: "合成本人表达，限定于本次协作。",
      propositions: [
        {
          quote: n.note,
          start: 0,
          end: n.note.length,
          author: "subject",
          about: "self",
          kind: "choice",
          stance: "reported",
          type: "choice",
          purpose: "personal_expression",
          proposition: n.note,
          scope: "本次协作中的选择",
          reason: "合成明确自述。",
        },
      ],
    })),
  });
}
function mockGateway(
  mode: "accept" | "reject" = "accept",
  afterAudit?: () => Promise<void>,
  qualify = qualification,
) {
  let calls = 0;
  const gateway: NonNullable<
    ConstructorParameters<typeof PrivateUnderstandingRepository>[0]["gateway"]
  > = {
    async extract(args) {
      calls++;
      const p = JSON.parse(args.text);
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
      let value;
      if (p.task === "u3_note_qualification") {
        value = qualify(p);
      } else if (p.task === "u3_independent_qualification_audit") {
        value = audit(p);
      } else if (p.task === "u3_independent_feedback_audit") {
        if (afterAudit) await afterAudit();
        value = audit(p, mode === "reject");
      } else {
        value = report(p.selection, "补充表明，当前协作判断先明确参与范围。");
        required(value.current_understanding).context_ids = p.selection.evidence
          .filter(
            (e: { source_id: string; use: string }) =>
              e.source_id.startsWith("u3-feedback:") && e.use === "context",
          )
          .map((e: { id: string }) => e.id);
        required(value.current_understanding).time = null;
      }
      await args.controls?.captureRawOutput?.(JSON.stringify(value));
      await args.controls?.observer?.afterAttempt({
        ...info,
        status: "ok",
        errorKind: null,
        latencyMs: 1,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cacheInputTokens: null,
          cacheOutputTokens: null,
        },
      });
      return args.schema.parse(value);
    },
  };
  return { gateway, calls: () => calls };
}
describe("U3 private understanding (synthetic only, no U2 runner)", () => {
  it("reads partial without promoting unfinished topics or synthesizing overall; DTO excludes private internals", async () => {
    const f = await fixture();
    expect(f.view.overall).toMatchObject({ status: "unavailable", report: null });
    expect(f.view.topics.find((t) => t.domain === "role_direction")).toMatchObject({
      status: "partial",
      report: null,
    });
    expect(f.view.old_dispositions.report?.dispositions).toHaveLength(5);
    expect(f.view.frameworks.human_3).toBe("not_run");
    const serialized = JSON.stringify(f.view);
    expect(serialized).not.toContain(f.base);
    expect(serialized).not.toContain("jobs");
    expect(serialized).not.toContain("overall_draft");
  });
  it("exact evidence is scoped to a requested accepted report version, not arbitrary source IDs", async () => {
    const f = await fixture();
    const id = required(f.t.report?.current_understanding?.evidence_ids[0]);
    const e = await f.repository.evidence(f.t.domain, f.t.version, id);
    expect(e.quote).toContain("协作条件");
    expect(await f.repository.evidences(f.t.domain, f.t.version, [id])).toEqual([e]);
    await expect(f.repository.evidences(f.t.domain, f.t.version, [id, "e2"])).rejects.toThrow(
      "EVIDENCE_OUTSIDE_REPORT",
    );
    await expect(f.repository.evidences(f.t.domain, f.t.version, [id, id])).rejects.toThrow(
      "EVIDENCE_QUERY_INVALID",
    );
    const batchApp = understandingRoutes(f.repository, "synthetic-batch-token");
    const query = new URLSearchParams({ domain: f.t.domain, version: f.t.version });
    query.append("id", id);
    const batchResponse = await batchApp.request(`/evidence/batch?${query}`, {
      headers: { authorization: "Bearer synthetic-batch-token" },
    });
    expect(batchResponse.status).toBe(200);
    expect(await batchResponse.json()).toEqual([e]);
    expect(Object.keys(e).sort()).toEqual(
      [
        "id",
        "quote",
        "qualifier",
        "author",
        "about",
        "stance",
        "report_time",
        "scope",
        "source_id",
        "source_ids",
        "session_id",
        "message_id",
        "start",
        "end",
        "offset_unit",
      ].sort(),
    );
    await expect(f.repository.evidence(f.t.domain, f.t.version, "e2")).rejects.toThrow(
      "EVIDENCE_OUTSIDE_REPORT",
    );
    await expect(f.repository.evidence(f.t.domain, "stale", id)).rejects.toThrow(
      "REPORT_VERSION_NOT_FOUND",
    );
  });
  it("rejects artifact tamper and corrupt current pointers without fallback", async () => {
    const f = await fixture();
    await writeFile(path.join(f.directory, "report.md"), "tamper");
    await expect(f.repository.read()).rejects.toThrow("BASELINE_ARTIFACT_INTEGRITY");
    await writeFile(path.join(f.options.baselineDir, "latest-ready.json"), "{");
    await expect(f.repository.read()).rejects.toThrow();
  });
  it("rejects tampered audit job originals and stale fingerprints before exposure", async () => {
    const f = await fixture();
    const b = await json(path.join(f.directory, "baseline.json"));
    const jobFile = path.join(f.options.baselineDir, "jobs", `${b.jobs[0].job}.json`);
    const job = await json(jobFile);
    await writeFile(job.raw_file, "{}");
    await expect(f.repository.read()).rejects.toThrow("AUDIT_ARTIFACT_INTEGRITY");
    const g = await fixture();
    const pointerFile = path.join(g.options.baselineDir, "latest-partial.json");
    const p = await json(pointerFile);
    p.input_hash = "a".repeat(64);
    await put(pointerFile, p);
    await expect(g.repository.read()).rejects.toThrow("STALE_BASELINE_POINTER");
  });
  it("rejects source changes and topic-only snapshots explicitly", async () => {
    const f = await fixture();
    await put(path.join(f.batch, "state.json"), {});
    await expect(f.repository.read()).rejects.toThrow();
    const g = await fixture();
    const planFile = path.join(g.directory, "plan.json");
    await put(planFile, { topic: "collaboration" });
    const manifest = await json(path.join(g.directory, "manifest.json"));
    manifest.files["plan.json"] = sha256(await readFile(planFile));
    await put(path.join(g.directory, "manifest.json"), manifest);
    await expect(g.repository.read()).rejects.toThrow("TOPIC_ONLY_IS_NOT_BASELINE");
  });
  it("saves original first, returns idempotent receipts, rejects conflicts/stale; pending is not acceptance", async () => {
    const f = await fixture();
    const r = await f.repository.save(f.body, "synthetic-key-1");
    expect(r.status).toBe("pending_analysis");
    expect(await f.repository.save(f.body, "synthetic-key-1")).toEqual(r);
    await expect(
      f.repository.save({ ...f.body, note: "changed" }, "synthetic-key-1"),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(
      f.repository.save({ ...f.body, report_version: "stale" }, "synthetic-key-2"),
    ).rejects.toThrow("STALE_REPORT_VERSION");
    const reload = await new PrivateUnderstandingRepository(f.options).read();
    expect(reload.feedback[0]?.input.note).toBe(f.body.note);
    expect(reload.topics.find((t) => t.domain === f.t.domain)?.status).toBe("needs_review");
    expect(reload.overall.status).toBe("needs_review");
    expect(reload.topics.find((t) => t.domain === "judgment_learning")?.version).toBe(
      f.view.topics.find((t) => t.domain === "judgment_learning")?.version,
    );
    await expect(f.repository.process(r.id)).rejects.toThrow("FEEDBACK_PROCESSING_DISABLED");
  });
  it("helpful feedback is attitude only; routes authenticate and save without operation polling or model calls", async () => {
    const f = await fixture();
    const m = mockGateway();
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 4,
    });
    const app = understandingRoutes(repo, "synthetic-owner-token");
    expect((await app.request("/")).status).toBe(401);
    const response = await app.request("/feedback", {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-owner-token",
        "Content-Type": "application/json",
        "Idempotency-Key": "synthetic-helpful",
      },
      body: JSON.stringify({ ...f.body, type: "helpful", note: "" }),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).status).toBe("saved");
    expect(m.calls()).toBe(0);
    expect((await repo.read()).topics.find((t) => t.domain === f.t.domain)?.status).toBe("ready");
    const build = path.join(f.base, "synthetic-app-build");
    await mkdir(build);
    await writeFile(
      path.join(build, "index.html"),
      "<html><head></head><body>Same App fixture</body></html>",
    );
    const host = await createPrivateUnderstandingHost(repo, "synthetic-owner-token", build);
    expect(await (await host.request("/")).text()).toContain(
      'name="findme-private-host" content="understanding"',
    );
    expect((await host.request("/api/core/me")).status).toBe(404);
    expect((await host.request("/api/understanding")).status).toBe(401);
    expect(
      (
        await host.request("/api/understanding", {
          headers: { authorization: "Bearer synthetic-owner-token" },
        })
      ).status,
    ).toBe(200);
    expect((await host.request("/raw.json")).status).toBe(404);
  });
  it("save -> bounded generation + independent audit -> new accepted version -> reread, unchanged topics retain versions", async () => {
    const f = await fixture();
    const m = mockGateway();
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 4,
    });
    const beforeBytes = await readFile(
      path.join(f.options.baselineDir, "latest-partial.json"),
      "utf8",
    );
    const r = await repo.save(f.body, "synthetic-revision");
    const result = await repo.process(r.id);
    expect(result.status).toBe("accepted");
    expect(m.calls()).toBe(4);
    const next = await new PrivateUnderstandingRepository(f.options).read();
    const topic = required(next.topics.find((t) => t.domain === f.t.domain));
    expect(topic.status).toBe("ready");
    expect(topic.version).not.toBe(f.t.version);
    expect(topic.report?.current_understanding?.text).toContain("先明确");
    expect(next.overall).toMatchObject({ status: "needs_review", report: null });
    expect(await readFile(path.join(f.options.baselineDir, "latest-partial.json"), "utf8")).toBe(
      beforeBytes,
    );
    expect((await repo.evidence(topic.domain, topic.version, r.source_id)).quote).toBe(f.body.note);
    const qualifiedId = required(topic.report?.current_understanding?.evidence_ids[0]);
    expect(qualifiedId).not.toBe(r.source_id);
    expect(await repo.evidence(topic.domain, topic.version, qualifiedId)).toMatchObject({
      author: "subject",
      quote: f.body.note,
      qualifier: f.body.note,
      start: 0,
      end: f.body.note.length,
      report_time: r.saved_at,
      source_ids: [r.source_id],
    });
    await expect(repo.save(f.body, "synthetic-old-target")).rejects.toThrow("STALE_REPORT_VERSION");
    const second = await repo.save(
      { ...f.body, report_version: topic.version },
      "synthetic-budget",
    );
    await expect(repo.process(second.id)).rejects.toThrow("FEEDBACK_BUDGET_EXHAUSTED");
  });
  it("rejects failed audit and retains failed drafts without replacing accepted report", async () => {
    const f = await fixture();
    const m = mockGateway("reject");
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 4,
    });
    const r = await repo.save(f.body, "synthetic-reject");
    expect((await repo.process(r.id)).status).toBe("rejected");
    const next = await repo.read();
    expect(next.topics.find((t) => t.domain === f.t.domain)?.version).toBe(f.t.version);
    expect(next.topics.find((t) => t.domain === f.t.domain)?.status).toBe("needs_review");
    expect((await readState(f.options)).revisions[0]?.candidate).toBeTruthy();
    const retryGateway = mockGateway();
    const retry = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: retryGateway.gateway,
      feedbackMaxCalls: 6,
    });
    await expect(retry.process(r.id)).rejects.toThrow("SEMANTIC_REJECTION_REQUIRES_CHANGE");
    expect(
      (await retry.process(r.id, { reason: "重新检查限定范围，不把单次经历泛化。" })).status,
    ).toBe("accepted");
    const state = await readState(f.options);
    expect(state.revisions.map((v) => v.status)).toEqual(["rejected", "accepted"]);
    expect(state.calls_reserved).toBe(6);
    expect(retryGateway.calls()).toBe(2);
    expect((state.revisions[1]?.qualification as QualificationCheckpoint).version).toBe(
      (state.revisions[0]?.qualification as QualificationCheckpoint).version,
    );
  });
  it("prevents publication on source and feedback revision races", async () => {
    const f = await fixture();
    const m = mockGateway("accept", async () => {
      await put(path.join(f.batch, "state.json"), {});
    });
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 4,
    });
    const r = await repo.save(f.body, "synthetic-race");
    expect(await repo.process(r.id)).toMatchObject({
      status: "failed",
      error: "REVISION_SOURCE_RACE",
    });
    const g = await fixture();
    let other!: PrivateUnderstandingRepository;
    const n = mockGateway("accept", async () => {
      await other.save({ ...g.body, note: "另一个合成补充。" }, "synthetic-concurrent");
    });
    other = new PrivateUnderstandingRepository({
      ...g.options,
      gateway: n.gateway,
      feedbackMaxCalls: 4,
    });
    const saved = await other.save(g.body, "synthetic-race-2");
    expect(await other.process(saved.id)).toMatchObject({
      status: "failed",
      error: "REVISION_SOURCE_RACE",
    });
  });
});

it("selects the newest validated publication without permanently preferring partial or ready", () => {
  const ready = { ptr: { version: "ready-version" }, publishedAtMs: 20 };
  const partial = { ptr: { version: "partial-version" }, publishedAtMs: 10 };
  expect(latestPublication([ready, partial])).toBe(ready);
  expect(latestPublication([ready, { ...partial, publishedAtMs: 30 }]).ptr.version).toBe(
    "partial-version",
  );
  expect(() => latestPublication([ready, { ...partial, publishedAtMs: 20 }])).toThrow(
    "AMBIGUOUS_BASELINE_PUBLICATION",
  );
});

describe("U3 continuation slices (synthetic)", () => {
  it("topic -> overall requires a fresh independent audit, retains old dispositions, invalidates later feedback, replays with zero calls", async () => {
    const f = await fixture({ complete: true, overall: true });
    const m = mockGateway();
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 8,
    });
    const note = await repo.save(f.body, "continuation-topic");
    expect((await repo.read()).capabilities.overall.blocked_reason).toBe(
      "TOPIC_FEEDBACK_UNRESOLVED",
    );
    await repo.process(note.id);
    const request = required((await repo.read()).capabilities.overall.request);
    const ready = await repo.processOverall(request);
    expect(ready.overall.status).toBe("ready");
    expect(m.calls()).toBe(6);
    expect(ready.old_dispositions.status).toBe("needs_review");
    expect(ready.old_dispositions.report).toEqual(f.view.old_dispositions.report);
    const state = await readState(f.options);
    const job = required(state.revisions.find((r) => r.domain === "overall"));
    expect(job.dependency_map).toBeTruthy();
    expect(job.audit).toBeTruthy();
    const selection = job.selection as Selection;
    expect(
      selection.evidence.some(
        (e) =>
          e.source_id === note.source_id &&
          e.use === "personal_expression" &&
          e.content_author === "subject",
      ),
    ).toBe(true);
    expect(JSON.stringify(selection.evidence)).not.toContain("补充表明");
    const restarted = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 8,
    });
    await restarted.processOverall(request);
    await new PrivateUnderstandingRepository(f.options).processOverall(request);
    await restarted.process(note.id);
    await restarted.read();
    expect(m.calls()).toBe(6);
    const topic = required(ready.topics.find((t) => t.domain === f.t.domain));
    await restarted.save({ ...f.body, report_version: topic.version }, "continuation-later");
    expect((await restarted.read()).overall).toMatchObject({
      status: "needs_review",
      report: null,
    });
    await expect(restarted.processOverall(request)).rejects.toThrow("TOPIC_FEEDBACK_UNRESOLVED");
  });
  it("absent U2 overall blocks direct feedback processing with zero provider calls", async () => {
    const f = await fixture({ complete: true });
    const m = mockGateway();
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 4,
    });
    const r = await repo.save(f.body, "continuation-no-overall");
    await repo.process(r.id);
    const before = m.calls();
    const view = await repo.read();
    expect(view.capabilities.overall).toMatchObject({
      status: "blocked",
      blocked_reason: "U2_OVERALL_ABSENT",
      request: null,
    });
    await expect(
      repo.processOverall({
        baseline_version: view.baseline_version,
        input_hash: view.input_hash,
        prior_overall_version: view.overall.version,
        dependency_digest: digest({}),
      }),
    ).rejects.toThrow("U2_OVERALL_ABSENT");
    expect(m.calls()).toBe(before);
    expect((await readState(f.options)).calls_reserved).toBe(4);
  });
  it("direct overall feedback works but rejected overall preserves history without becoming ready", async () => {
    const f = await fixture({ complete: true, overall: true });
    const m = mockGateway("reject");
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 4,
    });
    const r = await repo.save(
      { ...f.body, domain: "overall", report_version: f.view.overall.version },
      "continuation-direct",
    );
    expect((await repo.process(r.id)).status).toBe("rejected");
    const next = await repo.read();
    expect(next.overall).toMatchObject({
      version: f.view.overall.version,
      status: "needs_review",
      report: null,
    });
    expect(next.capabilities.overall.status).toBe("rejected");
    await expect(repo.process(r.id)).rejects.toThrow("SEMANTIC_REJECTION_REQUIRES_CHANGE");
    expect(m.calls()).toBe(4);
  });
  it("ledger records identity, raw and reported usage; restart and retry retain cumulative reservations", async () => {
    const f = await fixture();
    const m = mockGateway();
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 4,
    });
    const r = await repo.save(f.body, "continuation-ledger");
    await repo.process(r.id);
    const s = await readState(f.options);
    expect(s.calls_reserved).toBe(4);
    expect(s.attempts).toHaveLength(4);
    expect(new Set(s.attempts.map((a) => a.id)).size).toBe(4);
    expect(s.attempts.map((a) => a.phase)).toEqual([
      "qualification_generation",
      "qualification_audit",
      "generation",
      "audit",
    ]);
    expect(
      s.attempts.every(
        (a) =>
          a.status === "ok" &&
          a.raw &&
          a.model === "synthetic-model" &&
          a.usage?.totalTokens === 15 &&
          a.completed_at,
      ),
    ).toBe(true);
    const next = await new PrivateUnderstandingRepository(f.options).read();
    expect(next.capabilities.remaining_calls).toBe(0);
    expect(next.capabilities.provider_enabled).toBe(false);
  });
  it("bounded timeout isolates late raw/usage and requires explicit recovery", async () => {
    const f = await fixture();
    let late: (() => Promise<void>) | undefined;
    const gateway: NonNullable<
      ConstructorParameters<typeof PrivateUnderstandingRepository>[0]["gateway"]
    > = {
      extract: (args) =>
        new Promise((resolve) => {
          late = async () => {
            await args.controls?.captureRawOutput?.("LATE_RAW");
            await args.controls?.observer?.afterAttempt({
              route: args.route,
              model: "late-model",
              attempt: 1,
              estimate: {
                method: "serialized_utf8_bytes_conservative",
                serializedUtf8Bytes: 1,
                estimatedInputTokens: 1,
              },
              latencyMs: 100,
              status: "ok",
              errorKind: null,
              usage: {
                inputTokens: 50,
                outputTokens: 50,
                totalTokens: 100,
                cacheInputTokens: null,
                cacheOutputTokens: null,
              },
            });
            const value = qualification(JSON.parse(args.text));
            resolve(args.schema.parse(value));
          };
        }),
    };
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway,
      feedbackMaxCalls: 4,
      providerTimeoutMs: 10,
    });
    const r = await repo.save(f.body, "continuation-timeout");
    expect(await repo.process(r.id)).toMatchObject({ status: "failed", error: "PROVIDER_TIMEOUT" });
    const before = await readState(f.options);
    expect(before.attempts[0]).toMatchObject({ status: "error", usage: null, raw: null });
    await required(late)();
    expect(await readState(f.options)).toEqual(before);
    const m = mockGateway();
    const recovered = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 5,
    });
    await expect(recovered.process(r.id)).rejects.toThrow("EXPLICIT_RECOVERY_REQUIRED");
    expect((await recovered.process(r.id, { recover: true })).status).toBe("accepted");
    expect((await readState(f.options)).calls_reserved).toBe(5);
  });
  it("legacy state integrity is checked before defaults and interrupted reservations never reset", async () => {
    const f = await fixture();
    const r = await f.repository.save(f.body, "continuation-legacy");
    const envelope = await json(path.join(f.options.stateDir, "feedback.json"));
    delete envelope.state.attempts;
    await put(path.join(f.options.stateDir, "feedback.json"), envelope);
    await expect(readState(f.options)).rejects.toThrow("FEEDBACK_STATE_INTEGRITY");
    envelope.state.calls_reserved = 1;
    envelope.state.revisions.push({
      id: "old-interrupted",
      domain: f.t.domain,
      previous_version: f.t.version,
      baseline_version: f.view.baseline_version,
      status: "processing",
      owner_pid: process.pid,
    });
    envelope.state.entries[0].receipt.status = "processing";
    envelope.hash = digest(envelope.state);
    await put(path.join(f.options.stateDir, "feedback.json"), envelope);
    const legacy = await readState(f.options);
    expect(legacy.attempts).toEqual([]);
    legacy.attempts.push({
      id: "interrupted-call",
      job_id: "old-interrupted",
      phase: "generation",
      route: "extraction_model",
      model: null,
      reserved_at: "2026-10-06T00:00:00Z",
      completed_at: null,
      status: "reserved",
      usage: null,
      raw: "partial original",
      error: null,
    });
    await writeState(f.options, legacy);
    const m = mockGateway();
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 5,
    });
    await expect(repo.process(r.id)).rejects.toThrow("EXPLICIT_RECOVERY_REQUIRED");
    expect((await repo.process(r.id, { recover: true })).status).toBe("accepted");
    expect((await readState(f.options)).calls_reserved).toBe(5);
    expect((await readState(f.options)).attempts[0]).toMatchObject({
      status: "interrupted",
      raw: "partial original",
    });
  });
  it("context binds exact question/finding and report version; saving never invokes provider", async () => {
    const f = await fixture();
    const m = mockGateway();
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 4,
    });
    await expect(
      repo.save(
        { ...f.body, context: { question: "silently different" } },
        "continuation-context-wrong",
      ),
    ).rejects.toThrow("STALE_EXPLORATION_CONTEXT");
    const question = required(f.t.report?.current_understanding?.text);
    const r = await repo.save({ ...f.body, context: { question } }, "continuation-context");
    expect(r.input.context?.question).toBe(question);
    expect(m.calls()).toBe(0);
    await expect(
      repo.save(
        { ...f.body, report_version: "old-version", context: { question } },
        "continuation-context-old",
      ),
    ).rejects.toThrow("STALE_REPORT_VERSION");
  });
  it("original union bounds block overall without calls rather than dropping evidence", async () => {
    const f = await fixture({ complete: true, overall: true });
    const m = mockGateway();
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 10,
    });
    for (let i = 0; i < 31; i++)
      await repo.save(
        {
          ...f.body,
          domain: "overall",
          report_version: f.view.overall.version,
          finding_key: undefined,
          note: `合成新增背景 ${i}`,
        },
        `continuation-bound-${i}`,
      );
    const view = await repo.read();
    expect(view.capabilities.overall.blocked_reason).toBe("OVERALL_ORIGINAL_BOUND_EXCEEDED");
    await expect(repo.process(view.feedback[0]!.id)).rejects.toThrow(
      "OVERALL_ORIGINAL_BOUND_EXCEEDED",
    );
    expect(m.calls()).toBe(0);
  });
});

it("overall rejects topic summary IDs as evidence and prevents publication on changed topic frontier", async () => {
  const f = await fixture({ complete: true, overall: true });
  const good = mockGateway();
  const bad: typeof good.gateway = {
    async extract(args) {
      const p = JSON.parse(args.text);
      if (p.task.includes("qualification")) return good.gateway.extract(args);
      const r = report(p.selection);
      required(r.current_understanding).evidence_ids = ["current"];
      return args.schema.parse(r);
    },
  };
  const repo = new PrivateUnderstandingRepository({
    ...f.options,
    gateway: bad,
    feedbackMaxCalls: 4,
  });
  const r = await repo.save(
    { ...f.body, domain: "overall", report_version: f.view.overall.version },
    "continuation-summary-id",
  );
  expect(await repo.process(r.id)).toMatchObject({
    status: "rejected",
    error: "UNKNOWN_REPORT_REFERENCE",
  });
  expect((await readState(f.options)).calls_reserved).toBe(3);
  let raced!: PrivateUnderstandingRepository;
  const race = mockGateway("accept", async () => {
    await raced.save(f.body, "continuation-overall-race");
  });
  raced = new PrivateUnderstandingRepository({
    ...f.options,
    gateway: race.gateway,
    feedbackMaxCalls: 6,
  });
  expect(await raced.process(r.id, { reason: "改用原文证据，检查报告引用。" })).toMatchObject({
    status: "failed",
    error: "REVISION_SOURCE_RACE",
  });
  expect((await raced.read()).overall.status).toBe("needs_review");
});

describe("U3 audited note qualification (synthetic)", () => {
  it("insufficient bundle budget leaves saved qualification pending and reserves zero calls", async () => {
    const f = await fixture();
    const m = mockGateway();
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 3,
    });
    const r = await repo.save(f.body, "qualification-budget");
    const view = await repo.read();
    expect(view.feedback[0]?.qualification).toBe("pending");
    expect(view.capabilities.feedback_actions[0]).toMatchObject({
      required_calls: 4,
      action: null,
      blocked_reason: "FEEDBACK_BUDGET_EXHAUSTED",
    });
    await expect(repo.process(r.id)).rejects.toThrow("FEEDBACK_BUDGET_EXHAUSTED");
    expect(m.calls()).toBe(0);
    expect((await readState(f.options)).calls_reserved).toBe(0);
  });
  it("mixed third-party quotation, denied self evaluation and repeated facets preserve exact spans and one root", async () => {
    const f = await fixture();
    const note = "同事说：我喜欢竞争。😀我不赞同竞争，我选择先明确范围。";
    const m = mockGateway("accept", undefined, (p) => {
      const candidate = qualification(p);
      const base = candidate.notes[0]!.propositions[0]!;
      const span = (quote: string, overrides: Partial<typeof base>) => ({
        ...base,
        quote,
        start: note.indexOf(quote),
        end: note.indexOf(quote) + quote.length,
        ...overrides,
      });
      candidate.notes[0]!.propositions = [
        span("我喜欢竞争。", {
          author: "third_party",
          about: "third_party",
          kind: "quotation",
          stance: "not_endorsed",
          purpose: "context_only",
          proposition: "转述同事意见",
          type: "preference",
        }),
        span("我不赞同竞争", {
          author: "subject",
          about: "self",
          kind: "evaluation",
          stance: "opposed",
          proposition: "本次不赞同竞争",
          type: "evaluation",
        }),
        span("我不赞同竞争", {
          author: "subject",
          about: "self",
          kind: "evaluation",
          stance: "opposed",
          proposition: "同一表达的局部评价分面",
          type: "state",
        }),
      ];
      return candidate;
    });
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 4,
    });
    const r = await repo.save({ ...f.body, note }, "qualification-mixed");
    expect(await repo.process(r.id)).toMatchObject({ status: "accepted", qualification: "ready" });
    const state = await readState(f.options);
    const q = state.revisions[0]!.qualification as QualificationCheckpoint;
    const facts = verifyQualification(q, state);
    expect(facts).toHaveLength(4);
    expect(new Set(facts.map((e) => e.canonical_id))).toEqual(new Set([r.source_id]));
    expect(new Set(facts.flatMap((e) => e.root_ids))).toEqual(new Set([r.source_id]));
    expect(facts[1]).toMatchObject({
      content_author: "third_party",
      use: "context",
      stance: "not_endorsed",
    });
    expect(facts[2]).toMatchObject({
      use: "personal_expression",
      stance: "opposed",
      time: r.saved_at,
    });
    for (const fact of facts) expect(note.slice(fact.start, fact.end)).toBe(fact.quote);
    const topic = required((await repo.read()).topics.find((t) => t.domain === f.t.domain));
    expect(
      await repo.evidence(
        topic.domain,
        topic.version,
        required(topic.report?.current_understanding?.evidence_ids[0]),
      ),
    ).toMatchObject({ quote: "我不赞同竞争", qualifier: note, stance: "opposed" });
  });
  it("forwarded and unresolved notes can be actually analyzed context-only, including zero propositions", async () => {
    for (const noPropositions of [false, true]) {
      const f = await fixture();
      const m = mockGateway("accept", undefined, (p) => {
        const c = qualification(p);
        const n = c.notes[0]!;
        n.reason = "仅转发且作者不明，未取得本人表达依据。";
        n.propositions = noPropositions
          ? []
          : n.propositions.map((v) => ({
              ...v,
              author: "unknown",
              about: "unknown",
              kind: "quotation",
              stance: "unknown",
              purpose: "context_only",
              type: "unknown",
            }));
        return c;
      });
      const repo = new PrivateUnderstandingRepository({
        ...f.options,
        gateway: m.gateway,
        feedbackMaxCalls: 4,
      });
      const r = await repo.save(
        { ...f.body, note: "转发的未知作者文字。" },
        `qualification-forward-${noPropositions}`,
      );
      expect(await repo.process(r.id)).toMatchObject({
        status: "accepted",
        qualification: "context_only",
      });
      const s = await readState(f.options);
      const q = s.revisions[0]!.qualification as QualificationCheckpoint;
      expect(q.audit?.checks.length).toBe(noPropositions ? 1 : 2);
      expect(verifyQualification(q, s).every((e) => e.use === "context")).toBe(true);
      expect((await repo.read()).feedback[0]?.qualification).toBe("context_only");
    }
  });
  it("qualification rejection and incomplete audit block report generation and blind repeat", async () => {
    for (const incomplete of [false, true]) {
      const f = await fixture();
      const m = mockGateway();
      const gateway: typeof m.gateway = {
        async extract(args) {
          const p = JSON.parse(args.text);
          if (p.task !== "u3_independent_qualification_audit") return m.gateway.extract(args);
          const value = audit(p, !incomplete);
          if (incomplete) value.checks = [];
          await args.controls?.captureRawOutput?.(JSON.stringify(value));
          return args.schema.parse(value);
        },
      };
      const repo = new PrivateUnderstandingRepository({
        ...f.options,
        gateway,
        feedbackMaxCalls: 8,
      });
      const r = await repo.save(f.body, `qualification-reject-${incomplete}`);
      expect(await repo.process(r.id)).toMatchObject({
        status: "rejected",
        qualification: "rejected",
      });
      const state = await readState(f.options);
      expect(state.attempts.map((a) => a.phase)).toEqual([
        "qualification_generation",
        "qualification_audit",
      ]);
      expect(state.calls_reserved).toBe(2);
      expect((state.revisions[0]!.qualification as QualificationCheckpoint).audit).toBeTruthy();
      expect((await repo.read()).topics.find((t) => t.domain === f.t.domain)?.version).toBe(
        f.t.version,
      );
      await expect(repo.process(r.id)).rejects.toThrow("SEMANTIC_REJECTION_REQUIRES_CHANGE");
      const recovery = new PrivateUnderstandingRepository({
        ...f.options,
        gateway: m.gateway,
        feedbackMaxCalls: 8,
      });
      expect(
        (await recovery.process(r.id, { reason: "检查原文作者，不使用之前的错误归属。" })).status,
      ).toBe("accepted");
      expect((await readState(f.options)).calls_reserved).toBe(6);
    }
  });
  it("fabricated spans, unknown IDs, split surrogate pairs and illegal author/purpose promotions are blocked", async () => {
    const f = await fixture();
    const r = await f.repository.save(
      { ...f.body, note: "😀我选择验证。" },
      "qualification-anchor",
    );
    const { qualificationInput } = await import("../src/understanding-app/qualification.js");
    const input = qualificationInput([r]);
    const valid = qualification(input);
    for (const mutate of [
      (c: typeof valid) => {
        c.notes[0]!.note_id = "invented-id";
      },
      (c: typeof valid) => {
        c.notes[0]!.propositions[0]!.quote = "虚构原文";
      },
      (c: typeof valid) => {
        Object.assign(c.notes[0]!.propositions[0]!, { quote: r.input.note.slice(1), start: 1 });
      },
      (c: typeof valid) => {
        c.notes[0]!.propositions[0]!.author = "third_party";
      },
      (c: typeof valid) => {
        Object.assign(c.notes[0]!.propositions[0]!, { kind: "work_requirement" });
      },
      (c: typeof valid) => {
        Object.assign(c.notes[0]!.propositions[0]!, { about: "project", kind: "self_report" });
      },
    ]) {
      const c = structuredClone(valid);
      mutate(c);
      expect(() => qualificationFacts(input, c)).toThrow();
    }
    const project = structuredClone(valid);
    Object.assign(project.notes[0]!.propositions[0]!, {
      about: "project",
      kind: "self_report",
      purpose: "project_report",
      type: "outcome",
    });
    expect(qualificationFacts(input, project)[1]).toMatchObject({
      use: "project_report",
      stance: "reported",
      time: r.saved_at,
    });
    Object.assign(project.notes[0]!.propositions[0]!, {
      purpose: "command_context",
      kind: "work_requirement",
      type: "goal",
    });
    expect(qualificationFacts(input, project)[1]?.use).toBe("context");
  });
  it("qualification audit, exact anchors and saved target binding are independently reconstructed on read and evidence", async () => {
    const f = await fixture();
    const m = mockGateway();
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 4,
    });
    const r = await repo.save(f.body, "qualification-tamper");
    await repo.process(r.id);
    const view = await repo.read();
    const topic = required(view.topics.find((t) => t.domain === f.t.domain));
    const evidenceId = required(topic.report?.current_understanding?.evidence_ids[0]);
    const original = await readState(f.options);
    for (const kind of ["anchor", "audit", "binding"]) {
      const s = structuredClone(original);
      const q = s.revisions[0]!.qualification as QualificationCheckpoint;
      if (kind === "anchor") q.candidate!.notes[0]!.propositions[0]!.quote = "篡改原文";
      if (kind === "audit") q.audit!.checks = [];
      if (kind === "binding") {
        s.entries[0]!.receipt.input.report_version = "stale-other-report";
        s.entries[0]!.body_hash = digest(s.entries[0]!.receipt.input);
      }
      await writeState(f.options, s);
      await expect(repo.read()).rejects.toThrow();
      await expect(repo.evidence(topic.domain, topic.version, evidenceId)).rejects.toThrow();
    }
    await writeState(f.options, original);
    expect((await repo.read()).feedback[0]?.qualification).toBe("ready");
  });
  it("historical overall reconstruction survives a subsequent topic revision then becomes stale", async () => {
    const f = await fixture({ complete: true, overall: true });
    const m = mockGateway();
    const repo = new PrivateUnderstandingRepository({
      ...f.options,
      gateway: m.gateway,
      feedbackMaxCalls: 10,
    });
    const r = await repo.save(f.body, "qualification-overall-first");
    await repo.process(r.id);
    const ready = await repo.processOverall(
      required((await repo.read()).capabilities.overall.request),
    );
    const overallVersion = ready.overall.version;
    const topic = required(ready.topics.find((t) => t.domain === f.t.domain));
    const second = await repo.save(
      { ...f.body, note: "我现在选择明确目标之后再开始。", report_version: topic.version },
      "qualification-overall-second",
    );
    await repo.process(second.id);
    const stale = await new PrivateUnderstandingRepository(f.options).read();
    expect(stale.overall).toMatchObject({
      status: "needs_review",
      version: overallVersion,
      report: null,
    });
    const s = await readState(f.options);
    const historical = required(
      s.revisions.find((v) => v.domain === "overall" && v.version === overallVersion),
    );
    const id = required(
      UnderstandingReport.parse(historical.candidate).current_understanding?.evidence_ids[0],
    );
    expect(await repo.evidence("overall", overallVersion, id)).toMatchObject({ author: "subject" });
    expect(m.calls()).toBe(10);
  });
  it("legacy @1 and input_digest revisions replay their original reconstruction without claiming qualification", async () => {
    for (const withDigest of [false, true]) {
      const f = await fixture();
      const r = await f.repository.save(f.body, `qualification-legacy-${withDigest}`);
      const s = await readState(f.options);
      const snap = await readBaseline(f.options);
      const prior = required(snap.accepted.get(f.t.domain));
      const fact = feedbackFact(r);
      if (!withDigest)
        Object.assign(fact, {
          content_author: "subject",
          about: "self",
          kind: "self_report",
          use: "personal_expression",
          purpose: "personal_expression",
        });
      const selection = withDigest
        ? boundedSelection(prior.selection, [...prior.selection.evidence, fact])
        : {
            ...prior.selection,
            evidence: [...prior.selection.evidence, fact],
            selected_original_atoms: prior.selection.evidence.length + 1,
            canonical_count: new Set([...prior.selection.evidence, fact].map((e) => e.canonical_id))
              .size,
            bytes: Buffer.byteLength(JSON.stringify([...prior.selection.evidence, fact])),
          };
      const candidate = report(selection);
      if (withDigest) {
        required(candidate.current_understanding).context_ids = [r.source_id];
        required(candidate.current_understanding).time = null;
      }
      const analysis = { selection };
      const a = audit({
        analysis_input_hash: digest(analysis),
        assigned: assignReport(candidate, digest(analysis)),
      });
      const version = digest([analysis, candidate, a]);
      s.revisions.push({
        id: "legacy-synthetic",
        status: "accepted",
        domain: f.t.domain,
        baseline_version: f.view.baseline_version,
        input_hash: f.view.input_hash,
        previous_version: f.t.version,
        feedback_ids: [r.id],
        selection,
        candidate,
        audit: a,
        analysis_input: analysis,
        version,
        ...(withDigest ? { input_digest: digest([selection, [r.id], null]) } : {}),
      });
      Object.assign(s.entries[0]!.receipt, { status: "accepted", result_version: version });
      await writeState(f.options, s);
      const view = await f.repository.read();
      expect(view.topics.find((t) => t.domain === f.t.domain)?.version).toBe(version);
      expect(view.feedback[0]?.qualification).toBe("pending");
    }
  });
});

it("binds qualified candidates to their retained raw transport even after rehashing", async () => {
  const f = await fixture();
  const m = mockGateway();
  const repo = new PrivateUnderstandingRepository({
    ...f.options,
    gateway: m.gateway,
    feedbackMaxCalls: 4,
  });
  const receipt = await repo.save(f.body, "synthetic-transport-binding");
  expect((await repo.process(receipt.id)).status).toBe("accepted");
  const state = await readState(f.options);
  const q = structuredClone(state.revisions[0]!.qualification) as QualificationCheckpoint;
  expect(() => verifyQualification(q, state)).not.toThrow();
  const proposition = required(required(q.candidate).notes[0]?.propositions[0]);
  proposition.proposition = "合成篡改：未经过审核的扩大解释。";
  q.version = digest([q.input, q.candidate, q.audit, q.provenance]);
  expect(() => verifyQualification(q, state)).toThrow("QUALIFICATION_TRANSPORT_INTEGRITY");
});

describe("U3 scoped source recovery and version reading (synthetic injected gateway)", () => {
  const owner = {
    tenantId: "00000000-0000-4000-8000-000000000001",
    subjectId: "00000000-0000-4000-8000-000000000002",
  };
  const id = "00000000-0000-4000-8000-000000000004";
  const binding = {
    tenant_id: owner.tenantId,
    subject_id: owner.subjectId,
    exploration_id: "00000000-0000-4000-8000-000000000003",
    source_id: id,
    assessment_version: 1,
    content_hash: "c".repeat(64),
    occurred_at: null,
    disclosed_at: "2026-10-06T08:00:00Z",
    attribution_basis: "synthetic injected eligibility",
  };
  const action = (key = "source-retire-key", revision = 0) => ({
    source_id: id,
    expected_lifecycle_revision: revision,
    reason: "明确移除合成来源",
    idempotency_key: key,
  });
  async function setup(afterAudit?: () => Promise<void>) {
    const f = await fixture({ complete: true, overall: true });
    let invalid = false;
    const base = mockGateway("accept", afterAudit);
    const gateway: typeof base.gateway = {
      async extract(args) {
        const value = await base.gateway.extract(args);
        const p = JSON.parse(args.text);
        if (p.task === "u3_topic_feedback_revision") {
          const source = (p.selection as Selection).evidence.find(
            (e) => e.source_id === id && e.use === "personal_expression",
          );
          if (source) {
            const candidate = UnderstandingReport.parse(value);
            required(candidate.current_understanding).evidence_ids = [source.id];
            required(candidate.current_understanding).context_ids = [];
            required(candidate.current_understanding).text = source.quote;
            required(candidate.current_understanding).scope = source.scope;
            required(candidate.current_understanding).time = source.time;
            await args.controls?.captureRawOutput?.(JSON.stringify(candidate));
            return args.schema.parse(candidate);
          }
        }
        return value;
      },
    };
    const coreBridge = {
      owner,
      verifySource: async () => {
        if (invalid) throw new Error("STALE_REPORT_SOURCE");
      },
    };
    const repository = new PrivateUnderstandingRepository({
      ...f.options,
      coreBridge,
      gateway,
      feedbackMaxCalls: 100,
    });
    const body = { ...f.body, note: "SOURCE_SECRET_SYNTHETIC 我会先检查具体边界。" };
    const saved = await repository.saveCore(body, "lifecycle-core-save", binding);
    return {
      ...f,
      repository,
      saved,
      binding,
      gateway,
      coreBridge,
      body,
      setInvalid: (value: boolean) => {
        invalid = value;
      },
      calls: base.calls,
    };
  }
  it("invalid imported source blocks all dependent current/history text while unrelated topic and original U2 stay readable", async () => {
    const f = await setup();
    const accepted = await f.repository.process(f.saved.id);
    expect(accepted.status).toBe("accepted");
    const current = await f.repository.read();
    const exactId = required(
      current.topics.find((t) => t.domain === f.body.domain)?.report?.current_understanding,
    ).evidence_ids[0]!;
    expect(
      (await f.repository.evidence(f.body.domain, accepted.result_version!, exactId)).quote,
    ).toContain("SOURCE_SECRET_SYNTHETIC");
    f.setInvalid(true);
    const before = await readState(f.options);
    const blocked = await f.repository.read();
    expect(blocked.topics.find((t) => t.domain === f.body.domain)).toMatchObject({
      status: "blocked",
      version: accepted.result_version,
      report: null,
    });
    for (const topic of f.view.topics.filter((t) => t.domain !== f.body.domain)) {
      expect(blocked.topics.find((t) => t.domain === topic.domain)).toMatchObject({
        version: topic.version,
        report: topic.report,
      });
    }
    expect(JSON.stringify(blocked)).not.toContain("SOURCE_SECRET_SYNTHETIC");
    expect(await f.repository.version(f.body.domain, accepted.result_version!)).toMatchObject({
      status: "blocked",
      report: null,
    });
    await expect(
      f.repository.evidence(f.body.domain, accepted.result_version!, exactId),
    ).rejects.toThrow("REPORT_SOURCE_BLOCKED");
    expect((await f.repository.version(f.body.domain, f.t.version)).report).toEqual(f.t.report);
    expect(await readState(f.options)).toEqual(before);
  });
  it("retirement rebuilds exactly remaining valid inputs with independent generation/audit, never resurrects when source restores", async () => {
    const f = await setup();
    const accepted = await f.repository.process(f.saved.id);
    f.setInvalid(true);
    await f.repository.retireSource(action());
    f.setInvalid(false);
    const before = await readState(f.options);
    expect((await f.repository.read()).feedback[0]?.input.note).toBe("");
    const view = await f.repository.recoverTopic(f.body.domain, accepted.result_version!);
    expect(view.topics.find((t) => t.domain === f.body.domain)?.status).toBe("ready");
    const state = await readState(f.options);
    const recovery = state.revisions.at(-1)!;
    expect(recovery).toMatchObject({
      status: "accepted",
      source_recovery: true,
      retired_roots: [id],
    });
    expect(JSON.stringify(recovery.analysis_input)).not.toContain("SOURCE_SECRET_SYNTHETIC");
    expect(
      (recovery.analysis_input as { previous_report_target_only: unknown })
        .previous_report_target_only,
    ).toBeNull();
    expect(state.calls_reserved - before.calls_reserved).toBe(2);
    expect(state.attempts.slice(-2).map((a) => a.phase)).toEqual(["generation", "audit"]);
    expect(state.entries[0]?.receipt.input.note).toBe(f.body.note);
    expect(state.revisions[0]).toEqual(before.revisions[0]);
    expect(view.old_dispositions).toEqual(
      f.view.old_dispositions.report
        ? { ...f.view.old_dispositions, status: "needs_review" }
        : view.old_dispositions,
    );
    const history = await f.repository.history(f.body.domain, 1);
    expect(history.truncated).toBe(true);
    expect(history.versions[0]).toMatchObject({
      previous_version: accepted.result_version,
      origin: "source_recovery",
      status: "accepted",
    });
    expect((await f.repository.version(f.body.domain, accepted.result_version!)).report).toBeNull();
  });
  it("rebind stores a new saved lineage and reruns changed qualification instead of inheriting old audit", async () => {
    const f = await setup();
    const accepted = await f.repository.process(f.saved.id);
    const replacementBinding = {
      ...binding,
      source_id: "00000000-0000-4000-8000-000000000099",
      assessment_version: 2,
      content_hash: "d".repeat(64),
    };
    const other = required(f.view.topics.find((t) => t.domain !== f.body.domain && t.report));
    const shared = await f.repository.saveCore(
      {
        ...f.body,
        domain: other.domain,
        report_version: other.version,
        finding_key: undefined,
        note: "NEW_SOURCE_ONLY 我现在会检查授权条件。",
      },
      "preimport-replacement",
      replacementBinding,
    );
    await f.repository.rebindSource(
      {
        ...action("source-rebind-key"),
        exploration_id: binding.exploration_id,
        new_source_id: replacementBinding.source_id,
        target: {
          baseline_version: f.view.baseline_version,
          input_hash: f.view.input_hash,
          domain: f.body.domain,
          report_version: accepted.result_version!,
        },
      },
      replacementBinding,
      "NEW_SOURCE_ONLY 我现在会检查授权条件。",
    );
    const before = await readState(f.options);
    const replacement = before.entries.at(-1)!.receipt;
    expect(replacement.replaces_source_id).toBe(id);
    expect(replacement.source_id).toBe(shared.source_id);
    expect((await f.repository.read()).feedback.at(-1)?.qualification).toBe("pending");
    await f.repository.recoverTopic(f.body.domain, accepted.result_version!);
    const state = await readState(f.options);
    const recovery = state.revisions.at(-1)!;
    expect(recovery.status).toBe("accepted");
    expect(state.calls_reserved - before.calls_reserved).toBe(4);
    expect(state.attempts.slice(-4).map((a) => a.phase)).toEqual([
      "qualification_generation",
      "qualification_audit",
      "generation",
      "audit",
    ]);
    expect(JSON.stringify(recovery.analysis_input)).not.toContain("SOURCE_SECRET_SYNTHETIC");
    expect((recovery.qualification as QualificationCheckpoint).input.notes[0]?.note).toContain(
      "NEW_SOURCE_ONLY",
    );
    expect(recovery.qualification_versions).not.toContain(
      (state.revisions[0]?.qualification as QualificationCheckpoint).version,
    );
  });
  it("source loss or explicit retirement while a model is pending prevents publication and preserves every reserved call", async () => {
    for (const retired of [false, true]) {
      let loseSource: (() => Promise<void>) | undefined;
      const f = await setup(async () => {
        if (loseSource) await loseSource();
      });
      loseSource = async () => {
        if (retired) await f.repository.retireSource(action());
        else f.setInvalid(true);
      };
      const result = await f.repository.process(f.saved.id);
      expect(result.status).toBe("failed");
      expect(result.error).toBe(retired ? "SOURCE_RETIRED" : "STALE_REPORT_SOURCE");
      const state = await readState(f.options);
      expect(state.revisions[0]).toMatchObject({ status: "failed", error: "REVISION_SOURCE_RACE" });
      expect(state.calls_reserved).toBe(4);
      expect(state.attempts).toHaveLength(4);
      expect(state.attempts.every((a) => a.status === "ok" && a.raw !== null)).toBe(true);
      expect((await f.repository.history(f.body.domain)).versions.map((v) => v.version)).toEqual([
        f.t.version,
      ]);
      expect(JSON.stringify(await f.repository.read())).not.toContain("SOURCE_SECRET_SYNTHETIC");
    }
  });
  it("shared root invalidates every actual topic and overall dependent, preserving historical version references", async () => {
    const f = await setup();
    const first = await f.repository.process(f.saved.id);
    const other = required(f.view.topics.find((t) => t.domain !== f.body.domain && t.report));
    const second = await f.repository.saveCore(
      { ...f.body, domain: other.domain, report_version: other.version, finding_key: undefined },
      "shared-source-topic",
      binding,
    );
    await f.repository.process(second.id);
    const ready = await f.repository.read();
    const request = required(ready.capabilities.overall.request);
    await f.repository.processOverall(request);
    const overallVersion = (await f.repository.read()).overall.version;
    f.setInvalid(true);
    const view = await f.repository.read();
    expect(view.topics.find((t) => t.domain === f.body.domain)?.status).toBe("blocked");
    expect(view.topics.find((t) => t.domain === other.domain)?.status).toBe("blocked");
    expect(view.overall).toMatchObject({
      status: "needs_review",
      version: overallVersion,
      report: null,
    });
    expect(await f.repository.version("overall", overallVersion)).toMatchObject({
      status: "blocked",
      report: null,
    });
    expect((await f.repository.history(f.body.domain)).versions[0]).toMatchObject({
      version: first.result_version,
      previous_version: f.t.version,
      status: "blocked",
    });
    expect(JSON.stringify(view)).not.toContain("SOURCE_SECRET_SYNTHETIC");
    await f.repository.retireSource(action());
    await f.repository.recoverTopic(f.body.domain, first.result_version!);
    const otherVersion = view.topics.find((t) => t.domain === other.domain)!.version;
    await f.repository.recoverTopic(other.domain, otherVersion);
    const recoveryRequest = required((await f.repository.read()).capabilities.overall.request);
    await f.repository.processOverall(recoveryRequest);
    const recovered = await f.repository.read();
    expect(recovered.overall.status).toBe("ready");
    expect((await f.repository.version("overall", recovered.overall.version)).status).toBe(
      "accepted",
    );
    expect((await f.repository.version("overall", overallVersion)).status).toBe("blocked");
    expect((await f.repository.history("overall")).versions[0]).toMatchObject({
      status: "accepted",
      origin: "source_recovery",
      previous_version: overallVersion,
    });
    expect((await readState(f.options)).revisions.at(-1)?.analysis_input).not.toEqual(null);
    expect(
      JSON.stringify((await readState(f.options)).revisions.at(-1)?.analysis_input),
    ).not.toContain("SOURCE_SECRET_SYNTHETIC");
  });
  it("unrelated deterministic invalidity does not block a retired topic recovery and failure is never no_evidence", async () => {
    const f = await setup();
    const stillValid = await f.repository.save(
      { ...f.body, note: "VALID_INDEPENDENT 我仍希望明确交流目标。" },
      "still-valid-before-loss",
    );
    const accepted = await f.repository.process(f.saved.id);
    expect(accepted.status).toBe("accepted");
    const other = required(f.view.topics.find((t) => t.domain !== f.body.domain && t.report));
    const otherBinding = { ...binding, source_id: "00000000-0000-4000-8000-000000000099" };
    await f.repository.saveCore(
      { ...f.body, domain: other.domain, report_version: other.version, finding_key: undefined },
      "unrelated-invalid",
      otherBinding,
    );
    // The verifier loses both sources; only the actual root of this topic needs retirement.
    f.setInvalid(true);
    await f.repository.retireSource(action());
    const beforeRecovery = await readState(f.options);
    const view = await f.repository.recoverTopic(f.body.domain, accepted.result_version!);
    expect(view.topics.find((t) => t.domain === f.body.domain)?.status).toBe("ready");
    const state = await readState(f.options);
    const revision = state.revisions.at(-1)!;
    expect(state.calls_reserved - beforeRecovery.calls_reserved).toBe(4);
    expect(
      (revision.qualification as QualificationCheckpoint).input.notes.map((n) => n.id),
    ).toEqual([stillValid.id]);
    expect((revision.qualification as QualificationCheckpoint).input.source_recovery).toBe(true);
    expect(revision.qualification_versions).not.toContain(
      (state.revisions[0]?.qualification as QualificationCheckpoint).version,
    );
    expect(JSON.stringify(revision.analysis_input)).not.toContain("SOURCE_SECRET_SYNTHETIC");
    expect(JSON.stringify(revision.analysis_input)).toContain("VALID_INDEPENDENT");

    expect(view.sources?.find((s) => s.source_id === otherBinding.source_id)?.status).toBe(
      "invalid",
    );
    expect(
      view.sources?.find((s) => s.source_id === otherBinding.source_id)?.affected_domains,
    ).not.toContain(f.body.domain);
    expect(view.topics.find((t) => t.domain === f.body.domain)?.status).not.toBe("no_evidence");
  });
});
