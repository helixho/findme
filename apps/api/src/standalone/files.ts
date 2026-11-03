import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BlobStore } from "../cloud-diagnostic/blobs.js";

/** Opaque object keys map to single files; no caller path is interpreted. */
export function fileBlobStore(root: string): BlobStore {
  const file = (key: string) => path.join(root, createHash("sha256").update(key).digest("hex"));
  async function head(key: string) {
    const filename = file(key);
    try {
      const info = await stat(filename);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(filename)) hash.update(chunk);
      return { size: info.size, sha256: hash.digest("hex") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  return {
    async put(key, body, sha256) {
      await mkdir(root, { recursive: true });
      const temporary = path.join(root, `.upload-${randomUUID()}`);
      const hash = createHash("sha256");
      try {
        await pipeline(
          Readable.fromWeb(body as never),
          new Transform({
            transform(chunk, _encoding, done) {
              hash.update(chunk);
              done(null, chunk);
            },
          }),
          createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        );
        if (hash.digest("hex") !== sha256) throw new Error("BLOB_INTEGRITY");
        await rename(temporary, file(key));
      } finally {
        await rm(temporary, { force: true });
      }
    },
    head,
    async get(key) {
      const info = await head(key);
      return info
        ? {
            ...info,
            body: Readable.toWeb(createReadStream(file(key))) as ReadableStream<Uint8Array>,
          }
        : null;
    },
    async delete(key) {
      await rm(file(key), { force: true });
    },
  };
}
