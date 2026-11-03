import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { batchEvidenceLoader, packetEvidenceLoader } from "../src/diagnostic-reasoning/evidence.js";
import { prepareOutput, runDiagnostic } from "../src/diagnostic-reasoning/runner.js";
import { codexConfig, createCodexGateway } from "../src/llm/codex-cli.js";

export function parseReasoningArgs(argv: string[]) {
  const values: Record<string, string> = {};
  const switches = new Set<string>();
  const flagNames = new Set(["--live", "--retry-failed", "--help"]);
  const valueNames = new Set([
    "--batch",
    "--packet",
    "--question",
    "--question-origin",
    "--out",
    "--project",
    "--before",
    "--previous",
    "--max-calls",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (
      !flag ||
      (!flagNames.has(flag) && !valueNames.has(flag)) ||
      switches.has(flag) ||
      values[flag] !== undefined
    )
      throw new Error("UNKNOWN_OR_DUPLICATE_FLAG");
    if (flagNames.has(flag)) switches.add(flag);
    else {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("FLAG_VALUE_REQUIRED");
      values[flag] = value;
    }
  }
  if (switches.has("--help")) return { help: true as const };
  if (
    Boolean(values["--batch"]) === Boolean(values["--packet"]) ||
    !values["--question"]?.trim() ||
    !values["--out"]
  )
    throw new Error("BATCH_OR_PACKET_QUESTION_OUT_REQUIRED");
  for (const flag of ["--batch", "--packet", "--out", "--previous"])
    if (values[flag] && !path.isAbsolute(values[flag])) throw new Error("ABSOLUTE_PATH_REQUIRED");
  const before = values["--before"];
  if (
    before &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(before) ||
      !Number.isFinite(Date.parse(before)))
  )
    throw new Error("ISO_BEFORE_REQUIRED");
  const questionOrigin = values["--question-origin"] ?? "user_request";
  if (!["user_request", "test_question"].includes(questionOrigin))
    throw new Error("QUESTION_ORIGIN_INVALID");
  const calls = values["--max-calls"];
  if (calls && !/^[1-4]$/.test(calls)) throw new Error("MAX_CALLS_1_TO_4_REQUIRED");
  return {
    help: false as const,
    batch: values["--batch"],
    packet: values["--packet"],
    question: values["--question"] as string,
    questionOrigin: questionOrigin as "user_request" | "test_question",
    out: values["--out"] as string,
    previous: values["--previous"],
    scope: {
      mode: values["--packet"] ? ("supplied" as const) : ("lexical" as const),
      ...(values["--project"] ? { project: values["--project"] } : {}),
      ...(before ? { before } : {}),
    },
    live: switches.has("--live"),
    retryFailed: switches.has("--retry-failed"),
    maxCalls: calls ? Number(calls) : 4,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseReasoningArgs(argv);
  if (args.help) {
    console.log(
      "diagnostic:reason --batch ABS | --packet ABS --question TEXT --out ABS [--question-origin user_request|test_question] [--project NAME] [--before ISO] [--previous ABS] [--live] [--retry-failed] [--max-calls 1..4]; default dry-run, private staging outputs only.",
    );
    return;
  }
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const sourcePath = await realpath(args.batch ?? args.packet ?? "");
  const sourceStat = await stat(sourcePath);
  if (args.batch ? !sourceStat.isDirectory() : !sourceStat.isFile())
    throw new Error("INPUT_PATH_TYPE");
  if (args.previous && !(await stat(args.previous)).isFile()) throw new Error("PREVIOUS_PATH_TYPE");
  // Never lock or write inside the frozen batch, even if it is outside the repository.
  const out = await prepareOutput(args.out, repoRoot, args.batch ? sourcePath : undefined);
  if (args.batch) {
    const relative = path.relative(sourcePath, out);
    if (
      !relative ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    )
      throw new Error("OUTPUT_INSIDE_SOURCE_BATCH");
  }
  let gateway: ReturnType<typeof createCodexGateway> | undefined;
  try {
    gateway = createCodexGateway(codexConfig());
  } catch {
    if (args.live) throw new Error("CODEX_CONFIGURATION_UNAVAILABLE");
  }
  const result = await runDiagnostic({
    ...args,
    repoRoot,
    out,
    gateway,
    loader: args.batch
      ? batchEvidenceLoader(sourcePath, args.question, args.questionOrigin)
      : packetEvidenceLoader(sourcePath, args.question),
  });
  // Paths/status/model/call count only: no raw question, corpus, draft or auditor response on stdout.
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      "DIAGNOSTIC_REASONING_FAILED: check flags, input integrity, private output records and explicit retry requirements.",
    );
    process.exitCode = 1;
  });
}
