/** Decisions for cloud jobs only; report/run/attempt statuses have separate contracts. */
// Database status is text; unknown values retain the original conservative decisions.
export type CloudJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale"
  | "rejected";
type RecoveryJob = {
  status: string;
  leaseUntil: Date | null;
  error: string | null;
  callsUsed: number;
  callCap: number;
};

export function recoveryDecision(job: RecoveryJob, cap: number, serverCap: number, now: Date) {
  if (
    !["queued", "failed", "running"].includes(job.status) ||
    (job.status === "running" && job.leaseUntil && job.leaseUntil > now)
  )
    return { error: "EXPLICIT_RECOVERY_NOT_AVAILABLE" } as const;
  const exhausted =
    job.error === "JOB_CALL_CAP_EXHAUSTED" || job.error === "PROFILE_CALL_CAP_EXHAUSTED";
  if (
    job.error &&
    !exhausted &&
    !/^(PROVIDER_[A-Z_]+|INTERRUPTED|PROCESSING_FAILED)$/.test(job.error)
  )
    return { error: "NEW_INPUT_REQUIRED" } as const;
  if (cap > serverCap || cap < job.callsUsed || (exhausted && cap <= job.callCap))
    return { error: "JOB_BUDGET_INVALID" } as const;
  return { error: null, checkProfileBudget: exhausted } as const;
}

export function profileCapExhausted(callsUsed: number, limit: number) {
  return callsUsed >= limit;
}

export function jobReservationBlocked(
  job: { status: string; execution: string | null; callsUsed: number; callCap: number },
  execution: string,
) {
  return job.status !== "running" || job.execution !== execution || job.callsUsed >= job.callCap;
}

/** Explicit processing replaces cancelled/stale jobs, but preserves failed job identity. */
export function reuseProcessingJob(status: string) {
  return status !== "cancelled" && status !== "stale";
}

export function claimQueuedJob(status: string) {
  return status === "queued";
}

/** Enqueue/claim only commit stale for these exact freshness errors. */
export function invalidatesQueuedJob(code: string) {
  return /^(SOURCE_CHANGED|TOPIC_CHANGED|PROCESSING_VERSION_CHANGED)$/.test(code);
}

/** Execution failures intentionally use broader matching than queued freshness checks. */
export function processingFailureStatus(code: string) {
  return /SOURCE_CHANGED|TOPIC_CHANGED|VERSION_CHANGED/.test(code)
    ? "stale"
    : /AUDIT|QUALIFICATION_|REPORT_|REFERENCE|CONTEXT_/.test(code)
      ? "rejected"
      : "failed";
}
