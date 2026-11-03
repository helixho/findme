import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareUnderstandingImport } from "../src/cloud-diagnostic/understanding-import.js";

// Offline validation only: no database, credentials, network or model calls.
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("prepare-understanding-import --input ABS_JSON --out NEW_ABS_DIR");
    return;
  }
  const get = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const input = get("--input");
  const output = get("--out");
  if (!input || !output || !path.isAbsolute(input) || !path.isAbsolute(output))
    throw new Error("ABSOLUTE_PATHS_REQUIRED");
  const repo = await realpath(fileURLToPath(new URL("../../..", import.meta.url)));
  const parent = await realpath(path.dirname(output));
  const out = path.join(parent, path.basename(output));
  if (out === repo || out.startsWith(`${repo}${path.sep}`))
    throw new Error("PRIVATE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  if ((await stat(input)).size > 2 * 1024 * 1024) throw new Error("IMPORT_TOO_LARGE");
  const { bundle, input_hash, summary } = await prepareUnderstandingImport(
    JSON.parse(await readFile(input, "utf8")),
  );
  await mkdir(out, { recursive: false, mode: 0o700 });
  await writeFile(path.join(out, "bundle.json"), JSON.stringify(bundle, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    path.join(out, "manifest.json"),
    JSON.stringify({ input_hash, ...summary, uploaded: false }, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  console.log(JSON.stringify({ input_hash, ...summary, uploaded: false }));
}
main().catch(() => {
  console.error("UNDERSTANDING_IMPORT_PREPARATION_FAILED");
  process.exitCode = 1;
});
