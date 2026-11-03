import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fileBlobStore } from "../src/standalone/files.js";

it("persists originals across store recreation and rejects corrupt replacement atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "findme-files-"));
  try {
    const text = "standalone synthetic original";
    const bytes = new TextEncoder().encode(text);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const body = () => new Response(bytes).body!;
    const store = fileBlobStore(root);
    await store.put("../../opaque/key", body(), hash, "text/plain");
    await expect(
      store.put("../../opaque/key", body(), "0".repeat(64), "text/plain"),
    ).rejects.toThrow("BLOB_INTEGRITY");
    const reopened = fileBlobStore(root);
    const result = await reopened.get("../../opaque/key");
    expect(await new Response(result!.body).text()).toBe(text);
    expect(await reopened.head("../../opaque/key")).toEqual({ size: bytes.length, sha256: hash });
    expect(await readdir(root)).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    await reopened.delete("../../opaque/key");
    expect(await reopened.get("../../opaque/key")).toBeNull();
  } finally {
    await rm(root, { recursive: true });
  }
});
