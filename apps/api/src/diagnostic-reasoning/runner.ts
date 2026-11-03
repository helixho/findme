import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import {
  EvidencePacket,
  type ReasoningAudit,
  type ReasoningCandidate,
  reasoningAuditSchema,
  reasoningCandidateSchema,
} from "@findme/core";
import { z } from "zod";
import type { CoreGateway } from "../core/llm.js";
import { hash } from "../dogfood/model.js";
import { BatchStore } from "../dogfood/store.js";
import {
  type GatewayAttemptInfo,
  type GatewayAttemptResult,
  GatewayRequestError,
} from "../llm/gateway.js";
import {
  type EvidenceLoader,
  type EvidenceSelection,
  type InputSnapshot,
  type RetrievalScope,
  selectEvidence,
} from "./evidence.js";
import {
  ANALYSIS_PROMPT,
  AUDIT_PROMPT,
  type AssignedFinding,
  POLICY,
  PROMPT,
  type PriorReport,
  assignFindings,
  auditProblems,
  candidateProblems,
  newlyDisclosed,
  normalizeRevisionDeclarations,
} from "./policy.js";
import {
  promptSelection,
  snapshotFingerprint,
  snapshotForSelection,
  validateSelectionSnapshot,
} from "./snapshots.js";

export type RunStatus =
  | "dry_run"
  | "insufficient_evidence"
  | "ready_candidate"
  | "needs_review"
  | "stale";
export type UsageReservation = {
  call: number;
  phase: "analysis" | "audit";
  status: "reserved" | "ok" | "error";
  provider_attempt: GatewayAttemptInfo | GatewayAttemptResult | null;
  error: string | null;
};
export type ReasoningRecord = {
  format: "diagnostic-reasoning-run@1";
  key: string;
  policy: string;
  prompt: string;
  model: ReturnType<CoreGateway["describe"]>;
  created_at: string;
  status: RunStatus;
  snapshot: InputSnapshot;
  input_hash: string;
  selection: EvidenceSelection;
  previous: ReportEnvelope | null;
  candidate: ReasoningCandidate | null;
  findings: AssignedFinding[];
  audit: ReasoningAudit | null;
  errors: string[];
  usage: UsageReservation[];
};
export type ReportEnvelope = { integrity: string; record: ReasoningRecord };
export type RunResult = {
  status: RunStatus;
  cached: boolean;
  report_path: string;
  markdown_path: string;
  key: string;
  selected: number;
  calls: number;
  model: ReasoningRecord["model"];
};
export type RunOptions = {
  loader: EvidenceLoader;
  out: string;
  repoRoot: string;
  gateway?: CoreGateway;
  live?: boolean;
  retryFailed?: boolean;
  maxCalls?: number;
  timeoutMs?: number;
  previous?: string;
  scope?: RetrievalScope;
};
const ROUTE = "observation_model";
const envelope = (record: ReasoningRecord): ReportEnvelope => ({ integrity: hash(record), record });
const asPrior = (report?: ReportEnvelope): PriorReport | undefined =>
  report?.record.candidate
    ? {
        created_at: report.record.created_at,
        input_hash: report.record.input_hash,
        candidate: report.record.candidate,
        findings: report.record.findings,
        selection: report.record.selection,
      }
    : undefined;

async function atomic(filename: string, value: unknown, text = false) {
  const tmp = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(text ? String(value) : JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, filename);
}
function privateRaw(filename: string, raw: unknown) {
  const tmp = `${filename}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600, flag: "wx" });
  renameSync(tmp, filename);
}
function contained(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
export async function prepareOutput(out: string, repoRoot: string, forbiddenRoot?: string) {
  if (!path.isAbsolute(out)) throw new Error("ABSOLUTE_OUTPUT_REQUIRED");
  const repo = await realpath(repoRoot);
  let ancestor = path.resolve(out);
  const suffix: string[] = [];
  while (true) {
    try {
      ancestor = await realpath(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("OUTPUT_PATH_INVALID");
      suffix.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error("OUTPUT_PATH_INVALID");
      ancestor = parent;
    }
  }
  const resolved = path.join(ancestor, ...suffix);
  if (contained(repo, resolved)) throw new Error("OUTSIDE_REPO_REQUIRED");
  if (forbiddenRoot && contained(await realpath(forbiddenRoot), resolved))
    throw new Error("OUTPUT_INSIDE_SOURCE_BATCH");
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  await chmod(resolved, 0o700);
  if (contained(repo, await realpath(resolved))) throw new Error("OUTSIDE_REPO_REQUIRED");
  return resolved;
}

/** Prior JSON is integrity/structure/reference/audit checked, not treated as an unquestionable fact. */
export function validateReport(value: unknown, depth = 0): ReportEnvelope {
  if (depth > 20) throw new Error("PRIOR_HISTORY_TOO_DEEP");
  const outer = z
    .object({ integrity: z.string().regex(/^[a-f0-9]{64}$/), record: z.record(z.unknown()) })
    .strict()
    .parse(value);
  if (hash(outer.record) !== outer.integrity) throw new Error("REPORT_INTEGRITY");
  const r = outer.record as unknown as ReasoningRecord;
  if (
    r.format !== "diagnostic-reasoning-run@1" ||
    ![POLICY, "diagnostic-evidence-policy@2"].includes(r.policy) ||
    ![PROMPT, "bounded-explanation-and-independent-audit@2"].includes(r.prompt) ||
    r.status !== "ready_candidate" ||
    !Number.isFinite(Date.parse(r.created_at)) ||
    !r.model ||
    typeof r.model.model !== "string" ||
    !Array.isArray(r.errors) ||
    r.errors.length
  )
    throw new Error("PRIOR_NOT_ACCEPTED");
  const packet = EvidencePacket.parse(r.snapshot.packet);
  if (
    typeof r.snapshot.dependency_hash !== "string" ||
    snapshotFingerprint(r.snapshot, r.selection) !== r.input_hash ||
    !validateSelectionSnapshot({ ...r.snapshot, packet }, r.selection)
  )
    throw new Error("REPORT_INPUT_INTEGRITY");
  const previous = r.previous ? validateReport(r.previous, depth + 1) : undefined;
  if (
    r.key !==
    hash({
      input: r.input_hash,
      policy: r.policy,
      prompt: r.prompt,
      model: r.model,
      prior: previous?.integrity ?? null,
      scope: r.selection.scope,
    })
  )
    throw new Error("REPORT_KEY_INTEGRITY");
  const prior = asPrior(previous);
  const candidate = reasoningCandidateSchema(
    r.selection.evidence.map((e) => e.id),
    prior?.findings.map((f) => f.id),
  ).parse(r.candidate);
  const findings = assignFindings(candidate, r.key);
  if (
    hash(findings) !== hash(r.findings) ||
    candidateProblems(candidate, r.selection, prior).length
  )
    throw new Error("REPORT_STRUCTURE");
  const audit = reasoningAuditSchema(
    r.selection.evidence.map((e) => e.id),
    findings.map((f) => f.id),
    prior?.findings.map((f) => f.id) ?? [],
  ).parse(r.audit);
  if (auditProblems(audit, candidate, r.selection, findings).length)
    throw new Error("REPORT_AUDIT");
  return outer as unknown as ReportEnvelope;
}
export async function readPrevious(filename: string) {
  if (!path.isAbsolute(filename)) throw new Error("ABSOLUTE_PREVIOUS_REQUIRED");
  try {
    return validateReport(JSON.parse(await readFile(filename, "utf8")));
  } catch {
    throw new Error("INVALID_PREVIOUS_REPORT");
  }
}

function markdown(r: ReasoningRecord) {
  const lines = [
    "# 本次取证分析",
    "",
    `状态：${r.status}。这是待本人评估的分析候选；审核状态不代表临床、人格准确性或实际效用。`,
    "",
    `本次问题（${r.selection.question_origin}）：${r.selection.question}`,
    "",
  ];
  if (r.status === "dry_run") lines.push("已完成有界取证计划；尚未调用分析或审核模型。", "");
  if (r.status === "insufficient_evidence")
    lines.push(
      "当前范围内没有词面相关证据，无法形成有依据的解释。可调整问题或明确范围后重试。",
      "",
    );
  if (["needs_review", "stale"].includes(r.status))
    lines.push("本次草稿未通过发布检查，请先处理列出的复核问题。", "");
  if (r.candidate) {
    const c = r.candidate;
    lines.push(
      `## ${c.headline}`,
      "",
      ...(c.presented_problem ? [c.presented_problem, ""] : []),
      c.reframe,
      "",
    );
    for (const f of [...c.observations, ...c.explanations]) {
      lines.push(
        `- ${f.text}（范围：${f.scope}；依据：${f.basis.map((b) => `${b.evidence_id}/${b.relation}`).join("、") || "未知"}）`,
      );
      if (f.alternatives.length) lines.push(`  其他解释：${f.alternatives.join("；")}`);
      lines.push(`  改变判断的条件：${f.would_change}`);
    }
    lines.push("");
    if (c.tension) lines.push(`条件关系（${c.tension.kind}）：${c.tension.text}`, "");
    if (c.question)
      lines.push(
        `关键补问：${c.question.text}`,
        "",
        ...c.question.branches.map((b) => `- ${b.answer} → ${b.consequence}`),
        "",
      );
    if (c.next_step)
      lines.push(
        `可选下一步：${c.next_step.text}`,
        "",
        `约束：${c.next_step.constraints}；停止条件：${c.next_step.stop}`,
        "",
      );
    if (c.revisions.length)
      lines.push(
        "## 判断修订",
        "",
        ...c.revisions.map(
          (rev) => `- ${rev.old_finding_id}：${rev.op}。${rev.rationale}（${rev.chronology}）`,
        ),
        "",
      );
    lines.push(...c.limitations.map((l) => `- ${l}`), "");
  }
  if (r.errors.length || r.audit?.issues.length)
    lines.push(
      "## 待复核事项",
      "",
      ...r.errors.map((e) => `- ${e}`),
      ...(r.audit?.issues.map((i) => `- ${i.severity}/${i.code}：${i.rationale}`) ?? []),
      "",
    );
  lines.push(
    "## 证据附录",
    "",
    `选中 ${r.selection.counts.selected} 条；相关候选 ${r.selection.counts.relevant} 条；省略 ${r.selection.counts.omitted} 条。${r.selection.counts.sessions} 个会话、${r.selection.counts.event_groups} 个事件组；同组不算独立验证。`,
    "",
  );
  for (const e of r.selection.evidence)
    lines.push(
      `### ${e.id}`,
      "",
      `原始会话 ${e.source.session_id} / 消息 ${e.source.message_id} / UUID ${e.source.source_uuid ?? "未知"}；项目 ${e.source.project || "未知"}；发生 ${e.source.occurred_at ?? "未知"}；披露 ${e.source.disclosed_at ?? "未知"}；UTF16 [${e.start}, ${e.end})；修订 ${e.source.revision}。`,
      "",
      `用途 ${e.use}；作者 ${e.content_author}；谈论对象 ${e.about}；立场 ${e.stance}；归属来源 ${e.provenance}。`,
      "",
      ...e.quote.split("\n").map((line) => `> ${line}`),
      "",
    );
  lines.push(
    "## 覆盖与用量",
    "",
    ...r.selection.limitations.map((l) => `- ${l}`),
    "",
    `模型：${r.model.model}。预留调用 ${r.usage.length} 次；底层请求数不可观测。字节估计与实际 usage 分别保存在 usage.json；缺失实际 usage 为 null。`,
    "",
  );
  return lines.join("\n");
}

export async function runDiagnostic(options: RunOptions): Promise<RunResult> {
  const maxCalls = options.maxCalls ?? 4;
  const timeoutMs = options.timeoutMs ?? 120000;
  if (
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 4 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  )
    throw new Error("INVALID_CALL_BUDGET");
  if (options.live && !options.gateway) throw new Error("LIVE_GATEWAY_REQUIRED");
  const out = await prepareOutput(options.out, options.repoRoot);
  return new BatchStore(out).locked(async () => {
    const loadedSnapshot = await options.loader();
    loadedSnapshot.packet = EvidencePacket.parse(loadedSnapshot.packet);
    const selection = selectEvidence(loadedSnapshot.packet, options.scope);
    const snapshot = snapshotForSelection(loadedSnapshot, selection);
    const previous = options.previous ? await readPrevious(options.previous) : undefined;
    const prior = asPrior(previous);
    const model = options.gateway?.describe(ROUTE) ?? {
      route: ROUTE,
      model: "not_resolved_dry_run",
    };
    const inputHash = snapshotFingerprint(snapshot, selection);
    const key = hash({
      input: inputHash,
      policy: POLICY,
      prompt: PROMPT,
      model,
      prior: previous?.integrity ?? null,
      scope: selection.scope,
    });
    const directory = path.join(out, key);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const acceptedPath = path.join(directory, "accepted.json");
    const readOptional = async (filename: string) => {
      try {
        return JSON.parse(await readFile(filename, "utf8")) as unknown;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error("OUTPUT_RECORD_INVALID");
      }
    };
    const cached = await readOptional(acceptedPath);
    if (cached) {
      const report = validateReport(cached);
      const fresh = await options.loader();
      if (snapshotFingerprint(fresh, selectEvidence(fresh.packet, options.scope)) !== inputHash)
        throw new Error("STALE_CACHE_SOURCE");
      if (report.record.key !== key || report.record.input_hash !== inputHash)
        throw new Error("CACHE_INTEGRITY");
      return {
        status: report.record.status,
        cached: true,
        report_path: acceptedPath,
        markdown_path: path.join(directory, "accepted.md"),
        key,
        selected: selection.evidence.length,
        calls: 0,
        model,
      };
    }
    // A crash can leave a billed reservation before failures.json exists.
    for (const name of await readdir(directory)) {
      if (!name.startsWith("attempt-")) continue;
      const usage = await readOptional(path.join(directory, name, "usage.json"));
      const finished = await readOptional(path.join(directory, name, "report.json"));
      if (Array.isArray(usage) && usage.length > 0 && !finished) {
        if (options.live && !options.retryFailed)
          throw new Error("INTERRUPTED_RUN_REQUIRES_EXPLICIT_RETRY");
        if (options.live)
          await atomic(path.join(directory, name, "interrupted.json"), {
            status: "interrupted",
            usage_preserved: true,
          });
      }
    }
    const failurePath = path.join(directory, "failures.json");
    const failureValue = await readOptional(failurePath);
    const failures = failureValue === null ? [] : z.array(z.string()).parse(failureValue);
    if (options.live && failures.length && !options.retryFailed)
      throw new Error("FAILED_RUN_REQUIRES_EXPLICIT_RETRY");
    const attemptDirectory = path.join(directory, `attempt-${randomUUID()}`);
    await mkdir(attemptDirectory, { mode: 0o700 });
    const record: ReasoningRecord = {
      format: "diagnostic-reasoning-run@1",
      key,
      policy: POLICY,
      prompt: PROMPT,
      model,
      created_at: new Date().toISOString(),
      status: "dry_run",
      snapshot,
      input_hash: inputHash,
      selection,
      previous: previous ?? null,
      candidate: null,
      findings: [],
      audit: null,
      errors: [],
      usage: [],
    };
    await atomic(path.join(attemptDirectory, "input.json"), {
      snapshot,
      selection,
      previous: previous ?? null,
      policy: POLICY,
      prompt: PROMPT,
      model,
    });
    const persistUsage = () => atomic(path.join(attemptDirectory, "usage.json"), record.usage);
    await persistUsage();
    const call = async <T>(
      phase: "analysis" | "audit",
      text: string,
      system: string,
      schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    ) => {
      if (record.usage.length >= maxCalls) throw new Error("CALL_BUDGET_EXHAUSTED");
      const reservation: UsageReservation = {
        call: record.usage.length + 1,
        phase,
        status: "reserved",
        provider_attempt: null,
        error: null,
      };
      record.usage.push(reservation);
      await persistUsage(); // budget counted and durably reserved before provider execution
      let observed = false;
      let active = true;
      let captured = false;
      const capture = z.preprocess((raw) => {
        if (!active) throw new Error("EXPIRED_PROVIDER_OUTPUT");
        captured = true;
        // Sync atomic write occurs BEFORE any reference/schema/semantic check.
        privateRaw(path.join(attemptDirectory, `${phase}-raw.json`), raw);
        return raw;
      }, schema);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const request = options.gateway?.extract({
          route: ROUTE,
          text,
          system,
          schema: capture,
          controls: {
            retries: 0,
            timeoutMs,
            maxOutputTokens: phase === "analysis" ? 4000 : 2500,
            captureRawOutput: async (raw) => {
              if (!active) throw new Error("EXPIRED_PROVIDER_OUTPUT");
              await atomic(path.join(attemptDirectory, `${phase}-transport.txt`), raw, true);
            },
            observer: {
              beforeAttempt: async (info) => {
                if (!active || observed) throw new Error("UNEXPECTED_PROVIDER_RETRY");
                const reservedInput = record.usage.reduce(
                  (sum, entry) =>
                    sum + (entry.provider_attempt?.estimate.estimatedInputTokens ?? 0),
                  0,
                );
                if (reservedInput + info.estimate.estimatedInputTokens > 200000)
                  throw new Error("INPUT_BUDGET_EXHAUSTED");
                observed = true;
                reservation.provider_attempt = info;
                await persistUsage();
              },
              afterAttempt: async (info) => {
                reservation.provider_attempt = info;
                await persistUsage();
              },
            },
          },
        });
        if (!request) throw new Error("LIVE_GATEWAY_REQUIRED");
        const result = await Promise.race([
          request,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new GatewayRequestError("timeout")), timeoutMs);
          }),
        ]);
        // Injectable gateways must also parse the supplied transport, regardless of their implementation.
        if (!captured) privateRaw(path.join(attemptDirectory, `${phase}-raw.json`), result);
        const parsed = schema.parse(result);
        reservation.status = "ok";
        await persistUsage();
        return parsed;
      } catch (error) {
        reservation.status = "error";
        reservation.error =
          error instanceof GatewayRequestError
            ? `GATEWAY_${error.kind.toUpperCase()}`
            : "PROVIDER_OR_OUTPUT_FAILURE";
        await persistUsage();
        throw new Error(reservation.error);
      } finally {
        active = false;
        if (timer) clearTimeout(timer);
      }
    };
    if (!selection.evidence.length) record.status = "insufficient_evidence";
    else if (options.live) {
      record.status = "needs_review";
      try {
        const candidateSchema = reasoningCandidateSchema(
          selection.evidence.map((e) => e.id),
          prior?.findings.map((f) => f.id),
        );
        // Audit gets the same entire task and selected labels/context, not a reduced summary.
        const task = {
          question: selection.question,
          question_origin: selection.question_origin,
          selection: promptSelection(selection),
          // Old claims are revision targets, not a second copy of old original evidence.
          previous: prior
            ? {
                created_at: prior.created_at,
                input_hash: prior.input_hash,
                findings: prior.findings,
              }
            : null,
          changes: {
            newly_disclosed_evidence_ids: newlyDisclosed(selection, prior),
            source_dependency_changed: previous
              ? previous.record.snapshot.dependency_hash !== snapshot.dependency_hash
              : false,
          },
        };
        const generatedCandidate = await call(
          "analysis",
          JSON.stringify(task),
          ANALYSIS_PROMPT,
          candidateSchema,
        );
        const candidate = normalizeRevisionDeclarations(generatedCandidate, prior);
        record.candidate = candidate;
        record.findings = assignFindings(candidate, key);
        record.errors.push(...candidateProblems(candidate, selection, prior));
        if (!record.errors.length) {
          const auditSchema = reasoningAuditSchema(
            selection.evidence.map((e) => e.id),
            record.findings.map((f) => f.id),
            prior?.findings.map((f) => f.id) ?? [],
          );
          record.audit = await call(
            "audit",
            JSON.stringify({ ...task, candidate, assigned_findings: record.findings }),
            AUDIT_PROMPT,
            auditSchema,
          );
          record.errors.push(...auditProblems(record.audit, candidate, selection, record.findings));
          if (!record.errors.length) record.status = "ready_candidate";
        }
      } catch (error) {
        const safe =
          error instanceof Error &&
          /^GATEWAY_(TIMEOUT|PROVIDER|JSON_PARSE|SCHEMA_VALIDATION)$/.test(error.message)
            ? error.message
            : "CALL_OR_VALIDATION_FAILED";
        record.errors.push(safe);
      }
    }
    // Conservative dependency hash check is also required for dry/insufficient outputs and cache reads.
    try {
      const fresh = await options.loader();
      if (snapshotFingerprint(fresh, selectEvidence(fresh.packet, options.scope)) !== inputHash) {
        record.status = "stale";
        record.errors.push("SOURCE_CHANGED_BEFORE_PUBLICATION");
      }
    } catch {
      record.status = "stale";
      record.errors.push("SOURCE_RECHECK_FAILED");
    }
    const reportPath = path.join(attemptDirectory, "report.json");
    const markdownPath = path.join(attemptDirectory, "report.md");
    await atomic(reportPath, envelope(record));
    await atomic(markdownPath, markdown(record), true);
    if (record.status === "ready_candidate") {
      // Validate the artifact we will publish, not merely the operation that wrote it.
      validateReport(JSON.parse(await readFile(reportPath, "utf8")));
      await atomic(path.join(directory, "accepted.md"), markdown(record), true);
      await atomic(acceptedPath, envelope(record));
    } else if (["needs_review", "stale"].includes(record.status)) {
      await atomic(failurePath, [...failures, path.basename(attemptDirectory)]);
    }
    return {
      status: record.status,
      cached: false,
      report_path: reportPath,
      markdown_path: markdownPath,
      key,
      selected: selection.evidence.length,
      calls: record.usage.length,
      model,
    };
  });
}
