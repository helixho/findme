import { rm } from "node:fs/promises";
import path from "node:path";
import { UNDERSTANDING_VERSION } from "@findme/core";
import type { Inputs } from "./input.js";
import { atomic, digest, fail, optionalJson } from "./io.js";
import { codexPatchCompatible } from "./jobs.js";
import { POLICY, PROMPTS } from "./policy.js";
import { verifyProviderMigration } from "./provider-migration.js";
import type { UnderstandingOptions } from "./runner.js";
export async function registerUnderstandingRun(
  out: string,
  input: Inputs,
  options: UnderstandingOptions,
) {
  const runFile = path.join(out, "run.json");
  const prior = await optionalJson<{
    batch: string;
    coverage: string;
    input_hash: string;
    model: string;
    continuation_model?: string;
    provider_migration_hash?: string;
    runtime_model?: string;
    policy?: string;
    prompt_hash?: string;
  }>(runFile);
  if (prior && (prior.batch !== options.batch || prior.coverage !== options.coverage))
    fail("OUTPUT_BOUND_TO_DIFFERENT_SOURCES");
  const runtimeModel = options.gateway?.describe("extraction_model").model;
  if (prior?.continuation_model) await verifyProviderMigration(out, prior);
  const continuationModel = options.continuationModel ?? prior?.continuation_model;
  if (prior && options.continuationModel && prior.continuation_model !== options.continuationModel)
    fail("CONTINUATION_MODEL_NOT_APPLIED");
  const expectedSemanticModel = continuationModel ?? prior?.model;
  if (
    prior &&
    runtimeModel &&
    expectedSemanticModel &&
    runtimeModel !== expectedSemanticModel &&
    !codexPatchCompatible(expectedSemanticModel, runtimeModel)
  )
    fail("OUTPUT_MODEL_CHANGED");
  const model = prior?.model ?? runtimeModel ?? "dry_run_no_model";
  if (
    prior &&
    (prior.input_hash !== input.input_hash ||
      prior.policy !== POLICY ||
      prior.prompt_hash !== digest(PROMPTS))
  ) {
    await rm(path.join(out, "latest-ready.json"), { force: true });
    await rm(path.join(out, "latest-partial.json"), { force: true });
  }
  await atomic(runFile, {
    format: UNDERSTANDING_VERSION,
    batch: options.batch,
    coverage: options.coverage,
    input_hash: input.input_hash,
    model,
    ...(continuationModel ? { continuation_model: continuationModel } : {}),
    ...(prior?.provider_migration_hash
      ? { provider_migration_hash: prior.provider_migration_hash }
      : {}),
    runtime_model: runtimeModel ?? prior?.runtime_model ?? continuationModel ?? model,
    ...(runtimeModel &&
    expectedSemanticModel &&
    runtimeModel !== expectedSemanticModel &&
    codexPatchCompatible(expectedSemanticModel, runtimeModel)
      ? { transport_migration: "codex_cli_patch" }
      : {}),
    policy: POLICY,
    prompt_hash: digest(PROMPTS),
  });
  return { model, continuationModel, runtimeModel, expectedSemanticModel };
}
