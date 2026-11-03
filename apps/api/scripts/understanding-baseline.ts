import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BatchStore } from "../src/dogfood/store.js";
import { codexConfig, createCodexGateway } from "../src/llm/codex-cli.js";
import { createGateway } from "../src/llm/gateway.js";
import { pruneRejectedCandidate } from "../src/understanding-baseline/candidate-prune.js";
import { DOMAINS, type Domain } from "../src/understanding-baseline/prepare.js";
import {
  applyProviderMigration,
  providerMigrationPreflight,
} from "../src/understanding-baseline/provider-migration.js";
import {
  RecoveryPlan,
  executeRecovery,
  recoveryPreflight,
} from "../src/understanding-baseline/recovery.js";
import { runUnderstanding } from "../src/understanding-baseline/runner.js";
type UnderstandingProvider = "deepseek" | "codex";

function providerName(raw: string | undefined): UnderstandingProvider {
  const value = (raw ?? "deepseek").toLowerCase();
  if (value === "deepseek" || value === "ds" || value === "api") return "deepseek";
  if (value === "codex") return "codex";
  throw new Error("INVALID_PROVIDER");
}

function gatewayFor(provider: UnderstandingProvider) {
  if (provider === "codex") return createCodexGateway(codexConfig());
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const mx2BaseUrl =
    process.env.M_X2_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const deepseekModel = process.env.DEEPSEEK_MODEL;
  if (!deepseekKey || !deepseekModel) throw new Error("DEEPSEEK_CONFIGURATION_REQUIRED");
  try {
    const url = new URL(mx2BaseUrl);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error("DEEPSEEK_CONFIGURATION_INVALID");
  }
  return createGateway({ deepseekKey, mx2BaseUrl, deepseekModel });
}

export function parseUnderstandingArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
) {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = required(argv[i]);
    if (flags.has(flag) || values[flag] !== undefined) throw new Error("DUPLICATE_FLAG");
    if (
      [
        "--help",
        "--live",
        "--retry-failed",
        "--preflight",
        "--recovery-status",
        "--migrate-provider",
        "--prune-rejected-candidate",
      ].includes(flag)
    )
      flags.add(flag);
    else if (
      [
        "--batch",
        "--coverage",
        "--out",
        "--max-calls",
        "--topic",
        "--recovery-plan",
        "--provider",
        "--provider-call-cap",
      ].includes(flag)
    ) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("FLAG_VALUE_REQUIRED");
      values[flag] = value;
    } else throw new Error("UNKNOWN_FLAG");
  }
  if (flags.has("--help")) return { help: true as const };
  for (const flag of ["--batch", "--coverage", "--out"]) {
    if (!values[flag]) throw new Error("BATCH_COVERAGE_OUT_REQUIRED");
    if (!path.isAbsolute(required(values[flag]))) throw new Error("ABSOLUTE_PATH_REQUIRED");
  }
  if (values["--max-calls"] && !/^(?:[0-9]|[1-5][0-9]|6[0-9]|7[01])$/.test(values["--max-calls"]))
    throw new Error("MAX_CALLS_0_TO_71_REQUIRED");
  if (values["--provider-call-cap"] && !/^(?:[0-9]|1[0-9]|20)$/.test(values["--provider-call-cap"]))
    throw new Error("PROVIDER_CALL_CAP_0_TO_20_REQUIRED");
  if (Number(values["--max-calls"] ?? 40) > 40 && !flags.has("--retry-failed"))
    throw new Error("RECOVERY_BUDGET_REQUIRES_EXPLICIT_RETRY");
  if (values["--topic"] && !(values["--topic"] in DOMAINS)) throw new Error("UNKNOWN_TOPIC");
  if (values["--recovery-plan"] && !path.isAbsolute(values["--recovery-plan"]))
    throw new Error("ABSOLUTE_PATH_REQUIRED");
  if (flags.has("--migrate-provider") && flags.has("--live"))
    throw new Error("PROVIDER_MIGRATION_MUST_BE_SEPARATE_FROM_LIVE");
  if (flags.has("--prune-rejected-candidate") && flags.has("--live"))
    throw new Error("DETERMINISTIC_PRUNE_MUST_BE_SEPARATE_FROM_LIVE");
  if (flags.has("--prune-rejected-candidate") && !values["--topic"])
    throw new Error("DETERMINISTIC_PRUNE_TOPIC_REQUIRED");
  if (flags.has("--live") && values["--provider-call-cap"] === undefined)
    throw new Error("PROVIDER_CALL_CAP_REQUIRED_FOR_LIVE");
  if (
    values["--recovery-plan"] &&
    flags.has("--live") &&
    (!flags.has("--retry-failed") || !values["--max-calls"])
  )
    throw new Error("RECOVERY_REQUIRES_EXPLICIT_BUDGET_AND_RETRY");
  return {
    help: false as const,
    batch: required(values["--batch"]),
    coverage: required(values["--coverage"]),
    out: required(values["--out"]),
    live: flags.has("--live"),
    retryFailed: flags.has("--retry-failed"),
    maxCalls: Number(values["--max-calls"] ?? 40),
    topic: values["--topic"] as Domain | undefined,
    recoveryPlan: values["--recovery-plan"],
    preflight: flags.has("--preflight") || flags.has("--recovery-status"),
    requestedBudget:
      values["--max-calls"] === undefined ? undefined : Number(values["--max-calls"]),
    provider: providerName(values["--provider"] ?? env.FINDME_UNDERSTANDING_PROVIDER),
    migrateProvider: flags.has("--migrate-provider"),
    pruneRejectedCandidate: flags.has("--prune-rejected-candidate"),
    providerCallCap:
      values["--provider-call-cap"] === undefined
        ? undefined
        : Number(values["--provider-call-cap"]),
  };
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseUnderstandingArgs(argv);
  if (args.help) {
    console.log(
      `understanding:baseline --batch ABS --coverage ABS --out ABS [--provider deepseek|codex] [--migrate-provider|--prune-rejected-candidate] [--live --provider-call-cap 0..20] [--max-calls 0..40; explicit recovery <=71] [--retry-failed] [--topic DOMAIN] [--preflight|--recovery-status] [--recovery-plan ABS]; default dry-run and default provider deepseek. --migrate-provider and --prune-rejected-candidate are separate zero-call actions and cannot be combined with --live. Every real --live invocation requires an explicit --provider-call-cap. Preflight is filesystem read-only. Recovery requires a bound plan, existing ledger, explicit --live --retry-failed --max-calls, and enough cumulative budget for all affected stages. Recovery writes checkpoints only; full ordinary replay publishes through original completion gates. Existing parser support up to 71 is not an authorization to increase the recorded execution budget. Domains: ${Object.keys(DOMAINS).join(", ")}`,
    );
    return;
  }
  if (args.pruneRejectedCandidate) {
    console.log(
      JSON.stringify(
        await new BatchStore(args.out).locked(() =>
          pruneRejectedCandidate({
            out: args.out,
            batch: args.batch,
            coverage: args.coverage,
            domain: required(args.topic),
          }),
        ),
      ),
    );
    return;
  }
  if (args.migrateProvider) {
    const targetModel = gatewayFor(args.provider).describe("extraction_model").model;
    const action = () =>
      args.preflight
        ? providerMigrationPreflight({
            out: args.out,
            batch: args.batch,
            coverage: args.coverage,
            targetModel,
          })
        : applyProviderMigration({
            out: args.out,
            batch: args.batch,
            coverage: args.coverage,
            targetModel,
          });
    console.log(
      JSON.stringify(
        args.preflight ? await action() : await new BatchStore(args.out).locked(action),
      ),
    );
    return;
  }
  const plan = args.recoveryPlan
    ? RecoveryPlan.parse(JSON.parse(await readFile(args.recoveryPlan, "utf8")))
    : undefined;
  const recoveryGateway = plan ? gatewayFor(args.provider) : undefined;
  if (args.preflight || plan) {
    const preflight = await recoveryPreflight(
      args.out,
      plan,
      args.topic ? [args.topic] : undefined,
      args.requestedBudget,
      { batch: args.batch, coverage: args.coverage },
      recoveryGateway?.describe("extraction_model").model,
    );
    if (args.preflight || !args.live || !plan || !preflight.executable) {
      console.log(JSON.stringify(preflight));
      return;
    }
    // Verify the existing full snapshot and same qualified originals before acquiring a write lock.
    const { readBaseline } = await import("../src/understanding-app/read.js");
    const snapshot = await readBaseline({
      repoRoot: fileURLToPath(new URL("../../..", import.meta.url)),
      batch: args.batch,
      coverage: args.coverage,
      baselineDir: args.out,
      stateDir: `${args.out}-recovery-unused-state`,
    });
    const topic = snapshot.baseline.topics.find((t) => t.domain === plan.domain);
    if (!topic) throw new Error("RECOVERY_DOMAIN_MISSING");
    const gateway = required(recoveryGateway);
    console.log(
      JSON.stringify(
        await new BatchStore(args.out).locked(() =>
          executeRecovery({
            out: args.out,
            plan,
            requestedBudget: required(args.requestedBudget),
            maxCallsThisRun: args.providerCallCap,
            live: true,
            gateway,
            baseSelection: topic.recovery?.base_selection ?? topic.selection,
            fresh: snapshot.input.fresh,
          }),
        ),
      ),
    );
    return;
  }
  const gateway = args.live ? gatewayFor(args.provider) : undefined;
  console.log(
    JSON.stringify(
      await runUnderstanding({
        ...args,
        maxCallsThisRun: args.providerCallCap,
        gateway,
        repoRoot: fileURLToPath(new URL("../../..", import.meta.url)),
      }),
    ),
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      "U2_BASELINE_FAILED: inspect input integrity, private jobs and explicit retry requirements.",
    );
    process.exitCode = 1;
  });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("MISSING_REQUIRED_REFERENCE");
  return value;
}
