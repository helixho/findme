import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  archiveConnectorBatches,
  prepareRuntimeArchive,
  verifyProcessedArchive,
} from "../src/dogfood/processed-archive.js";
import {
  type UnderstandingRuntimeSnapshot,
  validateRuntimeSnapshot,
} from "../src/understanding-app/archive-runtime.js";
import { readBaseline } from "../src/understanding-app/read.js";
import { PrivateUnderstandingRepository } from "../src/understanding-app/repository.js";
import { reportObjects } from "../src/understanding-baseline/policy.js";

async function main() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  const keys = [
    "--repo-root",
    "--batch",
    "--coverage",
    "--baseline-dir",
    "--state-dir",
    "--source-archive",
    "--tenant-id",
    "--subject-id",
    "--out",
  ];
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    const v = args[i + 1];
    if (!k || !v || !keys.includes(k) || values.has(k)) throw Error("ARGUMENT_INVALID");
    values.set(k, v);
  }
  if (keys.some((k) => !values.has(k))) throw Error("ARGUMENT_REQUIRED");
  const get = (k: string) => {
    const value = values.get(k);
    if (value === undefined) throw Error("ARGUMENT_REQUIRED");
    return value;
  };
  const options = {
    repoRoot: get("--repo-root"),
    batch: get("--batch"),
    coverage: get("--coverage"),
    baselineDir: get("--baseline-dir"),
    stateDir: get("--state-dir"),
  };
  const out = path.resolve(get("--out"));
  if (
    !path.isAbsolute(get("--out")) ||
    [...Object.values(options)].some((p) => out === p || out.startsWith(p + path.sep))
  )
    throw Error("PRIVATE_OUTPUT_REQUIRED");
  if ((await realpath(path.dirname(out))) !== path.dirname(out))
    throw Error("CANONICAL_OUTPUT_REQUIRED");
  const source = JSON.parse(await readFile(get("--source-archive"), "utf8"));
  verifyProcessedArchive(source);
  if (
    source.scope.tenantId !== get("--tenant-id") ||
    source.scope.subjectId !== get("--subject-id")
  )
    throw Error("SOURCE_ARCHIVE_SCOPE_MISMATCH");
  const repository = new PrivateUnderstandingRepository(options);
  const view = await repository.read();
  const baseline = await readBaseline(options);
  if (view.feedback.length) throw Error("EXPLICIT_FEEDBACK_MIGRATION_REQUIRED");
  const versions: UnderstandingRuntimeSnapshot["versions"] = [];
  for (const [domain, accepted] of baseline.accepted) {
    const ids = [
      ...new Set(
        reportObjects(accepted.report).flatMap((o) => [
          ...o.evidence_ids,
          ...("counterevidence_ids" in o ? o.counterevidence_ids : []),
          ...("context_ids" in o ? o.context_ids : []),
        ]),
      ),
    ];
    const evidence = [];
    for (let i = 0; i < ids.length; i += 24)
      evidence.push(
        ...(await repository.evidences(domain, accepted.version, ids.slice(i, i + 24))),
      );
    versions.push({ domain, view: await repository.version(domain, accepted.version), evidence });
  }
  const snapshot = validateRuntimeSnapshot({
    format: "findme-understanding-runtime@1",
    source_archive_hash: source.hash,
    view,
    versions,
  });
  const archive = prepareRuntimeArchive(
    Buffer.from(JSON.stringify(snapshot)),
    { tenantId: get("--tenant-id"), subjectId: get("--subject-id") },
    "av-understanding-runtime",
  );
  await mkdir(out, { mode: 0o700 });
  await writeFile(path.join(out, "archive.json"), JSON.stringify(archive), {
    mode: 0o600,
    flag: "wx",
  });
  const tx = archiveConnectorBatches(archive);
  for (const [i, b] of tx.entries())
    await writeFile(
      path.join(out, `transaction-${String(i).padStart(3, "0")}.json`),
      JSON.stringify(b),
      { mode: 0o600, flag: "wx" },
    );
  await writeFile(
    path.join(out, "transport-manifest.json"),
    JSON.stringify({
      batch_hash: archive.hash,
      transactions: tx.length,
      sizes: tx.map((b) => Buffer.byteLength(JSON.stringify(b))),
      uploaded: false,
    }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      batch_hash: archive.hash,
      topics: view.topics.length,
      accepted_versions: versions.length,
      evidence: versions.reduce((n, v) => n + v.evidence.length, 0),
      chunks: archive.chunks.length,
      new_model_calls: 0,
    }),
  );
}
main().catch((e) => {
  console.error(
    e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : "RUNTIME_PREPARATION_FAILED",
  );
  process.exitCode = 1;
});
