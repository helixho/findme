import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  prepareEvidencePacketImport,
  prepareExportRestore,
} from "../src/cloud-diagnostic/ingest-adapter.js";
// Explicit local conversion only; never imports credentials, connects a database or calls a model.
async function main() {
  const args = process.argv.slice(2);
  const get = (name: string) => args[args.indexOf(name) + 1];
  if (args.includes("--help")) {
    console.log(
      "prepare-core-ingest --input ABS --out NEW_ABS_DIR --namespace NAME [--restore-export]",
    );
    return;
  }
  const input = get("--input");
  const out = get("--out");
  const namespace = get("--namespace");
  if (
    !args.includes("--input") ||
    !args.includes("--out") ||
    !args.includes("--namespace") ||
    !input ||
    !out ||
    !namespace ||
    !path.isAbsolute(input) ||
    !path.isAbsolute(out)
  )
    throw new Error("ABSOLUTE_INPUT_OUTPUT_REQUIRED");
  const repo = path.resolve(new URL("../../..", import.meta.url).pathname);
  if (out === repo || out.startsWith(repo + path.sep))
    throw new Error("PRIVATE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  const raw = JSON.parse(await readFile(input, "utf8"));
  const result = args.includes("--restore-export")
    ? prepareExportRestore(raw, namespace)
    : await prepareEvidencePacketImport(raw, namespace);
  await mkdir(out, { recursive: false, mode: 0o700 });
  for (const [index, chunk] of result.chunks.entries())
    await writeFile(
      path.join(out, `batch-${String(index + 1).padStart(3, "0")}.json`),
      JSON.stringify(chunk, null, 2),
      { flag: "wx", mode: 0o600 },
    );
  const { chunks, ...manifest } = result;
  await writeFile(
    path.join(out, "manifest.json"),
    JSON.stringify({ ...manifest, batches: chunks.length, uploaded: false }, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  console.log(JSON.stringify({ batches: chunks.length, model_calls: 0, uploaded: false }));
}
main().catch(() => {
  console.error("CORE_INGEST_PREPARATION_FAILED");
  process.exitCode = 1;
});
