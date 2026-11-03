import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudExportService } from "../src/cloud-diagnostic/export.js";
import { ProfilePurgeService } from "../src/cloud-diagnostic/purge.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import { type ArchiveEnvironment, archiveEnvironment, sha256 } from "./helpers/archive-fixture.js";

// No .env loading, query-chain mocks, production URLs, blobs or model calls.
describe("archive lifecycle / isolated PostgreSQL", () => {
  let env: ArchiveEnvironment;
  beforeAll(async () => {
    env = await archiveEnvironment();
  });
  afterAll(async () => {
    await env?.close();
  });

  it("exports exact bytea/hash JSON with compound pagination beyond 100 parts and explicit restore handoff", async () => {
    const a = await env.profile();
    const b = await env.profile(a.tenantId);
    const foreign = await env.profile();
    const seeded = await env.seed(a, 103);
    await env.seed(a, 1, "another");
    await env.seed(b);
    await env.seed(foreign);
    const service = new CloudExportService(env.runtime.db);
    expect(service.manifest()).toMatchObject({
      parts: expect.arrayContaining(["archive_batches", "archive_chunks"]),
      snapshot: expect.stringContaining("not an atomic"),
      archive: {
        payload: expect.stringContaining("bytea"),
        restore: expect.stringContaining("not personal claims"),
      },
    });
    await env.runtime.sql.unsafe("SET bytea_output='escape'");
    const first = await service.page(a, "archive_chunks");
    expect(first.items).toHaveLength(100);
    expect(first.next_cursor).toBe(100);
    const second = await service.page(a, "archive_chunks", first.next_cursor!);
    expect(second.items).toHaveLength(4);
    expect(second.next_cursor).toBeNull();
    const items = JSON.parse(JSON.stringify([...first.items, ...second.items])) as Record<
      string,
      any
    >[];
    expect(
      new Set(items.map((x) => `${x.namespace}/${x.batch_hash}/${x.artifact_hash}/${x.part}`)).size,
    ).toBe(104);
    expect(items.every((x) => x.tenant_id === a.tenantId && x.subject_id === a.subjectId)).toBe(
      true,
    );
    const chunks = items.filter((x) => x.namespace === "synthetic");
    expect(chunks.map((x) => x.part)).toEqual(Array.from({ length: 103 }, (_, i) => i));
    for (const item of chunks) {
      expect(item.payload.startsWith("\\x")).toBe(true);
      const decoded = Buffer.from(item.payload.slice(2), "hex");
      expect(decoded).toEqual(seeded.payloads[item.part]);
      expect(sha256(decoded)).toBe(item.part_hash);
      expect(item.batch_hash).toBe(seeded.batchHash);
      expect(item.artifact_hash).toBe(seeded.artifactHash);
    }
    expect((await service.page(a, "archive_batches")).items).toHaveLength(2);
    expect((await service.page(b, "archive_chunks")).items).toHaveLength(1);
    await env.runtime.sql.unsafe("SET bytea_output='hex'");
  });

  it("enforces runtime SELECT/DELETE ownership, denies INSERT/UPDATE and all archive access to auth/identity", async () => {
    const a = await env.profile();
    const b = await env.profile(a.tenantId);
    await env.seed(a);
    await env.seed(b);
    await withProfileTransaction(env.runtime.db, a, async (tx) => {
      const rows = await tx.execute(sql`select * from av_processed_chunks`);
      expect(rows.every((x) => x.subject_id === a.subjectId)).toBe(true);
      const deleted = await tx.execute(
        sql`delete from av_processed_chunks where subject_id=${b.subjectId}::uuid returning *`,
      );
      expect(deleted).toHaveLength(0);
    });
    for (const table of ["av_processed_batches", "av_processed_chunks"]) {
      for (const statement of [`select * from ${table}`, `delete from ${table}`]) {
        await expect(env.auth.query(statement)).rejects.toMatchObject({ code: "42501" });
        await expect(env.identity.db.execute(sql.raw(statement))).rejects.toThrow();
      }
      for (const statement of [
        `update ${table} set namespace=namespace`,
        `insert into ${table} default values`,
      ]) {
        await expect(
          withProfileTransaction(env.runtime.db, a, (tx) => tx.execute(sql.raw(statement))),
        ).rejects.toThrow();
      }
    }
    expect(
      (
        await env.admin.query(
          "SELECT has_table_privilege('findme_runtime','av_processed_chunks','INSERT') AS i, has_table_privilege('findme_runtime','av_processed_chunks','UPDATE') AS u",
        )
      ).rows[0],
    ).toEqual({ i: false, u: false });
  });

  it("purges chunks before batches, preserves other profiles and identities, removes state references and replays safely", async () => {
    const a = await env.profile();
    const b = await env.profile(a.tenantId);
    const c = await env.profile();
    await env.seed(a, 2);
    await env.seed(b);
    await env.seed(c);
    await env.admin.query(
      `INSERT INTO cloud_framework_states(tenant_id,subject_id,state,content_hash,version)
      VALUES ($1,$2,$3,$4,1)`,
      [
        a.tenantId,
        a.subjectId,
        {
          u4_calls_reserved: 0,
          archive_reference: "synthetic",
          runs: [{ archive_reference: "synthetic" }],
        },
        "a".repeat(64),
      ],
    );
    const key = randomUUID();
    const purge = new ProfilePurgeService(env.runtime.db);
    expect(await purge.purge(a, key, true)).toMatchObject({ completed: true });
    expect(await purge.purge(a, key, true)).toMatchObject({ completed: true, replayed: true });
    for (const table of ["av_processed_chunks", "av_processed_batches"]) {
      expect(
        (
          await env.admin.query(
            `SELECT subject_id FROM ${table} WHERE subject_id=ANY($1::uuid[])`,
            [[a.subjectId, b.subjectId, c.subjectId]],
          )
        ).rows
          .map((x) => x.subject_id)
          .sort(),
      ).toEqual([b.subjectId, c.subjectId].sort());
    }
    expect(
      (await env.admin.query("SELECT id FROM subjects WHERE id=$1", [a.subjectId])).rowCount,
    ).toBe(1);
    expect(
      (
        await env.admin.query("SELECT id FROM profile_memberships WHERE subject_id=$1", [
          a.subjectId,
        ])
      ).rowCount,
    ).toBe(1);
    const state = (
      await env.admin.query("SELECT state FROM cloud_framework_states WHERE subject_id=$1", [
        a.subjectId,
      ])
    ).rows[0].state;
    expect(JSON.stringify(state)).not.toContain("archive_reference");
    expect(state.runs).toEqual([]);
    expect((await new CloudExportService(env.runtime.db).page(a, "archive_chunks")).items).toEqual(
      [],
    );
  });
});
