import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EvidencePacket, type ReasoningCandidate, reasoningCandidateSchema } from "@findme/core";
import { reasoningAuditSchema } from "@findme/core";
import { zodResponseFormat } from "openai/helpers/zod";
import { afterEach, describe, expect, it } from "vitest";
import { parseReasoningArgs } from "../scripts/diagnostic-reasoning.js";
import type { CoreGateway } from "../src/core/llm.js";
import {
  type EvidenceLoader,
  batchEvidenceLoader,
  packetEvidenceLoader,
  selectEvidence,
} from "../src/diagnostic-reasoning/evidence.js";
import { candidateProblems, newlyDisclosed } from "../src/diagnostic-reasoning/policy.js";
import {
  type ReportEnvelope,
  prepareOutput,
  readPrevious,
  runDiagnostic,
} from "../src/diagnostic-reasoning/runner.js";
import type { LayerEvidence } from "../src/dogfood/layers.js";
import { hash } from "../src/dogfood/model.js";
import { BatchStore } from "../src/dogfood/store.js";
import { type GatewayAttemptInfo, GatewayRequestError } from "../src/llm/gateway.js";

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing test fixture");
  return value;
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const roots: string[] = [];
async function temp() {
  const dir = await mkdtemp(path.join(tmpdir(), "reasoning-test-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function packet(
  texts = ["I value useful outcomes in this studio."],
  question = "useful outcomes studio",
): EvidencePacket {
  return EvidencePacket.parse({
    format: "diagnostic-evidence-packet@1",
    question,
    question_origin: "test_question",
    sources: texts.map((text, i) => ({
      id: `s${i}`,
      session_id: `session${i}`,
      message_id: `message${i}`,
      source_uuid: null,
      project: "studio",
      occurred_at: "2025-02-01T00:00:00Z",
      disclosed_at: "2026-01-01T00:00:00Z",
      group_id: `group${i}`,
      split: "dev",
      original_text: text,
      revision: "r1",
      review_revision: 0,
      excluded: false,
    })),
    evidence: texts.map((text, i) => ({
      id: `q${i}`,
      canonical_id: `canonical${i}`,
      source_id: `s${i}`,
      start: 0,
      end: text.length,
      quote: text,
      content_author: "subject",
      about: "project",
      kind: "evaluation",
      stance: "endorsed",
      stance_candidate: "endorsed",
      provenance: "typed_input",
      use: "personal_expression",
      revision: "r1",
      excluded: false,
      stale: false,
      classification_conflict: false,
    })),
  });
}
const loader =
  (p: EvidencePacket): EvidenceLoader =>
  async () => ({ packet: structuredClone(p), dependency_hash: hash(p) });
function candidate(ids = ["q0"]): ReasoningCandidate {
  return reasoningCandidateSchema(ids).parse({
    headline: "Outcome criterion in this setting",
    presented_problem: null,
    reframe:
      "The question concerns an expressed project criterion, with no stated personal distress.",
    observations: [
      {
        key: "O1",
        category: "condition",
        text: "Useful outcomes matter in this studio.",
        mode: "observation",
        scope: "this studio only",
        sufficiency: "partial",
        basis: [{ evidence_id: ids[0], relation: "supports" }],
        alternatives: [],
        would_change: "A same-context contrary criterion.",
      },
    ],
    explanations: [],
    tension: null,
    stances: [],
    question: null,
    next_step: null,
    revisions: [],
    limitations: ["One bounded project expression."],
  });
}
type Payload = Record<string, unknown>;
type Handler = (phase: "analysis" | "audit", payload: Payload) => unknown | Promise<unknown>;
function mockGateway(handler?: Handler) {
  const tasks: { phase: "analysis" | "audit"; payload: Payload }[] = [];
  const gateway: CoreGateway = {
    describe: (route) => ({ route, model: "mock-model" }),
    extract: async (args) => {
      const payload = JSON.parse(args.text) as Payload;
      const phase = payload.candidate ? "audit" : "analysis";
      tasks.push({ phase, payload });
      expect(args.controls?.retries).toBe(0);
      expect(args.controls?.timeoutMs).toBeGreaterThan(0);
      const info: GatewayAttemptInfo = {
        route: args.route,
        model: "mock-model",
        attempt: 1,
        estimate: {
          method: "serialized_utf8_bytes_conservative",
          serializedUtf8Bytes: args.text.length,
          estimatedInputTokens: args.text.length,
        },
      };
      await args.controls?.observer?.beforeAttempt(info);
      try {
        const selected = payload.selection as ReturnType<typeof selectEvidence>;
        const value = handler
          ? await handler(phase, payload)
          : phase === "analysis"
            ? candidate(selected.evidence.map((e) => e.id))
            : auditFor(payload);
        const result = args.schema.parse(value);
        await args.controls?.observer?.afterAttempt({
          ...info,
          status: "ok",
          errorKind: null,
          latencyMs: 1,
          usage: null,
        });
        return result;
      } catch (error) {
        const kind = error instanceof GatewayRequestError ? error.kind : "schema_validation";
        await args.controls?.observer?.afterAttempt({
          ...info,
          status: "error",
          errorKind: kind,
          latencyMs: 1,
          usage: {
            inputTokens: 17,
            outputTokens: null,
            totalTokens: null,
            cacheInputTokens: null,
            cacheOutputTokens: null,
          },
        });
        throw new GatewayRequestError(kind);
      }
    },
  };
  return { gateway, tasks };
}
function auditFor(payload: Payload) {
  const c = payload.candidate as ReasoningCandidate;
  return {
    task_checked: { question: payload.question, question_origin: payload.question_origin },
    finding_checks: (payload.assigned_findings as { id: string }[]).map((f) => ({
      finding_id: f.id,
      checked: true,
      rationale: "Checked this local proposition against exact task and supplied quotation.",
    })),
    revision_checks: c.revisions.map((r) => ({
      old_finding_id: r.old_finding_id,
      old_proposition_matches: true,
      same_context: true,
      concrete_incompatibility: true,
      rationale:
        "Compared the exact old proposition with the newly disclosed quote in the stated same setting.",
    })),
    issues: [],
  };
}
async function record(filename: string) {
  return JSON.parse(await readFile(filename, "utf8")) as ReportEnvelope;
}
async function run(
  p: EvidencePacket,
  gateway?: CoreGateway,
  extra: Partial<Parameters<typeof runDiagnostic>[0]> = {},
) {
  const out = extra.out ?? (await temp());
  return runDiagnostic({
    loader: loader(p),
    out,
    repoRoot,
    gateway,
    live: Boolean(gateway),
    ...extra,
  });
}
function revision(
  payload: Payload,
  operation: "unchanged" | "weakened" | "reversed" | "expanded",
  text: string,
  newIds: string[],
  chronology: "old_fact_disclosed_late" | "new_event" = "old_fact_disclosed_late",
) {
  const prior = payload.previous as { findings: { id: string; text: string }[] };
  const c = candidate(
    (payload.selection as ReturnType<typeof selectEvidence>).evidence.map((e) => e.id),
  );
  must(c.observations[0]).text = text;
  c.revisions = [
    {
      old_finding_id: must(prior.findings[0]).id,
      op: operation,
      new_key: "O1",
      newly_disclosed_evidence_ids: newIds,
      relation:
        operation === "unchanged"
          ? "clarifies"
          : operation === "expanded"
            ? "adds_alternative"
            : "contradicts",
      chronology,
      old_proposition: must(prior.findings[0]).text,
      new_proposition: text,
      shared_context: "same studio, same decision",
      incompatibility:
        operation === "weakened" || operation === "reversed"
          ? "The new proposition is asserted to exclude the old outcome criterion in the same setting."
          : null,
      rationale: "Explicit comparison with the previous proposition.",
    },
  ];
  return c;
}

async function frozen() {
  const directory = await temp();
  const raw = [
    {
      id: "frozen-session",
      sourceUuid: null,
      rootId: null,
      time: "2025-02-01T00:00:00Z",
      project: "studio",
      sourceRevision: "revision-one",
      sourceSessionId: "original-session",
      messages: [
        {
          id: "original-message",
          role: "user",
          text: "I prefer useful outcomes.",
          time: "2025-02-01T00:00:00Z",
          sourceUuid: null,
        },
      ],
      fingerprint: "",
      groupId: "single-group",
      selectionReasons: [],
    },
  ];
  must(raw[0]).fingerprint = hash(must(raw[0]).messages);
  const { messages: _messages, ...session } = must(raw[0]);
  const manifest = {
    format: "findme-av-dogfood-v0.1",
    id: "sample",
    createdAt: "2026-01-01T00:00:00Z",
    sourceFingerprint: hash(raw),
    seed: "test",
    requestedSessions: 1,
    requestedHoldout: 0,
    sessions: [{ ...session, split: "dev", messageIds: ["original-message"] }],
    independence: "unknown",
    holdoutValidation: "pending",
  };
  await writeFile(path.join(directory, "raw.json"), JSON.stringify(raw));
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  await mkdir(path.join(directory, "L1"));
  const row: LayerEvidence = {
    id: "q0",
    canonicalId: "canonical0",
    segmentId: "segment0",
    sessionId: "frozen-session",
    messageId: "original-message",
    sourceUuid: null,
    project: "studio",
    groupId: "single-group",
    time: must(raw[0]).time,
    split: "dev",
    start: 0,
    end: must(must(raw[0]).messages[0]).text.length,
    quote: must(must(raw[0]).messages[0]).text,
    author: "subject",
    about: "project",
    kind: "evaluation",
    facet: "evaluation",
    stance: "endorsed",
    statement: "This generated summary must never be an original quote.",
    scope: "studio",
    eligible: true,
    status: "candidate",
    judgedBy: "model_candidate",
  };
  await writeFile(path.join(directory, "L1", "evidence.jsonl"), `${JSON.stringify(row)}\n`);
  return { directory, row };
}

describe("bounded exact retrieval", () => {
  it("validates original UTF16 spans including emoji and rejects altered quotes", () => {
    const p = packet(["🧭 useful outcome"]);
    must(p.evidence[0]).start = 3;
    must(p.evidence[0]).quote = "useful outcome";
    expect(must(EvidencePacket.parse(p).evidence[0]).quote).toBe("useful outcome");
    must(p.evidence[0]).quote = "useful outcomes";
    expect(() => EvidencePacket.parse(p)).toThrow();
  });
  it("filters holdout/excluded/stale before ranking and context; unknown author cannot support", () => {
    const p = packet([
      "useful outcomes",
      "useful outcomes holdout",
      "useful outcomes excluded",
      "useful outcomes stale",
      "useful outcomes unknown",
    ]);
    must(p.sources[1]).split = "holdout";
    must(p.sources[2]).excluded = true;
    must(p.evidence[3]).stale = true;
    must(p.evidence[4]).content_author = "unknown";
    must(p.evidence[4]).use = "context";
    const s = selectEvidence(p);
    expect(s.evidence.map((e) => e.id)).toEqual(["q0", "q4"]);
    expect(JSON.stringify(s)).not.toContain('holdout"');
    expect(candidateProblems(candidate(["q4"]), s)).toContain("INADMISSIBLE_BASIS");
  });
  it("keeps bounded qualifiers but never injects a holdout referent or excluded span", () => {
    const p = packet([
      "private useful outcome",
      "This outcome is useful unless permission is absent.",
      "forbidden context",
    ]);
    must(p.sources[0]).split = "holdout";
    must(p.sources[2]).excluded = true;
    for (const s of p.sources) {
      s.session_id = "same-session";
      s.group_id = "same-group";
    }
    const s = selectEvidence(p);
    expect(s.evidence).toHaveLength(1);
    expect(JSON.stringify(s)).not.toContain("private useful");
    expect(JSON.stringify(s)).not.toContain("forbidden");
  });
  it("is deterministic, query specific, bounded and diversifies sessions/groups without claiming independence", () => {
    const p = packet([
      "useful outcomes repeated",
      "useful outcomes repeated again",
      "useful outcomes distinct",
      "sleep matters",
    ]);
    must(p.sources[1]).session_id = must(p.sources[0]).session_id;
    must(p.sources[1]).group_id = must(p.sources[0]).group_id;
    const a = selectEvidence(p, { maxEvidence: 2 });
    expect(a.evidence.map((e) => e.id)).toEqual(["q0", "q2"]);
    expect(a).toEqual(selectEvidence(p, { maxEvidence: 2 }));
    expect(a.limitations.join(" ")).toContain("semantic recall is unproven");
    p.question = "sleep";
    expect(selectEvidence(p).evidence.map((e) => e.id)).toEqual(["q3"]);
    p.question = "useful";
    must(p.sources[2]).group_id = must(p.sources[0]).group_id;
    expect(selectEvidence(p).counts.event_groups).toBe(1);
  });
  it("reserves relevant negation candidates without calling them true counterevidence", () => {
    const p = packet([
      "useful outcome useful outcome",
      "Outcome useful sometimes",
      "Useful outcome not enough",
    ]);
    const s = selectEvidence(p, { maxEvidence: 2 });
    expect(must(s.evidence[0]).id).toBe("q2");
    expect(must(s.evidence[0]).reason.join(" ")).toContain("not established counterevidence");
    expect(s.counts.bytes).toBeLessThanOrEqual(24000);
  });
  it("coalesces aliases and downgrades conflicting labels", () => {
    const p = packet(["useful outcomes", "useful outcomes"]);
    must(p.evidence[1]).canonical_id = must(p.evidence[0]).canonical_id;
    must(p.evidence[1]).content_author = "third_party";
    must(p.evidence[1]).kind = "quotation";
    must(p.evidence[1]).use = "context";
    const s = selectEvidence(p);
    expect(s.evidence).toHaveLength(1);
    expect(must(s.evidence[0]).use).toBe("context");
    expect(must(s.evidence[0]).classification_conflict).toBe(true);
    expect(s.counts.duplicates).toBe(1);
  });
  it("uses local project stance while quoted others remain context; not_endorsed cannot become opposed", () => {
    const p = packet(["I value useful outcomes.", "They say useful outcomes are pointless."]);
    must(p.evidence[1]).content_author = "third_party";
    must(p.evidence[1]).kind = "quotation";
    must(p.evidence[1]).use = "context";
    const s = selectEvidence(p);
    expect(must(s.evidence.find((e) => e.id === "q0")).use).toBe("personal_expression");
    expect(must(s.evidence.find((e) => e.id === "q1")).use).toBe("context");
    must(p.evidence[0]).stance = "not_endorsed";
    const c = candidate();
    c.stances.push({
      evidence_id: "q0",
      quote: must(p.evidence[0]).quote,
      subject: "subject's project evaluation",
      proposition: "useful outcomes",
      stance: "opposed",
    });
    expect(candidateProblems(c, selectEvidence(p))).toContain("STANCE_ESCALATION");
  });
  it("applies project/date before ranking and enforces UTF8 rather than character budget", () => {
    const p = packet(["useful outcomes", "useful outcomes"]);
    must(p.sources[1]).project = "other-studio";
    expect(selectEvidence(p, { project: "studio" }).evidence.map((e) => e.id)).toEqual(["q0"]);
    expect(selectEvidence(p, { before: "2025-01-01T00:00:00Z" }).evidence).toHaveLength(0);
    expect(selectEvidence(p, { maxBytes: 3 }).evidence).toHaveLength(0);
  });
  it("loads only exact L1/raw with current reviews and never copies generated statements", async () => {
    const f = await frozen();
    const load = batchEvidenceLoader(f.directory, "useful outcomes");
    const first = await load();
    expect(must(first.packet.sources[0]).session_id).toBe("original-session");
    expect(JSON.stringify(selectEvidence(first.packet))).not.toContain("generated summary");
    const batch = await new BatchStore(f.directory).load();
    batch.state.sourceReviews[must(batch.sources[0]).id] = {
      revision: 1,
      excluded: true,
      context: ["excluded by reviewer"],
    };
    await writeFile(path.join(f.directory, "state.json"), JSON.stringify(batch.state));
    expect(selectEvidence((await load()).packet).evidence).toHaveLength(0);
    expect((await load()).dependency_hash).not.toBe(first.dependency_hash);
    expect(await readdir(f.directory)).not.toContain(".staging-lock");
  });
  it("rejects tampered freeze, invalid span, and ambiguous stale attribution", async () => {
    const f = await frozen();
    const batch = await new BatchStore(f.directory).load();
    batch.state.candidates.push({
      id: "review1",
      sourceId: must(batch.sources[0]).id,
      checksum: hash(f.row.quote),
      start: 1,
      end: f.row.end,
      quote: f.row.quote.slice(1),
      author: "subject",
      about: "project",
      kind: "evaluation",
      stance: "endorsed",
      uncertainty: "",
      revision: 2,
      status: "candidate",
      context: [],
      judgedBy: "owner",
      runId: "old-run",
      provenanceStatus: "stale",
    });
    await writeFile(path.join(f.directory, "state.json"), JSON.stringify(batch.state));
    expect(
      selectEvidence((await batchEvidenceLoader(f.directory, "useful outcomes")()).packet).evidence,
    ).toHaveLength(0);
    await writeFile(
      path.join(f.directory, "L1", "evidence.jsonl"),
      JSON.stringify({ ...f.row, start: 1 }),
    );
    await expect(batchEvidenceLoader(f.directory, "useful outcomes")()).rejects.toThrow(
      "EVIDENCE_SOURCE_MISMATCH",
    );
    await writeFile(path.join(f.directory, "raw.json"), "[]");
    await expect(batchEvidenceLoader(f.directory, "useful outcomes")()).rejects.toThrow();
  });
});

describe("private bounded generation, audit, cache and revision", () => {
  it("defaults to dry run; zero relevant evidence terminates with no model conclusions", async () => {
    const p = packet();
    const dry = await run(p);
    expect(dry.status).toBe("dry_run");
    expect(dry.calls).toBe(0);
    p.question = "distant unmatched topic";
    const mock = mockGateway();
    const insufficient = await run(p, mock.gateway);
    expect(insufficient.status).toBe("insufficient_evidence");
    expect(mock.tasks).toHaveLength(0);
    expect((await record(insufficient.report_path)).record.candidate).toBeNull();
  });
  it("auditor receives FULL exact task/origin, selected facts/context and accepts a no-defect control", async () => {
    const p = packet();
    p.question = "Is this project criterion useful, without assuming distress?";
    const mock = mockGateway();
    const result = await run(p, mock.gateway);
    expect(result.status).toBe("ready_candidate");
    expect(mock.tasks).toHaveLength(2);
    expect(must(mock.tasks[1]).payload.question).toBe(p.question);
    expect(must(mock.tasks[1]).payload.question_origin).toBe("test_question");
    expect(must(mock.tasks[1]).payload.selection).toEqual(must(mock.tasks[0]).payload.selection);
    const r = await record(result.report_path);
    expect(must(r.record.candidate).tension).toBeNull();
    expect(must(r.record.candidate).question).toBeNull();
    expect(must(r.record.candidate).presented_problem).toBeNull();
    expect(await readFile(result.markdown_path, "utf8")).toContain("UTF16");
    expect((await stat(result.report_path)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(result.report_path))).mode & 0o777).toBe(0o700);
  });
  it("catches evaluator omission-of-task despite otherwise valid schema", async () => {
    const mock = mockGateway((phase, payload) =>
      phase === "analysis"
        ? candidate()
        : {
            ...auditFor(payload),
            task_checked: { question: "another question", question_origin: "test_question" },
          },
    );
    const result = await run(packet(), mock.gateway);
    expect(result.status).toBe("needs_review");
    expect((await record(result.report_path)).record.errors).toContain("AUDIT_OMITTED_EXACT_TASK");
  });
  it("retains invalid-reference raw privately, does not audit or make it current", async () => {
    const mock = mockGateway(() => {
      const c = candidate();
      must(must(c.observations[0]).basis[0]).evidence_id = "not-supplied";
      return c;
    });
    const result = await run(packet(), mock.gateway);
    expect(result.status).toBe("needs_review");
    expect(mock.tasks).toHaveLength(1);
    const raw = JSON.parse(
      await readFile(path.join(path.dirname(result.report_path), "analysis-raw.json"), "utf8"),
    );
    expect(raw.observations[0].basis[0].evidence_id).toBe("not-supplied");
    expect((await record(result.report_path)).record.candidate).toBeNull();
    expect(await readdir(path.dirname(path.dirname(result.report_path)))).not.toContain(
      "accepted.json",
    );
  });
  it("review rejection and provider timeout retain usage and require explicit retry", async () => {
    const out = await temp();
    const p = packet();
    const failed = mockGateway((phase, payload) =>
      phase === "analysis"
        ? candidate()
        : {
            ...auditFor(payload),
            issues: [
              {
                code: "manufactured_conflict",
                finding_id: null,
                evidence_ids: ["q0"],
                severity: "blocking",
                rationale: "Compatible conditions do not establish a costly tension.",
              },
            ],
          },
    );
    const first = await run(p, failed.gateway, { out });
    expect(first.status).toBe("needs_review");
    await expect(run(p, failed.gateway, { out })).rejects.toThrow(
      "FAILED_RUN_REQUIRES_EXPLICIT_RETRY",
    );
    const good = mockGateway();
    const second = await run(p, good.gateway, { out, retryFailed: true });
    expect(second.status).toBe("ready_candidate");
    expect(must((await record(first.report_path)).record.audit).issues).toHaveLength(1);
    const timeout = mockGateway(() => {
      throw new GatewayRequestError("timeout");
    });
    const timed = await run(p, timeout.gateway);
    const usage = (await record(timed.report_path)).record.usage;
    expect(timed.status).toBe("needs_review");
    expect(must(usage[0]).error).toBe("GATEWAY_TIMEOUT");
    expect(
      (must(usage[0]).provider_attempt as { usage: { inputTokens: number } }).usage.inputTokens,
    ).toBe(17);
  });
  it("bounds provider executions before attempts, including mandatory independent audit", async () => {
    const mock = mockGateway();
    const result = await run(packet(), mock.gateway, { maxCalls: 1 });
    expect(result.status).toBe("needs_review");
    expect(mock.tasks).toHaveLength(1);
    expect(result.calls).toBe(1);
    await expect(run(packet(), mock.gateway, { maxCalls: 5 })).rejects.toThrow(
      "INVALID_CALL_BUDGET",
    );
  });
  it("caches only accepted reports, makes no further calls and invalidates changed exclusion", async () => {
    const out = await temp();
    const p = packet();
    const mock = mockGateway();
    const first = await run(p, mock.gateway, { out });
    const second = await run(p, mock.gateway, { out });
    expect(second.cached).toBe(true);
    expect(second.calls).toBe(0);
    expect(mock.tasks).toHaveLength(2);
    must(p.sources[0]).excluded = true;
    must(p.sources[0]).review_revision++;
    const changed = await run(p, mock.gateway, { out });
    expect(changed.cached).toBe(false);
    expect(changed.key).not.toBe(first.key);
    expect(changed.status).toBe("insufficient_evidence");
  });
  it("refuses stale source mid-generation and source changes during cached reuse", async () => {
    const p = packet();
    const mock = mockGateway((phase, payload) => {
      if (phase === "audit") {
        must(p.sources[0]).review_revision++;
        return auditFor(payload);
      }
      return candidate();
    });
    const result = await run(p, mock.gateway);
    expect(result.status).toBe("stale");
    expect((await record(result.report_path)).record.errors).toContain(
      "SOURCE_CHANGED_BEFORE_PUBLICATION",
    );
    const out = await temp();
    const stable = packet();
    const good = mockGateway();
    await run(stable, good.gateway, { out });
    let reads = 0;
    const changingLoader: EvidenceLoader = async () => {
      reads++;
      const snapshot = await loader(stable)();
      if (reads === 2) snapshot.dependency_hash = "changed";
      return snapshot;
    };
    await expect(run(stable, good.gateway, { out, loader: changingLoader })).rejects.toThrow(
      "STALE_CACHE_SOURCE",
    );
  });
  it("checks prior hashes and rejects unvalidated/modified prior JSON", async () => {
    const mock = mockGateway();
    const result = await run(packet(), mock.gateway);
    expect((await readPrevious(result.report_path)).record.status).toBe("ready_candidate");
    const old = await record(result.report_path);
    must(old.record.candidate).headline = "tampered";
    const filename = path.join(await temp(), "tampered.json");
    await writeFile(filename, JSON.stringify(old));
    await expect(readPrevious(filename)).rejects.toThrow("INVALID_PREVIOUS_REPORT");
  });
  it("does not let weak format preference erase outcome criterion even with populated revision fields", async () => {
    const first = await run(packet(), mockGateway().gateway);
    const p = packet([
      "I value useful outcomes in this studio.",
      "I prefer useful outcomes formatted in short paragraphs in this studio.",
    ]);
    const mock = mockGateway((phase, payload) => {
      if (phase === "analysis")
        return revision(
          payload,
          "reversed",
          "Only short paragraphs matter here; outcomes do not.",
          ["q1"],
        );
      const audit = auditFor(payload);
      must(audit.revision_checks[0]).concrete_incompatibility = false;
      must(audit.revision_checks[0]).rationale =
        "Paragraph format is compatible with utility and cannot erase the old outcome criterion.";
      return audit;
    });
    const revised = await run(p, mock.gateway, { previous: first.report_path });
    expect(revised.status).toBe("needs_review");
    expect((await record(revised.report_path)).record.errors).toContain("UNSUPPORTED_REVISION");
    expect(must(mock.tasks[1]).payload.previous).toBeDefined();
    expect(must(mock.tasks[1]).payload.changes).toMatchObject({
      newly_disclosed_evidence_ids: ["q1"],
    });
  });
  it("accepts real same-context contradiction only when independent audit passes; older late disclosure remains older", async () => {
    const first = await run(packet(), mockGateway().gateway);
    const p = packet([
      "I value useful outcomes in this studio.",
      "I do not require useful outcomes for this same studio decision.",
    ]);
    const mock = mockGateway((phase, payload) =>
      phase === "analysis"
        ? revision(payload, "weakened", "Outcome criterion has a same-context exception.", ["q1"])
        : auditFor(payload),
    );
    const revised = await run(p, mock.gateway, { previous: first.report_path });
    expect(revised.status).toBe("ready_candidate");
    expect(
      must(must((await record(revised.report_path)).record.candidate).revisions[0]).chronology,
    ).toBe("old_fact_disclosed_late");
    const wrongChronology = mockGateway((phase, payload) =>
      phase === "analysis"
        ? revision(
            payload,
            "weakened",
            "Outcome criterion has a same-context exception.",
            ["q1"],
            "new_event",
          )
        : auditFor(payload),
    );
    const rejected = await run(p, wrongChronology.gateway, { previous: first.report_path });
    expect(rejected.status).toBe("needs_review");
    expect((await record(rejected.report_path)).record.errors).toContain(
      "LATE_DISCLOSURE_IS_NOT_NEW_EVENT",
    );
  });
  it("permits unchanged after new information and blocks same-input revision drift/stale target references", async () => {
    const first = await run(packet(), mockGateway().gateway);
    const p = packet([
      "I value useful outcomes in this studio.",
      "Another studio uses useful outcomes in a different format.",
    ]);
    must(p.sources[1]).project = "other-studio";
    const unchanged = mockGateway((phase, payload) =>
      phase === "analysis"
        ? revision(payload, "unchanged", "Useful outcomes matter in this studio.", ["q1"])
        : auditFor(payload),
    );
    expect((await run(p, unchanged.gateway, { previous: first.report_path })).status).toBe(
      "ready_candidate",
    );
    const drift = mockGateway((phase, payload) =>
      phase === "analysis"
        ? revision(payload, "expanded", "A broader personality conclusion.", [])
        : auditFor(payload),
    );
    const changed = await run(packet(), drift.gateway, { previous: first.report_path });
    expect((await record(changed.report_path)).record.errors).toContain("SAME_INPUT_DRIFT");
    const staleTarget = mockGateway(() => {
      const c = candidate();
      c.next_step = {
        target_key: "old-finding",
        text: "Do something",
        stop: "Stop when costly",
        constraints: "Permission required",
      };
      return c;
    });
    expect(
      (await record((await run(packet(), staleTarget.gateway)).report_path)).record.errors,
    ).toContain("STALE_TARGET");
  });
  it("allows schema-valid semantically wrong conflicts to be blocked by an isolated reviewer", async () => {
    const mock = mockGateway((phase, payload) => {
      if (phase === "analysis") {
        const c = candidate();
        c.tension = {
          kind: "actual_costly_tension",
          text: "Autonomy and permission are a personality conflict.",
          basis: must(c.observations[0]).basis,
        };
        return c;
      }
      return {
        ...auditFor(payload),
        issues: [
          {
            code: "manufactured_conflict",
            finding_id: null,
            evidence_ids: ["q0"],
            severity: "blocking",
            rationale:
              "Autonomy within permission constraints is compatible; no actual cost was supplied.",
          },
        ],
      };
    });
    expect((await run(packet(), mock.gateway)).status).toBe("needs_review");
  });
  it("validates CLI flags, absolute paths, typed task origin and exact packet question", async () => {
    expect(() => parseReasoningArgs(["--unknown"])).toThrow();
    expect(() =>
      parseReasoningArgs(["--packet", "relative", "--out", "/tmp/out", "--question", "q"]),
    ).toThrow();
    expect(() =>
      parseReasoningArgs([
        "--packet",
        "/tmp/input",
        "--out",
        "/tmp/out",
        "--question",
        "q",
        "--max-calls",
        "5",
      ]),
    ).toThrow();
    const filename = path.join(await temp(), "packet.json");
    await writeFile(filename, JSON.stringify(packet()));
    await expect(packetEvidenceLoader(filename, "another task")()).rejects.toThrow(
      "PACKET_QUESTION_MISMATCH",
    );
    await expect(
      run(packet(), undefined, { out: path.join(repoRoot, "should-not-create") }),
    ).rejects.toThrow("OUTSIDE_REPO_REQUIRED");
  });
});

describe("review regressions and bounded snapshots", () => {
  it("uses compatible transport schemas for an initial report without prior findings", () => {
    const schemas = [
      zodResponseFormat(reasoningCandidateSchema(["q0"]), "analysis"),
      zodResponseFormat(reasoningAuditSchema(["q0"], ["f1"], []), "audit"),
    ];
    expect(JSON.stringify(schemas)).not.toContain('"not":');
    expect(reasoningCandidateSchema(["q0"]).safeParse(candidate()).success).toBe(true);
  });
  it("coalesces canonical aliases even when both originals have different UUIDs", () => {
    const p = packet(["useful outcomes", "useful outcomes"]);
    must(p.sources[0]).source_uuid = "original-a";
    must(p.sources[1]).source_uuid = "original-b";
    must(p.evidence[1]).canonical_id = must(p.evidence[0]).canonical_id;
    const selected = selectEvidence(p);
    expect(selected.evidence).toHaveLength(1);
    expect(selected.counts.duplicates).toBe(1);
  });
  it("does not treat a changed ranking score or explanation as newly disclosed personal evidence", () => {
    const selected = selectEvidence(packet());
    const reranked = structuredClone(selected);
    must(reranked.evidence[0]).score += 10;
    must(reranked.evidence[0]).reason.push("different ranking metadata");
    expect(
      newlyDisclosed(reranked, {
        created_at: "2026-01-01T00:00:00Z",
        input_hash: "test",
        candidate: candidate(),
        findings: [],
        selection: selected,
      }),
    ).toEqual([]);
  });
  it("uses every explicitly supplied eligible fact even without lexical overlap", () => {
    const p = packet(["安静的周末很满足。", "报告只需一页即可。"], "合成材料的含义");
    expect(selectEvidence(p, { mode: "supplied" }).evidence).toHaveLength(2);
  });
  it("retains qualifiers for a distant second excerpt in one original message", () => {
    const first = "useful outcomes first";
    const second = "useful outcomes second";
    const qualifier = " unless specifically authorized";
    const text = first + " filler".repeat(200) + second + qualifier;
    const p = packet([text]);
    must(p.evidence[0]).quote = first;
    must(p.evidence[0]).end = first.length;
    p.evidence.push({
      ...must(p.evidence[0]),
      id: "second",
      canonical_id: "second",
      start: text.indexOf(second),
      end: text.indexOf(second) + second.length,
      quote: second,
    });
    expect(
      selectEvidence(p, { mode: "supplied" }).context.some((span) => span.text.includes(qualifier)),
    ).toBe(true);
  });
  it("blocks an excluded context interval even without a corresponding L1 row", async () => {
    const f = await frozen();
    f.row.end = 8;
    f.row.quote = "I prefer";
    await writeFile(path.join(f.directory, "L1/evidence.jsonl"), JSON.stringify(f.row));
    await new BatchStore(f.directory).update((batch) => {
      const source = must(batch.sources[0]);
      const quote = source.text.slice(10, 16);
      batch.state.candidates.push({
        id: "excluded-unindexed",
        sourceId: source.id,
        start: 10,
        end: 16,
        quote,
        author: "subject",
        about: "project",
        stance: "unknown",
        kind: "evaluation",
        uncertainty: "test",
        checksum: hash(quote),
        revision: 1,
        status: "excluded",
        context: [],
        contextSourceIds: [],
        provenanceStatus: "current",
        judgedBy: "owner",
        runId: "test",
      });
    });
    const loaded = await batchEvidenceLoader(f.directory, "prefer", "test_question")();
    expect(loaded.packet.question_origin).toBe("test_question");
    expect(must(loaded.packet.sources[0]).blocked_ranges).toEqual([{ start: 10, end: 16 }]);
    const selected = selectEvidence(loaded.packet, { mode: "supplied" });
    expect(selected.evidence).toHaveLength(1);
    expect(selected.context).toHaveLength(0);
  });
  it("loads the layer's unassigned project normalization", async () => {
    const f = await frozen();
    const raw = JSON.parse(await readFile(path.join(f.directory, "raw.json"), "utf8")) as Array<
      Record<string, unknown>
    >;
    must(raw[0]).project = null;
    const manifest = JSON.parse(
      await readFile(path.join(f.directory, "manifest.json"), "utf8"),
    ) as { sourceFingerprint: string; sessions: Array<Record<string, unknown>> };
    manifest.sourceFingerprint = hash(raw);
    must(manifest.sessions[0]).project = null;
    f.row.project = "unassigned";
    await writeFile(path.join(f.directory, "raw.json"), JSON.stringify(raw));
    await writeFile(path.join(f.directory, "manifest.json"), JSON.stringify(manifest));
    await writeFile(path.join(f.directory, "L1/evidence.jsonl"), JSON.stringify(f.row));
    const loaded = await batchEvidenceLoader(f.directory, "useful")();
    expect(must(loaded.packet.sources[0]).project).toBe("unassigned");
  });
  it("does not persist unselected corpus or send unused ranking pool into the model", async () => {
    const p = packet(["useful outcomes", "UNRELATED_PRIVATE_SENTINEL"]);
    must(p.sources[1]).split = "holdout";
    const mock = mockGateway();
    const result = await run(p, mock.gateway);
    const saved = await readFile(result.report_path, "utf8");
    expect(saved).not.toContain("UNRELATED_PRIVATE_SENTINEL");
    expect((await record(result.report_path)).record.snapshot.packet.sources).toHaveLength(1);
    expect(mock.tasks.every((t) => !(t.payload.selection as { pool: unknown[] }).pool.length)).toBe(
      true,
    );
  });
  it("requires an explicit retry for a reserved attempt interrupted before a terminal report", async () => {
    const p = packet();
    const out = await temp();
    const bad = mockGateway(() => {
      throw new GatewayRequestError("timeout");
    });
    const first = await run(p, bad.gateway, { out });
    const directory = path.dirname(path.dirname(first.report_path));
    await rm(first.report_path);
    await rm(path.join(directory, "failures.json"));
    const good = mockGateway();
    await expect(run(p, good.gateway, { out })).rejects.toThrow(
      "INTERRUPTED_RUN_REQUIRES_EXPLICIT_RETRY",
    );
    expect(good.tasks).toHaveLength(0);
    const retried = await run(p, good.gateway, { out, retryFailed: true });
    expect(retried.status).toBe("ready_candidate");
    expect(
      JSON.parse(await readFile(path.join(path.dirname(first.report_path), "usage.json"), "utf8")),
    ).toHaveLength(1);
  });
});

describe("revision declarations preserve meaning rather than duplicate generated prose", () => {
  it("derives unchanged text and duplicate proposition fields from their referenced IDs", async () => {
    const p = packet();
    const initial = await run(p, mockGateway().gateway);
    const before = await record(initial.report_path);
    p.sources.push(
      ...packet(["I read useful outcomes in a one-page report."]).sources.map((s) => ({
        ...s,
        id: "s1",
        message_id: "message1",
        group_id: "group1",
      })),
    );
    p.evidence.push(
      ...packet(["I read useful outcomes in a one-page report."]).evidence.map((e) => ({
        ...e,
        id: "q1",
        canonical_id: "canonical1",
        source_id: "s1",
      })),
    );
    const mock = mockGateway((phase, payload) =>
      phase === "audit"
        ? auditFor(payload)
        : revision(
            payload,
            "unchanged",
            "A generated paraphrase that must not replace the stored proposition.",
            ["q1"],
          ),
    );
    const result = await run(p, mock.gateway, { previous: initial.report_path });
    expect(result.status).toBe("ready_candidate");
    const saved = await record(result.report_path);
    expect(must(saved.record.candidate).observations[0]?.text).toBe(
      must(before.record.candidate).observations[0]?.text,
    );
    const raw = JSON.parse(
      await readFile(path.join(path.dirname(result.report_path), "analysis-raw.json"), "utf8"),
    ) as ReasoningCandidate;
    expect(raw.observations[0]?.text).toBe(
      "A generated paraphrase that must not replace the stored proposition.",
    );
  });
  it("does not let a correctness issue bypass publication by calling it a warning", async () => {
    const mock = mockGateway((phase, payload) => {
      if (phase === "analysis") return candidate();
      return {
        ...auditFor(payload),
        issues: [
          {
            code: "unsupported_claim",
            finding_id: must(payload.assigned_findings as { id: string }[])[0]?.id,
            evidence_ids: ["q0"],
            severity: "warning",
            rationale: "Different source groups do not establish independent events.",
          },
        ],
      };
    });
    const result = await run(packet(), mock.gateway);
    expect(result.status).toBe("needs_review");
    expect((await record(result.report_path)).record.errors).toContain("BLOCKING_SEMANTIC_ISSUES");
  });
});

it("does not silently re-enable L1 that was explicitly marked ineligible", async () => {
  const f = await frozen();
  f.row.eligible = false;
  await writeFile(path.join(f.directory, "L1/evidence.jsonl"), JSON.stringify(f.row));
  const loaded = await batchEvidenceLoader(f.directory, "useful")();
  expect(must(loaded.packet.evidence[0]).use).toBe("context");
  expect(candidateProblems(candidate(), selectEvidence(loaded.packet))).toContain(
    "INADMISSIBLE_BASIS",
  );
});

it("rejects an output inside the frozen source before creating or chmodding it", async () => {
  const f = await frozen();
  const output = path.join(f.directory, "must-not-create");
  await expect(prepareOutput(output, repoRoot, f.directory)).rejects.toThrow(
    "OUTPUT_INSIDE_SOURCE_BATCH",
  );
  await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});
