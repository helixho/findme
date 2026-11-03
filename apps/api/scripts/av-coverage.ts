import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCoverage } from "../src/dogfood/content-coverage.js";
import { codexConfig, createCodexGateway } from "../src/llm/codex-cli.js";

export function parseCoverageArgs(argv: string[]) {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) throw new Error("FLAG_VALUE_REQUIRED");
    if (flags.has(arg) || values[arg] !== undefined) throw new Error("DUPLICATE_FLAG");
    if (["--live", "--retry-failed", "--help"].includes(arg)) flags.add(arg);
    else if (["--batch", "--out", "--max-calls"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("FLAG_VALUE_REQUIRED");
      values[arg] = value;
    } else throw new Error("UNKNOWN_FLAG");
  }
  if (flags.has("--help")) return { help: true as const };
  if (!values["--batch"] || !values["--out"]) throw new Error("BATCH_OUT_REQUIRED");
  if (![values["--batch"], values["--out"]].every(path.isAbsolute))
    throw new Error("ABSOLUTE_PATH_REQUIRED");
  if (values["--max-calls"] && !/^(?:[0-9]|[1-3][0-9]|4[0-4])$/.test(values["--max-calls"]))
    throw new Error("MAX_CALLS_0_TO_44_REQUIRED");
  if (Number(values["--max-calls"] ?? 40) > 40 && !flags.has("--retry-failed"))
    throw new Error("RECOVERY_BUDGET_REQUIRES_EXPLICIT_RETRY");
  return {
    help: false as const,
    batch: values["--batch"],
    out: values["--out"],
    live: flags.has("--live"),
    retryFailed: flags.has("--retry-failed"),
    maxCalls: Number(values["--max-calls"] ?? 40),
  };
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseCoverageArgs(argv);
  if (args.help) {
    console.log(
      "pnpm av:coverage --batch ABS --out ABS [--live] [--max-calls 0..40; explicit retry up to 44] [--retry-failed]; default inventory, immutable private staging versions.",
    );
    return;
  }
  const gateway = args.live ? createCodexGateway(codexConfig()) : undefined;
  const result = await runCoverage({
    ...args,
    gateway,
    repoRoot: fileURLToPath(new URL("../../..", import.meta.url)),
  });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.log(
      JSON.stringify({
        status: "error",
        code: "AV_COVERAGE_FAILED",
        detail:
          "Check flags, frozen integrity, private staging jobs and explicit retry requirements.",
      }),
    );
    process.exitCode = 1;
  });
}
