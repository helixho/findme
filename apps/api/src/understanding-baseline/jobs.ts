import { readFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import type { createCodexGateway } from "../llm/codex-cli.js";
import {
  type GatewayAttemptInfo,
  type GatewayAttemptResult,
  GatewayRequestError,
  type createGateway,
} from "../llm/gateway.js";
import { atomic, digest, fail, inside, optionalJson, privateDirectory, sha256 } from "./io.js";
import { providerAttempt } from "./job-provider.js";
import { replayCompletedJob } from "./job-replay.js";
import {
  POLICY,
  PROMPTS,
  UnderstandingReport,
  normalizeReportTimes,
  reportTimeNormalizer,
} from "./policy.js";
import type { Selection } from "./prepare.js";
export type Attempt = {
  id: string;
  job: string;
  status: "reserved" | "ok" | "error" | "interrupted";
  timeout_ms: number;
  info: GatewayAttemptInfo | GatewayAttemptResult;
  usage: GatewayAttemptResult["usage"];
  error?: string;
};
export type Job<T> = {
  id: string;
  fingerprint: string;
  model?: string;
  lineage_model?: string;
  runtime_model?: string;
  status: "completed" | "failed";
  result?: T;
  result_hash?: string;
  error?: string;
  raw_file?: string;
  raw_sha256?: string;
  input_file?: string;
  input_sha256?: string;
  transform?: {
    version: string;
    raw_sha256: string;
    input_sha256: string;
    dependency_hash?: string;
  };
  projection_hash?: string;
  deterministic_transform?: {
    version: string;
    source_job: string;
    source_hash: string;
    removed_targets: string[];
    promoted_key?: string;
  };
};
export type JobOptions = {
  out: string;
  inputHash: string;
  /** Immutable model lineage used by already accepted/cacheable stages. */
  model: string;
  /** Explicit semantic continuation model for stages without an accepted lineage result. */
  continuationModel?: string;
  /** Actual runtime transport model; may differ only by an allowed Codex patch or equal continuationModel. */
  runtimeModel?: string;
  gateway?: ReturnType<typeof createCodexGateway> | ReturnType<typeof createGateway>;
  live?: boolean;
  retryFailed?: boolean;
  maxCalls: number;
  /** Per-invocation provider request ceiling; independent of cumulative ledger. */
  maxCallsThisRun?: number;
  technicalRetryJob?: string;
  fresh: () => Promise<void>;
};
export function codexPatchCompatible(recorded: string, runtime: string) {
  if (recorded === runtime) return true;
  const a = recorded.split(":");
  const b = runtime.split(":");
  if (a.length !== 5 || b.length !== 5 || a[0] !== "codex-cli" || b[0] !== "codex-cli")
    return false;
  const av = /^codex-cli (\d+)\.(\d+)\.(\d+)$/.exec(a[1] ?? "");
  const bv = /^codex-cli (\d+)\.(\d+)\.(\d+)$/.exec(b[1] ?? "");
  return Boolean(
    av &&
      bv &&
      av[1] === bv[1] &&
      av[2] === bv[2] &&
      a[2] === b[2] &&
      a[3] === b[3] &&
      a[4] === b[4],
  );
}

export async function jobRunner(options: JobOptions) {
  if (!Number.isSafeInteger(options.maxCalls) || options.maxCalls < 0 || options.maxCalls > 71)
    fail("MAX_CALLS_0_TO_71_REQUIRED");
  const jobsDir = path.join(options.out, "jobs");
  await privateDirectory(jobsDir);
  const usageFile = path.join(options.out, "usage.json");
  const saved = await optionalJson<{
    attempts: Attempt[];
    integrity: string;
  }>(usageFile);
  if (saved && digest(saved.attempts) !== saved.integrity) fail("USAGE_INTEGRITY");
  const attempts = saved?.attempts ?? [];
  const priorProgress = await optionalJson<{ max_calls: number }>(
    path.join(options.out, "progress.json"),
  );
  const recordedCap = Math.max(options.maxCalls, priorProgress?.max_calls ?? 0);
  if (!Number.isSafeInteger(recordedCap) || recordedCap > 71) fail("MAX_CALLS_0_TO_71_REQUIRED");
  if (new Set(attempts.map((a) => a.id)).size !== attempts.length) fail("DUPLICATE_ATTEMPT");
  for (const attempt of attempts) if (attempt.status === "reserved") attempt.status = "interrupted";
  let queue = Promise.resolve();
  const persist = () => {
    queue = queue.then(async () => {
      const snapshot = structuredClone(attempts);
      await atomic(usageFile, { attempts: snapshot, integrity: digest(snapshot) });
      await atomic(path.join(options.out, "progress.json"), {
        updated_at: new Date().toISOString(),
        calls_total: snapshot.length,
        max_calls: recordedCap,
        running: snapshot
          .filter((a) => a.status === "reserved")
          .map((a) => ({ id: a.id, job: a.job })),
        completed: snapshot.filter((a) => a.status === "ok").length,
        failed: snapshot.filter((a) => a.status === "error" || a.status === "interrupted").length,
      });
    });
    return queue;
  };
  await persist();
  const pending: {
    stage: string;
    job: string;
    reason: string;
  }[] = [];
  const usedJobs: {
    stage: string;
    job: string;
    status: string;
    model?: string;
  }[] = [];
  let callsThisRun = 0;
  const jobDomains = new Map<string, string>();
  const jobErrors = new Map<string, string>();
  // Retained failed output is an unpublished candidate, never a passed stage.
  // Revalidation can downgrade bad proposals to unknown before a NEW same-input audit.
  const repairErrors = [
    "REPAIR_AUTHOR_OR_USE_ESCALATION",
    "PROJECT_REPORT_PURPOSE_REQUIRED",
    "COMMAND_IS_NOT_PREFERENCE",
    "STANCE_ESCALATION",
    "CANONICAL_STANCE_CONFLICT",
    "DISPUTED_AUTHOR_NOT_PROMOTABLE",
    "REPAIR_EXACT_SPAN_INVALID",
    "REPAIR_ANCHOR_INVALID",
  ];
  const provenance = new Map<string, unknown>();
  const identity = (stage: keyof typeof PROMPTS, payload: unknown, model = options.model) => {
    const fingerprint = digest([options.inputHash, POLICY, PROMPTS[stage], model, stage, payload]);
    return { fingerprint, id: `${stage}-${fingerprint.slice(0, 32)}`, model };
  };
  const continuationModel =
    options.continuationModel && options.continuationModel !== options.model
      ? options.continuationModel
      : undefined;
  async function retained<T>(
    stage: keyof typeof PROMPTS,
    payload: unknown,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    allowed: string[],
  ) {
    await options.fresh();
    const { fingerprint, id } = identity(stage, payload);
    const cached = await optionalJson<Job<T>>(path.join(jobsDir, `${id}.json`));
    if (!cached || cached.status !== "failed" || !allowed.includes(cached.error ?? ""))
      return undefined;
    if (
      cached.id !== id ||
      cached.fingerprint !== fingerprint ||
      cached.result === undefined ||
      digest(cached.result) !== cached.result_hash ||
      !cached.raw_file
    )
      fail("RETAINED_CANDIDATE_INTEGRITY");
    const inputFile = path.join(jobsDir, `${id}-input.json`);
    if (cached.input_file && path.resolve(cached.input_file) !== inputFile)
      fail("RETAINED_INPUT_INTEGRITY");
    const inputBytes = await readFile(await inside(jobsDir, inputFile));
    const input = JSON.parse(inputBytes.toString()) as {
      fingerprint: string;
      input_hash: string;
      policy: string;
      prompt: string;
      model: string;
      payload: unknown;
    };
    if (
      input.fingerprint !== fingerprint ||
      input.input_hash !== options.inputHash ||
      input.policy !== POLICY ||
      input.model !== options.model ||
      input.prompt !== PROMPTS[stage] ||
      digest(input.payload) !== digest(payload) ||
      (cached.input_sha256 && cached.input_sha256 !== sha256(inputBytes))
    )
      fail("RETAINED_INPUT_INTEGRITY");
    const raw = await readFile(await inside(jobsDir, cached.raw_file));
    if (cached.raw_sha256 && cached.raw_sha256 !== sha256(raw)) fail("RETAINED_RAW_INTEGRITY");
    const parsed = schema.parse(JSON.parse(raw.toString()));
    if (digest(parsed) !== cached.result_hash) fail("RETAINED_RAW_INTEGRITY");
    await options.fresh();
    return {
      result: parsed,
      cached,
      id,
      fingerprint,
      rawHash: sha256(raw),
      inputHash: sha256(inputBytes),
    };
  }
  async function retainedRepair<T>(payload: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>) {
    const value = await retained("repair", payload, schema, repairErrors);
    if (value)
      usedJobs.push({ stage: "repair", job: value.id, status: "retained_unpublished_candidate" });
    return value?.result;
  }
  async function retainedAudit<T>(
    payload: unknown,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    validate: (result: T) => void,
  ) {
    const value = await retained("audit", payload, schema, ["SEMANTIC_AUDIT_REJECTED"]);
    if (!value) return undefined;
    try {
      validate(value.result);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "SEMANTIC_AUDIT_REJECTED") throw error;
      usedJobs.push({ stage: "audit", job: value.id, status: "retained_rejected_audit" });
      return value.result;
    }
    fail("RETAINED_AUDIT_NOT_REJECTED");
  }
  /** Audit feedback remains untrusted; only used to request a new report and NEW audit. */
  async function retainedReportAudit<T>(
    payload: unknown,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ) {
    const value = await retained("audit", payload, schema, [
      "SEMANTIC_AUDIT_REJECTED",
      "INCOMPLETE_SAME_INPUT_AUDIT",
      "UNKNOWN_AUDIT_REFERENCE",
    ]);
    if (!value) return undefined;
    usedJobs.push({
      stage: "audit",
      job: value.id,
      status: "rejected_report_audit_reference_only",
    });
    return {
      result: value.result,
      error: value.cached.error,
      job: value.id,
      fingerprint: value.fingerprint,
    };
  }
  async function seedDeterministic<T>(
    stage: keyof typeof PROMPTS,
    payload: unknown,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    validate: (result: T) => void,
    result: T,
    transform: {
      version: string;
      source_job: string;
      source_hash: string;
      removed_targets: string[];
      promoted_key?: string;
    },
  ) {
    await options.fresh();
    const jobModel = continuationModel ?? options.model;
    const { fingerprint, id } = identity(stage, payload, jobModel);
    const file = path.join(jobsDir, `${id}.json`);
    const existing = await optionalJson<Job<T>>(file);
    const parsed = schema.parse(result);
    validate(parsed);
    if (existing) {
      if (
        existing.status !== "completed" ||
        digest(existing.result) !== digest(parsed) ||
        digest(existing.deterministic_transform) !== digest(transform)
      )
        fail("DETERMINISTIC_JOB_CONFLICT");
      provenance.set(id, { deterministic_transform: existing.deterministic_transform });
      usedJobs.push({ stage, job: id, status: "deterministic_transform", model: jobModel });
      return parsed;
    }
    const inputFile = path.join(jobsDir, `${id}-input.json`);
    await atomic(inputFile, {
      fingerprint,
      input_hash: options.inputHash,
      policy: POLICY,
      prompt: PROMPTS[stage],
      model: jobModel,
      ...(jobModel !== options.model
        ? { lineage_model: options.model, provider_migration: "u2-continuation-model@1" }
        : {}),
      payload,
    });
    const rawFile = path.join(jobsDir, `${id}-deterministic-raw.txt`);
    await atomic(rawFile, JSON.stringify(parsed), true);
    await atomic(file, {
      id,
      fingerprint,
      model: jobModel,
      ...(jobModel !== options.model ? { lineage_model: options.model } : {}),
      status: "completed",
      result: parsed,
      result_hash: digest(parsed),
      raw_file: rawFile,
      raw_sha256: sha256(await readFile(rawFile)),
      input_file: inputFile,
      input_sha256: sha256(await readFile(inputFile)),
      deterministic_transform: transform,
    });
    provenance.set(id, { deterministic_transform: transform });
    usedJobs.push({ stage, job: id, status: "deterministic_transform", model: jobModel });
    return parsed;
  }

  async function job<T>(
    stage: keyof typeof PROMPTS,
    payload: unknown,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    validate: (result: T) => void = () => {},
    controls: { cacheOnly?: boolean; once?: boolean } = {},
  ) {
    await options.fresh();
    const p = payload as { selection?: Selection; analysis_input?: { selection?: Selection } };
    const domain = p.selection?.domain ?? p.analysis_input?.selection?.domain;
    let current = identity(stage, payload);
    let { fingerprint, id, model: jobModel } = current;
    let file = path.join(jobsDir, `${id}.json`);
    let cached = await optionalJson<Job<T>>(file);

    const registerCached = () => {
      if (domain) jobDomains.set(id, domain);
      if (cached?.status === "failed" && cached.error) jobErrors.set(id, cached.error);
      if (cached && (cached.fingerprint !== fingerprint || cached.id !== id))
        fail("JOB_FINGERPRINT_MISMATCH");
    };

    if (continuationModel) {
      const lineageState = { current, fingerprint, id, jobModel, file, cached };
      current = identity(stage, payload, continuationModel);
      ({ fingerprint, id, model: jobModel } = current);
      file = path.join(jobsDir, `${id}.json`);
      cached = await optionalJson<Job<T>>(file);
      registerCached();
      const continuationHit = await completed();
      if (continuationHit.found) return continuationHit.result;
      ({ current, fingerprint, id, jobModel, file, cached } = lineageState);
    }
    registerCached();
    const lineageHit = await completed();
    if (lineageHit.found) return lineageHit.result;
    const projection = await retainedProjection();
    if (projection.found) return projection.result;
    if (continuationModel) {
      current = identity(stage, payload, continuationModel);
      ({ fingerprint, id, model: jobModel } = current);
      file = path.join(jobsDir, `${id}.json`);
      cached = await optionalJson<Job<T>>(file);
      registerCached();
      const continuationHit = await completed();
      if (continuationHit.found) return continuationHit.result;
    }
    const failed =
      cached?.status === "failed" || attempts.some((a) => a.job === id && a.status !== "ok");
    const reason =
      options.maxCallsThisRun !== undefined && callsThisRun >= options.maxCallsThisRun
        ? "invocation_call_cap_exhausted"
        : failed && controls.once && id !== options.technicalRetryJob
          ? "bounded_revision_attempt_exhausted"
          : controls.cacheOnly
            ? "revision_requires_explicit_retry"
            : !options.live
              ? "dry_run"
              : !options.gateway
                ? "gateway_unavailable"
                : failed && !options.retryFailed
                  ? "explicit_retry_required"
                  : attempts.length >= options.maxCalls
                    ? "cumulative_call_budget_exhausted"
                    : null;
    if (reason) {
      pending.push({ stage, job: id, reason });
      usedJobs.push({ stage, job: id, status: "pending" });
      return undefined;
    }
    return execute();

    function completed() {
      return replayCompletedJob({
        cached,
        jobsDir,
        jobModel,
        options,
        payload,
        schema,
        validate,
        id,
        stage,
        provenance,
        usedJobs,
      });
    }

    async function retainedProjection() {
      // A serialization recovery is a separate projection; the failed job and ledger remain untouched.
      if (
        (stage === "topic" || stage === "overall") &&
        cached?.status === "failed" &&
        ["TIME_SCOPE_MISMATCH", "RELATION_TIME_MISMATCH"].includes(cached.error ?? "")
      ) {
        const value = await retained(stage, payload, schema, [
          "TIME_SCOPE_MISMATCH",
          "RELATION_TIME_MISMATCH",
        ]);
        if (value) {
          const result = schema.parse(
            normalizeReportTimes(
              UnderstandingReport.parse(value.result),
              (payload as { selection?: Selection }).selection,
            ),
          );
          let projectionValid = true;
          try {
            validate(result);
          } catch (error) {
            if (
              !(error instanceof Error) ||
              ![
                "TIME_SCOPE_MISMATCH",
                "RELATION_TIME_MISMATCH",
                "NODE_ATTRIBUTION_MISMATCH",
                "STANCE_ESCALATION",
                "CONTEXT_IS_NOT_PERSONAL_PROOF",
                "PLAN_IS_NOT_OUTCOME",
                "CONTEXT_NODE_ESCALATION",
                "RELATION_DOMAIN_RANGE",
                "RELATION_ENDPOINT_BASIS_MISMATCH",
              ].includes(error.message)
            )
              throw error;
            projectionValid = false;
          }
          if (projectionValid) {
            const transform = {
              version: reportTimeNormalizer(UnderstandingReport.parse(value.result)),
              raw_sha256: value.rawHash,
              input_sha256: value.inputHash,
              dependency_hash: digest(value.cached),
            };
            const projectionHash = digest([transform, result]);
            const projectionFile = path.join(jobsDir, `${id}-${transform.version}.json`);
            const prior = await optionalJson<Job<T>>(projectionFile);
            if (
              prior &&
              (prior.id !== id ||
                prior.fingerprint !== fingerprint ||
                digest(prior.result) !== prior.result_hash ||
                prior.projection_hash !== projectionHash ||
                digest([prior.transform, prior.result]) !== projectionHash)
            )
              fail("REPORT_PROJECTION_INTEGRITY");
            if (!prior)
              await atomic(projectionFile, {
                ...value.cached,
                status: "completed",
                error: undefined,
                result,
                result_hash: digest(result),
                transform,
                projection_hash: projectionHash,
                raw_sha256: value.rawHash,
                input_file: path.join(jobsDir, `${id}-input.json`),
                input_sha256: value.inputHash,
              });
            provenance.set(id, { transform, projection_hash: projectionHash });
            usedJobs.push({ stage, job: id, status: "normalized_retained_projection" });
            return { found: true as const, result };
          }
        }
      }
      return { found: false as const };
    }

    async function execute() {
      const expectedRuntimeModel = options.runtimeModel ?? jobModel;
      await atomic(path.join(jobsDir, `${id}-input.json`), {
        fingerprint,
        input_hash: options.inputHash,
        policy: POLICY,
        prompt: PROMPTS[stage],
        model: jobModel,
        ...(jobModel !== options.model
          ? { lineage_model: options.model, provider_migration: "u2-continuation-model@1" }
          : {}),
        ...(options.runtimeModel && options.runtimeModel !== jobModel
          ? { runtime_model: options.runtimeModel, transport_migration: "codex_cli_patch" }
          : {}),
        payload,
      });
      const timeout = options.retryFailed ? 180000 : 120000;
      const info: GatewayAttemptInfo = {
        route: "extraction_model",
        model: expectedRuntimeModel,
        attempt: 1,
        estimate: {
          method: "serialized_utf8_bytes_conservative",
          serializedUtf8Bytes: Buffer.byteLength(JSON.stringify(payload)),
          estimatedInputTokens: Buffer.byteLength(JSON.stringify(payload)),
        },
      };
      if (options.maxCallsThisRun !== undefined && callsThisRun >= options.maxCallsThisRun) {
        pending.push({ stage, job: id, reason: "invocation_call_cap_exhausted" });
        usedJobs.push({ stage, job: id, status: "pending", model: jobModel });
        return undefined;
      }
      if (attempts.length >= options.maxCalls) {
        pending.push({ stage, job: id, reason: "cumulative_call_budget_exhausted" });
        usedJobs.push({ stage, job: id, status: "pending" });
        return undefined;
      }
      const attempt: Attempt = {
        id: `attempt-${attempts.length + 1}`,
        job: id,
        status: "reserved",
        timeout_ms: timeout,
        info,
        usage: null,
      };
      attempts.push(attempt);
      callsThisRun++;
      await persist(); // Reservation precedes any provider call.
      const rawFile = path.join(jobsDir, `${id}-${attempt.id}-raw.txt`);
      const transport = providerAttempt({
        options,
        stage,
        payload,
        schema,
        timeout,
        expectedRuntimeModel,
        attempt,
        rawFile,
        persist,
      });
      let candidate: T | undefined;
      let rawCandidate: T | undefined;
      try {
        const result = await transport.request();
        rawCandidate = schema.parse(result);
        candidate = rawCandidate;
        if (stage === "topic" || stage === "overall")
          candidate = schema.parse(
            normalizeReportTimes(
              UnderstandingReport.parse(candidate),
              (payload as { selection?: Selection }).selection,
            ),
          );
        if (!transport.rawCaptured) fail("RAW_OUTPUT_NOT_CAPTURED");
        validate(candidate);
        await options.fresh();
        attempt.status = "ok";
        const transform =
          stage === "topic" || stage === "overall"
            ? {
                version: reportTimeNormalizer(UnderstandingReport.parse(rawCandidate)),
                raw_sha256: sha256(await readFile(await inside(jobsDir, rawFile))),
                input_sha256: sha256(await readFile(path.join(jobsDir, `${id}-input.json`))),
              }
            : undefined;
        const projectionHash = transform ? digest([transform, candidate]) : undefined;
        if (transform) provenance.set(id, { transform, projection_hash: projectionHash });
        await atomic(file, {
          transform,
          projection_hash: projectionHash,
          id,
          fingerprint,
          model: jobModel,
          ...(jobModel !== options.model ? { lineage_model: options.model } : {}),
          ...(options.runtimeModel && options.runtimeModel !== jobModel
            ? { runtime_model: options.runtimeModel }
            : {}),
          status: "completed",
          result: candidate,
          result_hash: digest(candidate),
          raw_file: rawFile,
          raw_sha256: sha256(await readFile(await inside(jobsDir, rawFile))),
          input_file: path.join(jobsDir, `${id}-input.json`),
          input_sha256: sha256(await readFile(path.join(jobsDir, `${id}-input.json`))),
        });
        usedJobs.push({ stage, job: id, status: "completed", model: jobModel });
        return candidate;
      } catch (error) {
        // Error strings never contain provider/private input. Semantic failures keep the parsed draft.
        const code =
          error instanceof GatewayRequestError
            ? error.kind === "quota"
              ? "PROVIDER_QUOTA_EXHAUSTED"
              : `PROVIDER_${error.kind.toUpperCase()}`
            : error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
              ? error.message
              : "STAGE_FAILED";
        attempt.status = "error";
        attempt.error = code;
        jobErrors.set(id, code);
        await atomic(file, {
          id,
          fingerprint,
          model: jobModel,
          ...(jobModel !== options.model ? { lineage_model: options.model } : {}),
          ...(options.runtimeModel && options.runtimeModel !== jobModel
            ? { runtime_model: options.runtimeModel }
            : {}),
          status: "failed",
          error: code,
          result: rawCandidate,
          result_hash: rawCandidate === undefined ? null : digest(rawCandidate),
          raw_file: rawFile,
          raw_sha256: transport.rawCaptured
            ? sha256(await readFile(await inside(jobsDir, rawFile)))
            : undefined,
          input_file: path.join(jobsDir, `${id}-input.json`),
          input_sha256: sha256(await readFile(path.join(jobsDir, `${id}-input.json`))),
        });
        pending.push({ stage, job: id, reason: code });
        usedJobs.push({ stage, job: id, status: "failed", model: jobModel });
        return undefined;
      } finally {
        transport.close();
        await persist();
      }
    }
  }
  return {
    job,
    seedDeterministic,
    retainedRepair,
    retainedAudit,
    retainedReportAudit,
    provenance: (stage: keyof typeof PROMPTS, payload: unknown) =>
      (continuationModel
        ? provenance.get(identity(stage, payload, continuationModel).id)
        : undefined) ?? provenance.get(identity(stage, payload).id),
    pending,
    attempts,
    usedJobs,
    reasonsForDomain: (domain: string) => pending.filter((p) => jobDomains.get(p.job) === domain),
    errorsForDomain: (domain: string) =>
      [...jobErrors].filter(([id]) => jobDomains.get(id) === domain).map(([, error]) => error),
    failedJobs: () => [...jobErrors].map(([job, error]) => ({ job, error })),
    get callsThisRun() {
      return callsThisRun;
    },
  };
}
