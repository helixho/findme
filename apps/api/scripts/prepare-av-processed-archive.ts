import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  archiveConnectorBatches,
  prepareProcessedArchive,
} from "../src/dogfood/processed-archive.js";

// Local preparation only. Transport must be separately authorized; no .env or DB clients.
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "prepare-av-processed-archive --batch ABS --u1 ABS --u2 ABS --tenant-id UUID --subject-id UUID --namespace NAME --out NEW_ABS_DIR",
    );
    return;
  }
  const values = new Map<string, string>();
  const keys = ["--batch", "--u1", "--u2", "--tenant-id", "--subject-id", "--namespace", "--out"];
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    const v = args[i + 1];
    if (!k || !v || !keys.includes(k) || values.has(k) || v.startsWith("--"))
      throw new Error("ARCHIVE_ARGUMENT_INVALID");
    values.set(k, v);
  }
  if (keys.some((k) => !values.has(k))) throw new Error("ARCHIVE_ARGUMENT_REQUIRED");
  const get = (k: string) => {
    const value = values.get(k);
    if (value === undefined) throw new Error("ARCHIVE_ARGUMENT_REQUIRED");
    return value;
  };
  const suppliedOut = get("--out");
  const repo = path.resolve(new URL("../../..", import.meta.url).pathname);
  const roots = { batch: get("--batch"), u1: get("--u1"), u2: get("--u2") };
  if (!path.isAbsolute(suppliedOut)) throw new Error("ABSOLUTE_OUTPUT_REQUIRED");
  const normalized = path.resolve(suppliedOut);
  const out = path.join(await realpath(path.dirname(normalized)), path.basename(normalized));
  if (
    [repo, ...Object.values(roots).map((p) => path.resolve(p))].some(
      (p) => out === p || out.startsWith(p + path.sep),
    )
  )
    throw new Error("NEW_PRIVATE_OUTPUT_OUTSIDE_SOURCES_AND_REPO_REQUIRED");
  const archive = await prepareProcessedArchive({
    roots,
    scope: { tenantId: get("--tenant-id"), subjectId: get("--subject-id") },
    namespace: get("--namespace"),
  });
  await mkdir(out, { recursive: false, mode: 0o700 });
  await writeFile(path.join(out, "archive.json"), JSON.stringify(archive), {
    flag: "wx",
    mode: 0o600,
  });
  const transactions = archiveConnectorBatches(archive);
  for (const [index, statements] of transactions.entries())
    await writeFile(
      path.join(out, `transaction-${String(index).padStart(3, "0")}.json`),
      JSON.stringify(statements),
      { flag: "wx", mode: 0o600 },
    );
  await writeFile(
    path.join(out, "transport-manifest.json"),
    JSON.stringify({
      batch_hash: archive.hash,
      transactions: transactions.length,
      sizes: transactions.map((b) => Buffer.byteLength(JSON.stringify(b))),
      uploaded: false,
    }),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      format: archive.manifest.format,
      batch_hash: archive.hash,
      artifacts: archive.manifest.artifacts.length,
      chunks: archive.chunks.length,
      bytes: archive.manifest.artifacts.reduce((n, a) => n + a.bytes, 0),
      excluded: archive.manifest.excluded.length,
      uploaded: false,
      model_calls: 0,
    }),
  );
}
main().catch((error) => {
  console.error(
    error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "ARCHIVE_PREPARATION_FAILED",
  );
  process.exitCode = 1;
});
