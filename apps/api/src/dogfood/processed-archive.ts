import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const ARCHIVE_FORMAT = "findme-av-processed-archive@2";
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export type Scope = { tenantId: string; subjectId: string };
export type Roots = { batch: string; u1: string; u2: string };
export type Statement = { sql: string; params: unknown[]; mustReturnTrue?: boolean };
type Artifact = {
  path: string;
  bytes: number;
  sha256: string;
  storedBytes: number;
  storedSha256: string;
  parts: number;
};
type Chunk = { artifactHash: string; part: number; sha256: string; data: string };
export type Archive = {
  scope: Scope;
  manifest: {
    format: string;
    namespace: string;
    policy: string;
    artifacts: Artifact[];
    pointers: Record<string, { version: string; path: string }>;
    excluded: string[];
    model_calls: 0;
    report_statuses_preserved: true;
    original_sessions_included: false;
    codec: "gzip";
  };
  hash: string;
  chunks: Chunk[];
};

function fail(code: string): never {
  throw new Error(code);
}
export function requireScope(scope: Scope) {
  if (!UUID.test(scope?.tenantId ?? "") || !UUID.test(scope?.subjectId ?? ""))
    fail("EXPLICIT_PERSONAL_SCOPE_REQUIRED");
}

// Exact output names, not a broad JSON or directory allowlist. Entire jobs trees are excluded from this archive:
// both job inputs and retained raw outputs may contain complete conversation material.
export function isProcessedArtifact(root: keyof Roots, name: string): boolean {
  if (name.includes("\\") || name.split("/").some((p) => !p || p === "." || p === ".."))
    return false;
  const v = "[a-f0-9]{64}";
  if (root === "batch")
    return (
      name === "runtime/understanding.json" ||
      /^(manifest|completion|progress|plan|layer-plan)\.json$/.test(name) ||
      /^L1\/(coverage|evidence|conflicting-extractions|quarantined)\.jsonl$/.test(name) ||
      /^L2\/(scenes\.jsonl|index\.json)$/.test(name) ||
      /^L3\/(current-understanding\.(json|md)|reductions\.json|reduction-source-map\.json)$/.test(
        name,
      ) ||
      /^L3\/history\/[a-zA-Z0-9_-]+\/(current-understanding\.(json|md)|reductions\.json|reduction-source-map\.json|completion\.json)$/.test(
        name,
      )
    );
  if (/^(run|progress|usage|provider-migration)\.json$/.test(name)) return true;
  if (root === "u1")
    return (
      /^(latest|latest-inventory|latest-review)\.json$/.test(name) ||
      new RegExp(
        `^versions/${v}/(summary\\.json|topics\\.json|omission-review\\.json|source-coverage\\.jsonl|evidence-destinations\\.jsonl|unresolved\\.jsonl|report\\.md)$`,
      ).test(name) ||
      new RegExp(`^reviews/${v}/reconciliation\\.json$`).test(name)
    );
  return (
    /^(latest-partial|latest-ready)\.json$/.test(name) ||
    new RegExp(
      `^versions/${v}/(manifest\\.json|input-hashes\\.json|plan\\.json|source-refs\\.json|repairs\\.json|context\\.json|baseline\\.json|report\\.md|old-claim-review\\.json|unresolved\\.json|topics/[a-z][a-z0-9_]*\\.json)$`,
    ).test(name) ||
    /^recovery\/[a-zA-Z0-9_-]+\.json$/.test(name)
  );
}

/** Explicit application snapshot, not a directory scan or an original-conversation import. */
export function prepareRuntimeArchive(bytes: Buffer, scope: Scope, namespace: string): Archive {
  requireScope(scope);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(namespace)) fail("ARCHIVE_NAMESPACE_INVALID");
  const value = JSON.parse(bytes.toString("utf8"));
  checkStructure(value);
  if (
    value.format !== "findme-understanding-runtime@1" ||
    value.view?.capabilities?.provider_enabled !== false ||
    value.view?.capabilities?.native_core !== "unavailable"
  )
    fail("RUNTIME_SNAPSHOT_INVALID");
  const compressed = gzipSync(bytes, { level: 9 });
  const originalHash = sha(bytes);
  const chunks: Chunk[] = [];
  const parts = Math.ceil(compressed.length / (96 * 1024));
  for (let part = 0; part < parts; part++) {
    const b = compressed.subarray(part * 96 * 1024, (part + 1) * 96 * 1024);
    chunks.push({ artifactHash: originalHash, part, sha256: sha(b), data: b.toString("base64") });
  }
  const manifest: Archive["manifest"] = {
    format: ARCHIVE_FORMAT,
    namespace,
    policy: "processed-only-no-jobs-gzip@1",
    codec: "gzip",
    artifacts: [
      {
        path: "batch/runtime/understanding.json",
        bytes: bytes.length,
        sha256: originalHash,
        storedBytes: compressed.length,
        storedSha256: sha(compressed),
        parts,
      },
    ],
    pointers: {},
    excluded: [],
    model_calls: 0,
    report_statuses_preserved: true,
    original_sessions_included: false,
  };
  const archive = { scope, manifest, hash: sha(JSON.stringify(manifest)), chunks };
  verifyProcessedArchive(archive);
  return archive;
}

const FORBIDDEN_KEYS = new Set([
  "messages",
  "originaltext",
  "rawtext",
  "systemprompt",
  "prompt",
  "apikey",
  "accesstoken",
  "password",
  "connectionstring",
  "databaseurl",
  "secret",
]);
function checkStructure(value: unknown): void {
  if (Array.isArray(value)) {
    for (const v of value) checkStructure(v);
    return;
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (["user", "assistant", "system"].includes(String(row.role)) && typeof row.text === "string")
      fail("ORIGINAL_OR_SECRET_FIELD_IN_PROCESSED_OUTPUT");
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k.replace(/[^a-zA-Z]/g, "").toLowerCase()))
        fail("ORIGINAL_OR_SECRET_FIELD_IN_PROCESSED_OUTPUT");
      checkStructure(v);
    }
  }
}
async function safeRoot(root: string) {
  if (!path.isAbsolute(root)) fail("ABSOLUTE_PRIVATE_ROOT_REQUIRED");
  for (let p = root; ; p = path.dirname(p)) {
    if ((await lstat(p)).isSymbolicLink()) fail("ARCHIVE_SYMLINK_FORBIDDEN");
    if (p === path.dirname(p)) break;
  }
}

/** Local, immutable preparation. No DB, env loading, network, model, or source writes. */
export async function prepareProcessedArchive(options: {
  roots: Roots;
  scope: Scope;
  namespace: string;
  chunkBytes?: number;
}): Promise<Archive> {
  requireScope(options.scope);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(options.namespace))
    fail("ARCHIVE_NAMESPACE_INVALID");
  const chunkBytes = options.chunkBytes ?? 96 * 1024;
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 192 * 1024)
    fail("ARCHIVE_CHUNK_SIZE_INVALID");
  const artifacts: Artifact[] = [];
  const chunks: Chunk[] = [];
  const excluded: string[] = [];
  const storedFiles = new Map<string, Omit<Artifact, "path">>();
  const parsed = new Map<string, unknown>();
  const referenceRows = new Map<string, Record<string, unknown>[]>();
  for (const kind of ["batch", "u1", "u2"] as const) {
    const root = options.roots[kind];
    await safeRoot(root);
    async function visit(relative: string) {
      for (const e of (await readdir(path.join(root, relative), { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        const name = relative ? `${relative}/${e.name}` : e.name;
        if (e.isSymbolicLink()) fail("ARCHIVE_SYMLINK_FORBIDDEN");
        if (e.isDirectory()) {
          if (!relative && !["L1", "L2", "L3", "versions", "reviews", "recovery"].includes(name)) {
            excluded.push(`${kind}/${name}/`);
            continue;
          }
          if (name.split("/").some((p) => p.startsWith("."))) {
            excluded.push(`${kind}/${name}/`);
            continue;
          }
          await visit(name);
        } else if (e.isFile()) {
          const key = `${kind}/${name}`;
          if (!isProcessedArtifact(kind, name)) {
            excluded.push(key);
            continue;
          }
          const bytes = await readFile(path.join(root, name));
          if (name.endsWith(".json")) {
            const value = JSON.parse(bytes.toString("utf8"));
            checkStructure(value);
            parsed.set(key, value);
          } else if (name.endsWith(".jsonl")) {
            const rows = bytes
              .toString("utf8")
              .split("\n")
              .filter((l) => l.trim())
              .map((l) => JSON.parse(l) as Record<string, unknown>);
            for (const row of rows) checkStructure(row);
            if (
              [
                "batch/L1/evidence.jsonl",
                "batch/L1/coverage.jsonl",
                "batch/L2/scenes.jsonl",
              ].includes(key)
            )
              referenceRows.set(key, rows);
          }
          const hash = sha(bytes);
          let stored = storedFiles.get(hash);
          if (!stored) {
            const compressed = gzipSync(bytes, { level: 9 });
            const count = Math.max(1, Math.ceil(compressed.length / chunkBytes));
            stored = {
              bytes: bytes.length,
              sha256: hash,
              storedBytes: compressed.length,
              storedSha256: sha(compressed),
              parts: count,
            };
            storedFiles.set(hash, stored);
            for (let part = 0; part < count; part++) {
              const b = compressed.subarray(part * chunkBytes, (part + 1) * chunkBytes);
              chunks.push({ artifactHash: hash, part, sha256: sha(b), data: b.toString("base64") });
            }
          }
          artifacts.push({ path: key, ...stored });
        } else fail("ARCHIVE_SPECIAL_FILE_FORBIDDEN");
      }
    }
    await visit("");
  }
  const present = new Map(artifacts.map((a) => [a.path, a]));
  for (const required of [
    "batch/manifest.json",
    "batch/L1/evidence.jsonl",
    "batch/L1/coverage.jsonl",
    "batch/L2/scenes.jsonl",
    "batch/L3/current-understanding.json",
  ])
    if (!present.has(required)) fail("ARCHIVE_REQUIRED_ARTIFACT_MISSING");
  const atoms = referenceRows.get("batch/L1/evidence.jsonl") ?? [];
  const evidence = new Map(atoms.map((a) => [a.id, a]));
  if (evidence.size !== atoms.length) fail("ARCHIVE_DUPLICATE_EVIDENCE_ID");
  const segments = new Map(
    (referenceRows.get("batch/L1/coverage.jsonl") ?? []).map((a) => [a.key, a]),
  );
  for (const atom of atoms) {
    const segment = segments.get(atom.segmentId);
    if (
      !segment ||
      segment.sessionId !== atom.sessionId ||
      segment.messageId !== atom.messageId ||
      segment.split !== atom.split
    )
      fail("ARCHIVE_EVIDENCE_SEGMENT_REFERENCE_INVALID");
  }
  for (const scene of referenceRows.get("batch/L2/scenes.jsonl") ?? []) {
    if (!Array.isArray(scene.evidence_ids) || !Array.isArray(scene.eligible_evidence_ids))
      fail("ARCHIVE_SCENE_REFERENCE_INVALID");
    for (const id of [...scene.evidence_ids, ...scene.eligible_evidence_ids]) {
      const atom = evidence.get(id);
      if (!atom || atom.sessionId !== scene.sessionId || atom.split !== scene.split)
        fail("ARCHIVE_SCENE_REFERENCE_INVALID");
    }
  }
  const pointers: Archive["manifest"]["pointers"] = {};
  for (const [key, value] of parsed) {
    if (/^u[12]\/latest(?:-partial|-ready|-inventory)?\.json$/.test(key)) {
      const version = (value as { version?: string }).version ?? "";
      if (!HASH.test(version)) fail("ARCHIVE_POINTER_INVALID");
      const kind = key.slice(0, 2);
      const dir = `${kind}/versions/${version}`;
      if (!present.has(`${dir}/${kind === "u1" ? "summary.json" : "manifest.json"}`))
        fail("ARCHIVE_POINTER_TARGET_MISSING");
      pointers[key] = { version, path: dir };
    }
    if (/^u2\/versions\/[a-f0-9]{64}\/manifest\.json$/.test(key)) {
      const m = value as { files?: Record<string, string> };
      if (!m.files || !Object.keys(m.files).length) fail("ARCHIVE_VERSION_MANIFEST_INVALID");
      for (const [name, sum] of Object.entries(m.files))
        if (present.get(`${path.posix.dirname(key)}/${name}`)?.sha256 !== sum)
          fail("ARCHIVE_VERSION_HASH_MISMATCH");
    }
    if (key === "u1/latest-review.json") {
      const p = value as { directory?: string; file?: string; content_sha256?: string };
      if (typeof p.directory !== "string" || typeof p.file !== "string")
        fail("ARCHIVE_REVIEW_POINTER_INVALID");
      const dir = path.isAbsolute(p.directory)
        ? path.relative(options.roots.u1, p.directory)
        : p.directory;
      const file = path.isAbsolute(p.file)
        ? path.relative(options.roots.u1, p.file)
        : path.posix.join(dir, p.file);
      if (
        !isProcessedArtifact("u1", file) ||
        present.get(`u1/${file}`)?.sha256 !== p.content_sha256
      )
        fail("ARCHIVE_REVIEW_HASH_MISMATCH");
    }
  }
  if (!pointers["u1/latest.json"] && !pointers["u1/latest-inventory.json"])
    fail("ARCHIVE_U1_POINTER_REQUIRED");
  if (!pointers["u2/latest-partial.json"] && !pointers["u2/latest-ready.json"])
    fail("ARCHIVE_U2_POINTER_REQUIRED");
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  chunks.sort((a, b) => a.artifactHash.localeCompare(b.artifactHash) || a.part - b.part);
  excluded.sort();
  const manifest: Archive["manifest"] = {
    format: ARCHIVE_FORMAT,
    namespace: options.namespace,
    policy: "processed-only-no-jobs-gzip@1",
    artifacts,
    pointers,
    excluded,
    model_calls: 0,
    report_statuses_preserved: true,
    original_sessions_included: false,
    codec: "gzip",
  };
  const archive = {
    scope: { ...options.scope },
    manifest,
    hash: sha(JSON.stringify(manifest)),
    chunks,
  };
  verifyProcessedArchive(archive);
  return archive;
}

/** Revalidates packages before producing SQL; do not trust a saved hash or completion flag. */
export function verifyProcessedArchive(archive: Archive) {
  requireScope(archive.scope);
  if (
    archive.manifest.format !== ARCHIVE_FORMAT ||
    sha(JSON.stringify(archive.manifest)) !== archive.hash
  )
    fail("ARCHIVE_MANIFEST_HASH_MISMATCH");
  if (
    archive.manifest.policy !== "processed-only-no-jobs-gzip@1" ||
    archive.manifest.codec !== "gzip" ||
    archive.manifest.model_calls !== 0 ||
    archive.manifest.report_statuses_preserved !== true ||
    archive.manifest.original_sessions_included !== false
  )
    fail("ARCHIVE_POLICY_INVALID");
  const names = new Set<string>();
  let totalParts = 0;
  const restored = new Map<string, Buffer>();
  for (const a of archive.manifest.artifacts) {
    const slash = a.path.indexOf("/");
    const root = a.path.slice(0, slash);
    const relative = a.path.slice(slash + 1);
    if (
      !["batch", "u1", "u2"].includes(root) ||
      !isProcessedArtifact(root as keyof Roots, relative) ||
      names.has(a.path)
    )
      fail("ARCHIVE_ARTIFACT_PATH_INVALID");
    if (
      !HASH.test(a.sha256) ||
      !HASH.test(a.storedSha256) ||
      !Number.isSafeInteger(a.storedBytes) ||
      a.storedBytes < 1 ||
      !Number.isSafeInteger(a.bytes) ||
      a.bytes < 0 ||
      !Number.isSafeInteger(a.parts) ||
      a.parts < 1
    )
      fail("ARCHIVE_DESCRIPTOR_INVALID");
    names.add(a.path);
    const parts = archive.chunks
      .filter((c) => c.artifactHash === a.sha256)
      .sort((x, y) => x.part - y.part);
    if (parts.length !== a.parts || !parts.length) fail("ARCHIVE_PART_COUNT_MISMATCH");
    const compressed = Buffer.concat(
      parts.map((c, i) => {
        if (c.part !== i || !HASH.test(c.sha256)) fail("ARCHIVE_PART_INDEX_INVALID");
        const b = Buffer.from(c.data, "base64");
        if (b.toString("base64") !== c.data || sha(b) !== c.sha256)
          fail("ARCHIVE_CHUNK_HASH_MISMATCH");
        return b;
      }),
    );
    if (compressed.length !== a.storedBytes || sha(compressed) !== a.storedSha256)
      fail("ARCHIVE_STORED_HASH_MISMATCH");
    const bytes =
      restored.get(a.sha256) ?? gunzipSync(compressed, { maxOutputLength: a.bytes + 1 });
    if (bytes.length !== a.bytes || sha(bytes) !== a.sha256) fail("ARCHIVE_FILE_HASH_MISMATCH");
    if (a.path.endsWith(".json")) checkStructure(JSON.parse(bytes.toString()));
    if (a.path.endsWith(".jsonl"))
      for (const line of bytes
        .toString()
        .split("\n")
        .filter((l) => l.trim()))
        checkStructure(JSON.parse(line));
    if (!restored.has(a.sha256)) totalParts += parts.length;
    restored.set(a.sha256, bytes);
  }
  if (totalParts !== archive.chunks.length) fail("ARCHIVE_UNDECLARED_CHUNK");
}

/** Explicit statements for a separately authorized transport. Never opens a connection.
 * Each returned group is one transaction. A false verification result MUST roll back.
 * The last transaction verifies all bytes before marking this import complete; report states
 * and source version pointers in the manifest are never promoted or rewritten.
 */
export function archiveTransactions(archive: Archive): Statement[][] {
  verifyProcessedArchive(archive);
  const scope = [
    archive.scope.tenantId,
    archive.scope.subjectId,
    archive.manifest.namespace,
    archive.hash,
  ];
  const groups: Statement[][] = [
    [
      {
        sql: "INSERT INTO av_processed_batches (tenant_id,subject_id,namespace,batch_hash,manifest) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING",
        params: [...scope, JSON.stringify(archive.manifest)],
      },
      {
        sql: "SELECT manifest=$5::jsonb AND EXISTS(SELECT 1 FROM subjects s WHERE s.id=$2 AND s.tenant_id=$1) AS ok FROM av_processed_batches WHERE tenant_id=$1 AND subject_id=$2 AND namespace=$3 AND batch_hash=$4",
        params: [...scope, JSON.stringify(archive.manifest)],
        mustReturnTrue: true,
      },
    ],
  ];
  for (const c of archive.chunks)
    groups.push([
      {
        sql: `INSERT INTO av_processed_chunks (tenant_id,subject_id,namespace,batch_hash,artifact_hash,part,part_hash,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,decode($8,'base64')) ON CONFLICT DO NOTHING`,
        params: [...scope, c.artifactHash, c.part, c.sha256, c.data],
      },
      {
        sql: `SELECT part_hash=$7 AND encode(sha256(payload),'hex')=$7 AS ok FROM av_processed_chunks WHERE tenant_id=$1 AND subject_id=$2 AND namespace=$3 AND batch_hash=$4 AND artifact_hash=$5 AND part=$6`,
        params: [...scope, c.artifactHash, c.part, c.sha256],
        mustReturnTrue: true,
      },
    ]);
  groups.push([
    {
      sql: `WITH expected AS (SELECT DISTINCT x.sha256 AS artifact_hash,x."storedBytes" AS bytes,x."storedSha256" AS sha256,x.parts FROM av_processed_batches b CROSS JOIN LATERAL jsonb_to_recordset(b.manifest->'artifacts') AS x(sha256 text,"storedBytes" bigint,"storedSha256" text,parts integer) WHERE b.tenant_id=$1 AND b.subject_id=$2 AND b.namespace=$3 AND b.batch_hash=$4), actual AS (SELECT artifact_hash,count(*) AS parts,min(part) AS first,max(part) AS last,sum(octet_length(payload)) AS bytes,encode(sha256(string_agg(payload,''::bytea ORDER BY part)),'hex') AS sha256 FROM av_processed_chunks WHERE tenant_id=$1 AND subject_id=$2 AND namespace=$3 AND batch_hash=$4 GROUP BY artifact_hash), valid AS (SELECT (SELECT count(*) FROM expected)>0 AND NOT EXISTS(SELECT 1 FROM expected e FULL JOIN actual a USING(artifact_hash) WHERE e.artifact_hash IS NULL OR a.artifact_hash IS NULL OR e.parts<>a.parts OR a.first<>0 OR a.last<>e.parts-1 OR e.bytes<>a.bytes OR e.sha256<>a.sha256) AS ok), completed AS (UPDATE av_processed_batches SET status='complete' WHERE tenant_id=$1 AND subject_id=$2 AND namespace=$3 AND batch_hash=$4 AND (SELECT ok FROM valid) RETURNING batch_hash) SELECT EXISTS(SELECT 1 FROM completed) AS ok`,
      params: scope,
      mustReturnTrue: true,
    },
  ]);
  return groups;
}

export async function executeArchiveTransactions(
  groups: Statement[][],
  transaction: (statements: Statement[]) => Promise<{ ok: boolean }>,
) {
  for (const statements of groups)
    if (!(await transaction(statements)).ok) fail("ARCHIVE_TRANSACTION_VERIFICATION_FAILED");
}

/** Render only our prepared statements for the authorized Neon connector, which accepts SQL
 * rather than bound parameters. E literals escape both quotes and backslashes. Assertions
 * execute inside the same DB transaction and raise on false/absent verification rows.
 */
export function renderArchiveStatement(statement: Statement): string {
  const sql = statement.sql.replace(/\$(\d+)/g, (_, index: string) => {
    const value = statement.params[Number(index) - 1];
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    if (typeof value !== "string" || value.includes("\0")) fail("ARCHIVE_SQL_PARAMETER_INVALID");
    return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  });
  if (!statement.mustReturnTrue) return sql;
  const delimiter = `$av_${sha(sql).slice(0, 24)}$`;
  if (sql.includes(delimiter)) fail("ARCHIVE_SQL_DELIMITER_COLLISION");
  return `DO ${delimiter} DECLARE archive_ok boolean; BEGIN ${sql} INTO archive_ok; IF archive_ok IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'ARCHIVE_TRANSACTION_VERIFICATION_FAILED'; END IF; END; ${delimiter};`;
}

export function archiveConnectorBatches(archive: Archive, maxBytes = 480 * 1024): string[][] {
  const groups = archiveTransactions(archive);
  const first = groups.shift();
  const last = groups.pop();
  if (!first || !last) fail("ARCHIVE_TRANSACTIONS_MISSING");
  const batches = [first.map(renderArchiveStatement)];
  let current: string[] = [];
  for (const group of groups) {
    const statements = group.map(renderArchiveStatement);
    if (Buffer.byteLength(JSON.stringify(statements)) > maxBytes)
      fail("ARCHIVE_CONNECTOR_GROUP_TOO_LARGE");
    if (
      current.length &&
      Buffer.byteLength(JSON.stringify([...current, ...statements])) > maxBytes
    ) {
      batches.push(current);
      current = [];
    }
    current.push(...statements);
  }
  if (current.length) batches.push(current);
  batches.push(last.map(renderArchiveStatement));
  if (batches.some((b) => Buffer.byteLength(JSON.stringify(b)) > maxBytes))
    fail("ARCHIVE_CONNECTOR_BATCH_TOO_LARGE");
  return batches;
}
