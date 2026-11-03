import type { R2Bucket } from "@cloudflare/workers-types";
import { CloudBlobDeclaration } from "@findme/core";
import { type Db, diagnosticSchema as t } from "@findme/db";
import { and, eq } from "drizzle-orm";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { withProfileTransaction } from "./scope.js";

export interface BlobStore {
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    sha256: string,
    mediaType: string,
  ): Promise<void>;
  get(
    key: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number; sha256: string | null } | null>;
  head(key: string): Promise<{ size: number; sha256: string | null } | null>;
  delete(key: string): Promise<void>;
}
const hex = (b: ArrayBuffer | undefined) =>
  b ? Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, "0")).join("") : null;
export function r2BlobStore(bucket: R2Bucket): BlobStore {
  return {
    async put(key, body, sha256, mediaType) {
      await bucket.put(key, body as never, {
        sha256,
        httpMetadata: { contentType: mediaType, cacheControl: "no-store" },
      });
    },
    async head(key) {
      const o = await bucket.head(key);
      return o ? { size: o.size, sha256: hex(o.checksums.sha256) } : null;
    },
    async get(key) {
      const o = await bucket.get(key);
      return o
        ? {
            body: o.body as unknown as ReadableStream<Uint8Array>,
            size: o.size,
            sha256: hex(o.checksums.sha256),
          }
        : null;
    },
    delete: (key) => bucket.delete(key),
  };
}
const blobs = t.sourceBlobs;
const where = (ctx: PersonalContext, id: string) =>
  and(eq(blobs.id, id), eq(blobs.tenantId, ctx.tenantId), eq(blobs.subjectId, ctx.subjectId));
export class CloudBlobService {
  constructor(
    private db: Db,
    private store?: BlobStore,
  ) {}
  available() {
    return !!this.store;
  }
  private backend() {
    if (!this.store) throw new CoreError("LLM_UNAVAILABLE", 503, "原档存储未配置");
    return this.store;
  }
  async list(ctx: PersonalContext) {
    return withProfileTransaction(this.db, ctx, (tx) =>
      tx
        .select({
          id: blobs.id,
          content_sha256: blobs.contentSha256,
          byte_length: blobs.byteLength,
          media_type: blobs.mediaType,
          status: blobs.status,
        })
        .from(blobs)
        .where(and(eq(blobs.tenantId, ctx.tenantId), eq(blobs.subjectId, ctx.subjectId)))
        .limit(200),
    );
  }
  async declare(ctx: PersonalContext, raw: unknown) {
    const input = CloudBlobDeclaration.parse(raw);
    this.backend();
    return withProfileTransaction(this.db, ctx, async (tx) => {
      const objectKey = `profiles/${ctx.tenantId}/${ctx.subjectId}/${input.content_sha256}`;
      const [row] = await tx
        .insert(blobs)
        .values({
          ...ctx,
          objectKey,
          contentSha256: input.content_sha256,
          byteLength: input.byte_length,
          mediaType: input.media_type,
        })
        .onConflictDoNothing()
        .returning();
      const old = row ?? (await tx.select().from(blobs).where(eq(blobs.objectKey, objectKey)))[0];
      if (!old || old.byteLength !== input.byte_length || old.mediaType !== input.media_type)
        throw new CoreError("STALE_VERSION", 409, "原档声明不一致");
      return { id: old.id, status: old.status };
    });
  }
  async upload(ctx: PersonalContext, id: string, body: ReadableStream<Uint8Array>) {
    const store = this.backend();
    const blob = await withProfileTransaction(this.db, ctx, async (tx) => {
      const [row] = await tx
        .update(blobs)
        .set({ status: "uploading" })
        .where(and(where(ctx, id), eq(blobs.status, "declared")))
        .returning();
      if (!row) throw new CoreError("STALE_VERSION", 409, "原档不在可上传状态");
      return row;
    });
    let count = 0;
    const limited = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          count += chunk.byteLength;
          if (count > blob.byteLength) throw new Error("BLOB_SIZE_MISMATCH");
          controller.enqueue(chunk);
        },
        flush() {
          if (count !== blob.byteLength) throw new Error("BLOB_SIZE_MISMATCH");
        },
      }),
    );
    try {
      await store.put(blob.objectKey, limited, blob.contentSha256, blob.mediaType);
      const actual = await store.head(blob.objectKey);
      if (!actual || actual.size !== blob.byteLength || actual.sha256 !== blob.contentSha256)
        throw new Error("BLOB_INTEGRITY");
      const saved = await withProfileTransaction(this.db, ctx, (tx) =>
        tx
          .update(blobs)
          .set({ status: "available", verifiedAt: new Date() })
          .where(and(where(ctx, id), eq(blobs.status, "uploading")))
          .returning(),
      );
      if (!saved.length) {
        await store.delete(blob.objectKey);
        throw new Error("BLOB_LIFECYCLE_CHANGED");
      }
      return { id, status: "available" };
    } catch (e) {
      await store.delete(blob.objectKey).catch(() => undefined);
      await withProfileTransaction(this.db, ctx, (tx) =>
        tx
          .update(blobs)
          .set({ status: "declared" })
          .where(and(where(ctx, id), eq(blobs.status, "uploading"))),
      ).catch(() => undefined);
      throw e;
    }
  }
  async download(ctx: PersonalContext, id: string) {
    const [blob] = await withProfileTransaction(this.db, ctx, (tx) =>
      tx
        .select()
        .from(blobs)
        .where(and(where(ctx, id), eq(blobs.status, "available")))
        .limit(1),
    );
    if (!blob) throw new CoreError("NOT_FOUND", 404, "原档不存在或已排除");
    const object = await this.backend().get(blob.objectKey);
    if (!object || object.size !== blob.byteLength || object.sha256 !== blob.contentSha256)
      throw new Error("BLOB_INTEGRITY");
    return { body: object.body, size: object.size, mediaType: blob.mediaType };
  }
  async remove(ctx: PersonalContext, id: string) {
    const [blob] = await withProfileTransaction(this.db, ctx, (tx) =>
      tx.update(blobs).set({ status: "delete_pending" }).where(where(ctx, id)).returning(),
    );
    if (!blob) throw new CoreError("NOT_FOUND", 404, "原档不存在");
    await this.backend().delete(blob.objectKey);
    await withProfileTransaction(this.db, ctx, (tx) =>
      tx
        .update(blobs)
        .set({ status: "deleted" })
        .where(and(where(ctx, id), eq(blobs.status, "delete_pending"))),
    );
    return { id, status: "deleted", object_purged: true };
  }
  async recover(ctx: PersonalContext, id: string) {
    const [blob] = await withProfileTransaction(this.db, ctx, (tx) =>
      tx.select().from(blobs).where(where(ctx, id)).limit(1),
    );
    if (!blob) throw new CoreError("NOT_FOUND", 404, "原档不存在");
    if (blob.status === "delete_pending") return this.remove(ctx, id);
    if (blob.status !== "uploading") return { id, status: blob.status };
    const actual = await this.backend().head(blob.objectKey);
    const status =
      actual?.size === blob.byteLength && actual.sha256 === blob.contentSha256
        ? "available"
        : "declared";
    await withProfileTransaction(this.db, ctx, (tx) =>
      tx
        .update(blobs)
        .set({ status })
        .where(and(where(ctx, id), eq(blobs.status, "uploading"))),
    );
    return { id, status };
  }
}
