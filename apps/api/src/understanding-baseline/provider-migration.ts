import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadInputs } from "./input.js";
import { atomic, digest, fail, inside, optionalJson } from "./io.js";
import { codexPatchCompatible } from "./jobs.js";
import { POLICY, PROMPTS } from "./policy.js";

export const PROVIDER_MIGRATION_VERSION = "u2-provider-migration@1";
const Run = z
  .object({
    format: z.string(),
    batch: z.string(),
    coverage: z.string(),
    input_hash: z.string(),
    model: z.string(),
    continuation_model: z.string().optional(),
    provider_migration_hash: z.string().optional(),
    policy: z.string(),
    prompt_hash: z.string(),
  })
  .passthrough();

export async function providerMigrationPreflight(options: {
  out: string;
  batch: string;
  coverage: string;
  targetModel: string;
}) {
  const runPath = path.join(options.out, "run.json");
  const run = Run.parse(JSON.parse(await readFile(runPath, "utf8")));
  if (run.batch !== options.batch || run.coverage !== options.coverage)
    fail("PROVIDER_MIGRATION_SOURCE_PATH_MISMATCH");
  if (run.policy !== POLICY || run.prompt_hash !== digest(PROMPTS))
    fail("PROVIDER_MIGRATION_POLICY_CHANGED");
  const current = await loadInputs(options.batch, options.coverage);
  if (current.input_hash !== run.input_hash) fail("PROVIDER_MIGRATION_SOURCE_CHANGED");
  await current.fresh();
  if (options.targetModel === run.model || codexPatchCompatible(run.model, options.targetModel))
    fail("PROVIDER_MIGRATION_NOT_REQUIRED");
  if (run.continuation_model && run.continuation_model !== options.targetModel)
    fail("PROVIDER_MIGRATION_ALREADY_BOUND");

  const pointers: { name: string; pointer: any; published: number }[] = [];
  for (const name of ["latest-ready.json", "latest-partial.json"]) {
    const p = await optionalJson<any>(path.join(options.out, name));
    if (!p) continue;
    const published = (await stat(path.join(options.out, name))).mtimeMs;
    pointers.push({ name, pointer: p, published });
  }
  pointers.sort((a, b) => b.published - a.published);
  const pointer = pointers[0]?.pointer;
  if (!pointer || pointer.input_hash !== run.input_hash)
    fail("PROVIDER_MIGRATION_BASELINE_REQUIRED");
  const baselinePath = await inside(options.out, path.join(pointer.directory, "baseline.json"));
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  if (
    baseline.input_hash !== run.input_hash ||
    baseline.model !== run.model ||
    digest(baseline) !== pointer.version
  )
    fail("PROVIDER_MIGRATION_BASELINE_CHANGED");

  const migration = {
    format: PROVIDER_MIGRATION_VERSION,
    input_hash: run.input_hash,
    source_model: run.model,
    target_model: options.targetModel,
    policy: run.policy,
    prompt_hash: run.prompt_hash,
    preserve_completed_lineage: true,
    continuation_only: true,
  };
  const migrationHash = digest(migration);
  return {
    run,
    baseline_version: pointer.version,
    migration,
    migration_hash: migrationHash,
    already_applied:
      run.continuation_model === options.targetModel &&
      run.provider_migration_hash === migrationHash,
    calls_required: 0,
  };
}

export async function applyProviderMigration(options: {
  out: string;
  batch: string;
  coverage: string;
  targetModel: string;
}) {
  const preflight = await providerMigrationPreflight(options);
  if (preflight.already_applied) return preflight;
  await atomic(path.join(options.out, "provider-migration.json"), {
    ...preflight.migration,
    migration_hash: preflight.migration_hash,
  });
  await atomic(path.join(options.out, "run.json"), {
    ...preflight.run,
    continuation_model: options.targetModel,
    provider_migration_hash: preflight.migration_hash,
  });
  return { ...preflight, already_applied: true };
}

export async function verifyProviderMigration(
  out: string,
  run: {
    input_hash: string;
    model: string;
    continuation_model?: string;
    provider_migration_hash?: string;
    policy?: string;
    prompt_hash?: string;
  },
) {
  if (!run.continuation_model) return undefined;
  if (!run.provider_migration_hash) fail("PROVIDER_MIGRATION_PROOF_REQUIRED");
  const stored = await optionalJson<Record<string, unknown>>(
    path.join(out, "provider-migration.json"),
  );
  if (!stored) fail("PROVIDER_MIGRATION_PROOF_REQUIRED");
  const { migration_hash: storedHash, ...migration } = stored;
  if (
    storedHash !== run.provider_migration_hash ||
    digest(migration) !== run.provider_migration_hash ||
    migration.format !== PROVIDER_MIGRATION_VERSION ||
    migration.input_hash !== run.input_hash ||
    migration.source_model !== run.model ||
    migration.target_model !== run.continuation_model ||
    migration.policy !== run.policy ||
    migration.prompt_hash !== run.prompt_hash ||
    migration.preserve_completed_lineage !== true ||
    migration.continuation_only !== true
  )
    fail("PROVIDER_MIGRATION_PROOF_CHANGED");
  return migration;
}
