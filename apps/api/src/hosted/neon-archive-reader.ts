import type { Db } from "@findme/db";
import { sql } from "drizzle-orm";
import { type ProfileTransaction, withProfileTransaction } from "../cloud-diagnostic/scope.js";
import type { PersonalContext } from "../core/exploration-service.js";

export type ArchiveDescriptor = {
  path: string;
  bytes: number;
  sha256: string;
  storedBytes: number;
  storedSha256: string;
  parts: number;
};
export type ArchivePart = { part: number; part_hash: string; data: string };
const hash = /^[a-f0-9]{64}$/;
function fail(code: string): never {
  throw new Error(code);
}
async function sha(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Worker-safe bounded restoration. No filesystem, credentials, model or global cache. */
export async function restoreArchiveFile(
  file: ArchiveDescriptor,
  parts: ArchivePart[],
  maxBytes = 24 * 1024 * 1024,
): Promise<Uint8Array> {
  if (
    !hash.test(file.sha256) ||
    !hash.test(file.storedSha256) ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0 ||
    file.bytes > maxBytes ||
    !Number.isSafeInteger(file.storedBytes) ||
    file.storedBytes < 1 ||
    file.storedBytes > maxBytes ||
    !Number.isSafeInteger(file.parts) ||
    file.parts < 1 ||
    parts.length !== file.parts
  )
    fail("ARCHIVE_READ_DESCRIPTOR_INVALID");
  const compressed = new Uint8Array(file.storedBytes);
  let offset = 0;
  for (const [i, part] of [...parts].sort((a, b) => a.part - b.part).entries()) {
    if (part.part !== i || !hash.test(part.part_hash)) fail("ARCHIVE_READ_PART_INVALID");
    const compact = part.data.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length > 262144)
      fail("ARCHIVE_READ_PART_INVALID");
    const bytes = Uint8Array.from(atob(compact), (c) => c.charCodeAt(0));
    if (
      bytes.length > 196608 ||
      offset + bytes.length > compressed.length ||
      (await sha(bytes)) !== part.part_hash
    )
      fail("ARCHIVE_READ_PART_HASH_MISMATCH");
    compressed.set(bytes, offset);
    offset += bytes.length;
  }
  if (offset !== compressed.length || (await sha(compressed)) !== file.storedSha256)
    fail("ARCHIVE_READ_STORED_HASH_MISMATCH");
  const reader = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const restored = new Uint8Array(file.bytes);
  offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.length > restored.length) fail("ARCHIVE_READ_EXPANSION_LIMIT");
      restored.set(chunk.value, offset);
      offset += chunk.value.length;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (offset !== restored.length || (await sha(restored)) !== file.sha256)
    fail("ARCHIVE_READ_FILE_HASH_MISMATCH");
  return restored;
}

function rows<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : ((value as { rows?: T[] }).rows ?? [])) as T[];
}
type ArchiveExecutor = Pick<Db, "execute"> | Pick<ProfileTransaction, "execute">;
export class NeonArchiveReader {
  constructor(
    private db: Db,
    readonly namespace: string,
    readonly batchHash: string,
    private readonly profileScoped = false,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(namespace) || !hash.test(batchHash))
      fail("ARCHIVE_READ_CONFIG_INVALID");
  }
  async read(ctx: PersonalContext, path: string): Promise<Uint8Array> {
    if (!path || path.includes("\\") || path.split("/").some((x) => !x || x === "." || x === ".."))
      fail("ARCHIVE_READ_PATH_INVALID");
    if (this.profileScoped)
      return withProfileTransaction(this.db, ctx, (tx) => this.readWithin(tx, ctx, path));
    return this.readWithin(this.db, ctx, path);
  }
  private async readWithin(executor: ArchiveExecutor, ctx: PersonalContext, path: string) {
    const entries = rows<{
      manifest: { format: string; codec: string; artifacts: ArchiveDescriptor[] };
    }>(
      await executor.execute(sql`
      SELECT manifest FROM av_processed_batches
      WHERE tenant_id=${ctx.tenantId}::uuid AND subject_id=${ctx.subjectId}::uuid
      AND namespace=${this.namespace} AND batch_hash=${this.batchHash} AND status='complete'`),
    );
    const manifest = entries[0]?.manifest;
    if (
      entries.length !== 1 ||
      manifest?.format !== "findme-av-processed-archive@2" ||
      manifest.codec !== "gzip"
    )
      fail("ARCHIVE_READ_BATCH_UNAVAILABLE");
    const files = manifest.artifacts.filter((x) => x.path === path);
    const [file] = files;
    if (files.length !== 1 || !file) fail("ARCHIVE_READ_FILE_UNAVAILABLE");
    // Descriptor bounds precede the payload query, protecting Worker memory and database egress.
    if (file.bytes > 24 * 1024 * 1024 || file.storedBytes > 24 * 1024 * 1024 || file.parts > 256)
      fail("ARCHIVE_READ_SIZE_LIMIT");
    const parts = rows<ArchivePart>(
      await executor.execute(sql`
      SELECT part,part_hash,encode(payload,'base64') AS data FROM av_processed_chunks
      WHERE tenant_id=${ctx.tenantId}::uuid AND subject_id=${ctx.subjectId}::uuid
      AND namespace=${this.namespace} AND batch_hash=${this.batchHash} AND artifact_hash=${file.sha256}
      ORDER BY part LIMIT 257`),
    );
    return restoreArchiveFile(file, parts);
  }
  async json<T>(ctx: PersonalContext, path: string): Promise<T> {
    const bytes = await this.read(ctx, path);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
    } catch {
      return fail("ARCHIVE_READ_JSON_INVALID");
    }
  }
}
