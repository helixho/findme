import path from "node:path";
import { digest, fail, optionalJson } from "./io.js";
import type { Job } from "./jobs.js";
import type { Checkpoint } from "./recovery.js";
export async function technicalRetryable(out: string, checkpoint?: Checkpoint) {
  if (checkpoint?.status !== "failed" || !checkpoint.failed_job) return false;
  const job = await optionalJson<Job<unknown>>(
    path.join(out, "jobs", `${checkpoint.failed_job}.json`),
  );
  if (
    !job ||
    job.status !== "failed" ||
    job.error !== "STAGE_FAILED" ||
    job.result !== undefined ||
    job.raw_sha256
  )
    return false;
  const usage = await optionalJson<{
    attempts: { job: string; status: string; error?: string; info?: { model?: string } }[];
    integrity: string;
  }>(path.join(out, "usage.json"));
  if (!usage || digest(usage.attempts) !== usage.integrity) fail("USAGE_INTEGRITY");
  return (
    usage.attempts.filter(
      (a) => a.job === checkpoint.failed_job && a.status === "error" && a.error === "STAGE_FAILED",
    ).length === 1
  );
}

export async function unclassifiedTransportDiagnosticRetryable(
  out: string,
  checkpoint: Checkpoint | undefined,
) {
  if (
    checkpoint?.status !== "failed" ||
    checkpoint.diagnostic_transport_retry_used ||
    !checkpoint.failed_job
  )
    return false;
  const job = await optionalJson<Job<unknown>>(
    path.join(out, "jobs", `${checkpoint.failed_job}.json`),
  );
  if (
    !job ||
    job.status !== "failed" ||
    job.error !== "STAGE_FAILED" ||
    job.result !== undefined ||
    job.raw_sha256
  )
    return false;
  const usage = await optionalJson<{
    attempts: {
      job: string;
      status: string;
      error?: string;
      usage?: unknown;
      info?: { errorKind?: string | null };
    }[];
    integrity: string;
  }>(path.join(out, "usage.json"));
  if (!usage || digest(usage.attempts) !== usage.integrity) fail("USAGE_INTEGRITY");
  const failed = usage.attempts.filter((a) => a.job === checkpoint.failed_job);
  return (
    failed.length > 0 &&
    failed.every(
      (a) =>
        a.status === "error" &&
        a.error === "STAGE_FAILED" &&
        a.usage == null &&
        a.info?.errorKind === "provider",
    )
  );
}

export async function transportMigrationRetryable(
  out: string,
  checkpoint: Checkpoint | undefined,
  runtimeModel: string | undefined,
) {
  if (!runtimeModel || checkpoint?.status !== "failed" || !checkpoint.failed_job) return false;
  const job = await optionalJson<Job<unknown>>(
    path.join(out, "jobs", `${checkpoint.failed_job}.json`),
  );
  if (
    !job ||
    job.status !== "failed" ||
    job.error !== "STAGE_FAILED" ||
    job.result !== undefined ||
    job.raw_sha256
  )
    return false;
  const usage = await optionalJson<{
    attempts: { job: string; status: string; error?: string; info?: { model?: string } }[];
    integrity: string;
  }>(path.join(out, "usage.json"));
  if (!usage || digest(usage.attempts) !== usage.integrity) fail("USAGE_INTEGRITY");
  const failed = usage.attempts.filter(
    (a) => a.job === checkpoint.failed_job && a.status === "error" && a.error === "STAGE_FAILED",
  );
  return failed.length > 0 && !failed.some((a) => a.info?.model === runtimeModel);
}
