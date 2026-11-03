import { readFile } from "node:fs/promises";
import type { z } from "zod";
import { digest, fail, inside, sha256 } from "./io.js";
import type { Job, JobOptions } from "./jobs.js";
import {
  type PROMPTS,
  UnderstandingReport,
  isReportTimeNormalizer,
  normalizeReportTimes,
} from "./policy.js";
import type { Selection } from "./prepare.js";
export async function replayCompletedJob<T>(context: {
  cached: Job<T> | undefined;
  jobsDir: string;
  jobModel: string;
  options: JobOptions;
  payload: unknown;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  validate: (result: T) => void;
  id: string;
  stage: keyof typeof PROMPTS;
  provenance: Map<string, unknown>;
  usedJobs: { stage: string; job: string; status: string; model?: string }[];
}): Promise<{ found: false } | { found: true; result: T }> {
  const {
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
  } = context;
  if (cached?.status !== "completed") return { found: false };
  if (digest(cached.result) !== cached.result_hash) fail("JOB_RESULT_INTEGRITY");
  if (!cached.raw_file || !cached.raw_sha256 || !cached.input_file || !cached.input_sha256)
    fail("JOB_ARTIFACT_MANIFEST_MISSING");
  for (const [artifact, expected] of [
    [cached.raw_file, cached.raw_sha256],
    [cached.input_file, cached.input_sha256],
  ]) {
    const bytes = await readFile(await inside(jobsDir, required(artifact)));
    if (sha256(bytes) !== expected) fail("JOB_ARTIFACT_INTEGRITY");
  }
  const inputBytes = await readFile(await inside(jobsDir, cached.input_file));
  const input = JSON.parse(inputBytes.toString()) as {
    model?: string;
    lineage_model?: string;
  };
  if (input.model !== jobModel) fail("JOB_INPUT_MODEL_MISMATCH");
  if (jobModel !== options.model && input.lineage_model !== options.model)
    fail("JOB_LINEAGE_MODEL_MISMATCH");
  if (cached.transform) {
    if (
      !isReportTimeNormalizer(cached.transform.version) ||
      cached.transform.raw_sha256 !== cached.raw_sha256 ||
      cached.transform.input_sha256 !== cached.input_sha256 ||
      digest([cached.transform, cached.result]) !== cached.projection_hash
    )
      fail("REPORT_PROJECTION_INTEGRITY");
    const rawResult = schema.parse(
      JSON.parse(await readFile(await inside(jobsDir, cached.raw_file), "utf8")),
    );
    if (
      digest(
        normalizeReportTimes(
          UnderstandingReport.parse(rawResult),
          (payload as { selection?: Selection }).selection,
          cached.transform.version,
        ),
      ) !== cached.result_hash
    )
      fail("REPORT_PROJECTION_INTEGRITY");
    provenance.set(id, {
      transform: cached.transform,
      projection_hash: cached.projection_hash,
    });
  }
  if (cached.deterministic_transform)
    provenance.set(id, { deterministic_transform: cached.deterministic_transform });
  const result = schema.parse(cached.result);
  validate(result);
  await options.fresh();
  usedJobs.push({ stage, job: id, status: "completed", model: jobModel });
  return { found: true, result };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("MISSING_REQUIRED_REFERENCE");
  return value;
}
