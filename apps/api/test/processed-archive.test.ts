import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  archiveConnectorBatches,
  archiveTransactions,
  executeArchiveTransactions,
  isProcessedArtifact,
  prepareProcessedArchive,
  renderArchiveStatement,
  verifyProcessedArchive,
} from "../src/dogfood/processed-archive.js";

const scope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  subjectId: "22222222-2222-4222-8222-222222222222",
};
const version = "a".repeat(64);
const sum = (s: string) => createHash("sha256").update(s).digest("hex");
function restored(a: Awaited<ReturnType<typeof prepareProcessedArchive>>, p: string) {
  const file = a.manifest.artifacts.find((x) => x.path === p)!;
  return gunzipSync(
    Buffer.concat(
      a.chunks
        .filter((c) => c.artifactHash === file.sha256)
        .map((c) => Buffer.from(c.data, "base64")),
    ),
  ).toString();
}
async function fixture() {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "findme-av-archive-synthetic-"),
  );
  const roots = {
    batch: path.join(root, "batch"),
    u1: path.join(root, "u1"),
    u2: path.join(root, "u2"),
  };
  async function put(k: keyof typeof roots, name: string, data: unknown, raw = false) {
    const f = path.join(roots[k], name);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, raw ? String(data) : JSON.stringify(data));
  }
  const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  await put("batch", "manifest.json", {
    sessions: [
      { id: "s1", split: "dev" },
      { id: "s2", split: "holdout" },
    ],
  });
  await put(
    "batch",
    "L1/coverage.jsonl",
    jsonl(
      ["dev", "holdout"].map((split, i) => ({
        key: `c${i}`,
        sessionId: `s${i + 1}`,
        messageId: `m${i}`,
        split,
      })),
    ),
    true,
  );
  await put(
    "batch",
    "L1/evidence.jsonl",
    jsonl(
      ["dev", "holdout"].map((split, i) => ({
        id: `e${i}`,
        segmentId: `c${i}`,
        sessionId: `s${i + 1}`,
        messageId: `m${i}`,
        split,
        quote: "短合成证据",
        status: "candidate",
        eligible: split === "dev",
      })),
    ),
    true,
  );
  await put(
    "batch",
    "L2/scenes.jsonl",
    jsonl(
      ["dev", "holdout"].map((split, i) => ({
        sessionId: `s${i + 1}`,
        split,
        evidence_ids: [`e${i}`],
        eligible_evidence_ids: split === "dev" ? [`e${i}`] : [],
      })),
    ),
    true,
  );
  await put("batch", "L3/current-understanding.json", {
    status: "candidate_owner_review_pending",
    heldoutIncluded: false,
    claims: [],
  });
  await put("batch", "raw.json", [{ messages: [{ text: "FULL_SESSION_SENTINEL" }] }]);
  await put("u1", `versions/${version}/summary.json`, {
    status: "candidate_screening_complete",
    owner_review_pending: true,
  });
  await put("u1", "latest.json", { version });
  const baseline = JSON.stringify({
    status: "partial",
    topics: [{ status: "ready_candidate" }],
    overall: null,
  });
  await put("u2", `versions/${version}/baseline.json`, baseline, true);
  await put("u2", `versions/${version}/manifest.json`, {
    status: "partial",
    version,
    files: { "baseline.json": sum(baseline) },
  });
  await put("u2", "latest-partial.json", { version });
  await put("u2", "jobs/job-input.json", { messages: [{ text: "JOB_INPUT_SENTINEL" }] });
  await put("u2", "jobs/job-raw.txt", "RAW_OUTPUT_SENTINEL", true);
  await put("u2", "unexpected.json", { secret: "UNKNOWN_FILE_SENTINEL" });
  const prepare = () =>
    prepareProcessedArchive({ roots, scope, namespace: "synthetic-av", chunkBytes: 37 });
  return { roots, put, prepare };
}
describe("processed AV archive: offline synthetic fixtures", () => {
  it("excludes complete originals, all jobs and unknown files without reading their content", async () => {
    const f = await fixture();
    const a = await f.prepare();
    expect(a.manifest.excluded).toContain("batch/raw.json");
    expect(a.manifest.excluded).toContain("u2/jobs/");
    const contents = a.manifest.artifacts.map((x) => restored(a, x.path)).join("\n");
    for (const marker of [
      "FULL_SESSION_SENTINEL",
      "JOB_INPUT_SENTINEL",
      "RAW_OUTPUT_SENTINEL",
      "UNKNOWN_FILE_SENTINEL",
    ])
      expect(contents).not.toContain(marker);
    expect(await readFile(path.join(f.roots.batch, "raw.json"), "utf8")).toContain(
      "FULL_SESSION_SENTINEL",
    );
  });
  it("requires explicit scope before touching any path", async () => {
    await expect(
      prepareProcessedArchive({
        roots: { batch: "/missing", u1: "/missing", u2: "/missing" },
        scope: { tenantId: "", subjectId: scope.subjectId },
        namespace: "synthetic",
      }),
    ).rejects.toThrow("EXPLICIT_PERSONAL_SCOPE_REQUIRED");
  });
  it("preserves partial, candidate and holdout bytes and gives deterministic import identity", async () => {
    const f = await fixture();
    const a = await f.prepare();
    const b = await f.prepare();
    expect(a).toEqual(b);
    const read = (p: string) => restored(a, p);
    expect(read(`u2/versions/${version}/baseline.json`)).toContain('"partial"');
    expect(read(`u2/versions/${version}/baseline.json`)).toContain('"ready_candidate"');
    expect(read("batch/L1/evidence.jsonl")).toContain('"holdout"');
    expect(a.manifest.pointers["u2/latest-ready.json"]).toBeUndefined();
    expect(a.manifest.model_calls).toBe(0);
    await f.put("u1", `versions/${version}/summary.json`, { status: "partial" });
    expect((await f.prepare()).hash).not.toBe(a.hash);
  });
  it("rejects disguised originals in allowed JSON and symlinks", async () => {
    const f = await fixture();
    await f.put("u1", "progress.json", { nested: { messages: [] } });
    await expect(f.prepare()).rejects.toThrow("ORIGINAL_OR_SECRET_FIELD_IN_PROCESSED_OUTPUT");
    const g = await fixture();
    await symlink(path.join(g.roots.batch, "raw.json"), path.join(g.roots.u2, "progress.json"));
    await expect(g.prepare()).rejects.toThrow("ARCHIVE_SYMLINK_FORBIDDEN");
  });
  it("rejects dangling L2 references and mismatched version artifacts", async () => {
    const f = await fixture();
    await f.put(
      "batch",
      "L2/scenes.jsonl",
      JSON.stringify({
        sessionId: "s1",
        split: "dev",
        evidence_ids: ["missing"],
        eligible_evidence_ids: [],
      }),
      true,
    );
    await expect(f.prepare()).rejects.toThrow("ARCHIVE_SCENE_REFERENCE_INVALID");
    const g = await fixture();
    await g.put("u2", `versions/${version}/baseline.json`, { status: "ready" });
    await expect(g.prepare()).rejects.toThrow("ARCHIVE_VERSION_HASH_MISMATCH");
  });
  it("rejects payload tampering, missing chunks and path injection before SQL preparation", async () => {
    const a = await (await fixture()).prepare();
    const bad = structuredClone(a);
    bad.chunks[0]!.data = Buffer.from("tampered").toString("base64");
    expect(() => archiveTransactions(bad)).toThrow("ARCHIVE_CHUNK_HASH_MISMATCH");
    const missing = structuredClone(a);
    missing.chunks.pop();
    expect(() => verifyProcessedArchive(missing)).toThrow("ARCHIVE_PART_COUNT_MISMATCH");
    expect(isProcessedArtifact("u2", `versions/${version}/../../raw.json`)).toBe(false);
    expect(isProcessedArtifact("batch", "raw.json")).toBe(false);
  });
  it("stores identical files once while retaining both paths and verifies gzip restoration", async () => {
    const f = await fixture();
    await f.put("batch", "L3/history/synthetic/completion.json", { duplicate: true });
    await f.put("batch", "completion.json", { duplicate: true });
    const a = await f.prepare();
    const first = a.manifest.artifacts.find((x) => x.path === "batch/completion.json")!;
    const second = a.manifest.artifacts.find(
      (x) => x.path === "batch/L3/history/synthetic/completion.json",
    )!;
    expect(first.sha256).toBe(second.sha256);
    expect(a.chunks.filter((c) => c.artifactHash === first.sha256)).toHaveLength(first.parts);
    expect(restored(a, first.path)).toBe(restored(a, second.path));
    expect(() => verifyProcessedArchive(a)).not.toThrow();
  });
  it("escapes connector literals and asserts inside bounded transactions", async () => {
    const sql = renderArchiveStatement({
      sql: "SELECT $1=$2 AS ok",
      params: ["quote'\\backslash", "quote'\\backslash"],
      mustReturnTrue: true,
    });
    expect(sql).toContain("E'quote''\\\\backslash'");
    expect(sql).toContain("INTO archive_ok");
    expect(sql).toContain("RAISE EXCEPTION");
    const batches = archiveConnectorBatches(await (await fixture()).prepare(), 10000);
    expect(batches.length).toBeGreaterThan(2);
    expect(batches.at(-1)![0]).toContain("SET status='complete'");
    for (const batch of batches)
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(10000);
  });
  it("plans insert-only chunks with scope parameters and only completes after all verification", async () => {
    const a = await (await fixture()).prepare();
    const groups = archiveTransactions(a);
    expect(groups).toHaveLength(a.chunks.length + 2);
    for (const g of groups)
      for (const s of g) {
        expect(s.params.slice(0, 2)).toEqual([scope.tenantId, scope.subjectId]);
        expect(s.sql).not.toMatch(/\b(DELETE|DROP|TRUNCATE)\b/i);
      }
    expect(groups.at(-1)![0]!.sql).toContain("FULL JOIN actual");
    expect(groups.at(-1)![0]!.sql).toContain("SET status='complete'");
    let attempts = 0;
    await expect(
      executeArchiveTransactions(groups, async () => ({ ok: ++attempts < 2 })),
    ).rejects.toThrow("ARCHIVE_TRANSACTION_VERIFICATION_FAILED");
    expect(attempts).toBe(2); // Completion transaction was never dispatched.
    let completed = 0;
    await executeArchiveTransactions(groups, async () => {
      completed++;
      return { ok: true };
    });
    expect(completed).toBe(groups.length);
  });
});
