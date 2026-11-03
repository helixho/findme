import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudExportService } from "../src/cloud-diagnostic/export.js";
import { ProfilePurgeService } from "../src/cloud-diagnostic/purge.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import {
  type ArchiveEnvironment,
  archiveEnvironment,
  archiveFile,
  sha256,
} from "./helpers/archive-fixture.js";

// No .env loading, query-chain mocks, production URLs, blobs or model calls.
describe("archive lifecycle / isolated PostgreSQL", () => {
  let env: ArchiveEnvironment;
  let adoption: string;
  beforeAll(async () => {
    env = await archiveEnvironment();
    adoption = await archiveFile("packages/db/migrations/0012_open_lionheart.sql");
  });
  afterAll(async () => {
    await env?.close();
  });

  it("creates fresh typed tables without enabling account RLS; access script can be reapplied after adoption", async () => {
    await env.migrationDatabase(async (db) => {
      const access = await archiveFile("packages/db/access/account-runtime.sql");
      await db.query(access); // optional archive absent: established ordering remains supported
      await db.query(adoption);
      const flags = await db.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('av_processed_batches'::regclass,'av_processed_chunks'::regclass)",
      );
      expect(flags.rows).toEqual([
        { relrowsecurity: false, relforcerowsecurity: false },
        { relrowsecurity: false, relforcerowsecurity: false },
      ]);
      expect(
        (
          await db.query(
            "SELECT data_type FROM information_schema.columns WHERE table_name='av_processed_chunks' AND column_name='payload'",
          )
        ).rows[0].data_type,
      ).toBe("bytea");
      const types = (
        await db.query(
          "SELECT table_name,udt_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('av_processed_batches','av_processed_chunks') ORDER BY table_name,ordinal_position",
        )
      ).rows;
      expect(
        types.filter((x) => x.table_name === "av_processed_batches").map((x) => x.udt_name),
      ).toEqual(["uuid", "uuid", "text", "text", "jsonb", "text", "timestamptz"]);
      expect(
        types.filter((x) => x.table_name === "av_processed_chunks").map((x) => x.udt_name),
      ).toEqual(["uuid", "uuid", "text", "text", "text", "int4", "text", "bytea"]);
      expect(types.every((x) => x.is_nullable === "NO")).toBe(true);
      await db.query(access);
      await db.query(access);
      expect(
        (
          await db.query(
            "SELECT cmd FROM pg_policies WHERE tablename LIKE 'av_processed_%' ORDER BY tablename,cmd",
          )
        ).rows.map((x) => x.cmd),
      ).toEqual(["DELETE", "SELECT", "DELETE", "SELECT"]);
      expect(
        (
          await db.query(
            "SELECT relrowsecurity FROM pg_class WHERE oid='av_processed_chunks'::regclass",
          )
        ).rows[0].relrowsecurity,
      ).toBe(true);
      // Reapplication/adoption preserves already enabled access policies.
      await db.query(adoption);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM pg_policies WHERE tablename LIKE 'av_processed_%'",
          )
        ).rows[0].n,
      ).toBe(4);
    });
  }, 60000);

  it("adopts EXACT supplemental DDL, preserving binary data, hashes, keys and constraints", async () => {
    await env.migrationDatabase(async (db) => {
      await db.query(await archiveFile("apps/api/scripts/av-processed-archive-schema.sql"));
      const tenant = randomUUID();
      const subject = randomUUID();
      await db.query("INSERT INTO tenants(id) VALUES ($1)", [tenant]);
      await db.query("INSERT INTO subjects(id,tenant_id) VALUES ($1,$2)", [subject, tenant]);
      const hash = "a".repeat(64);
      const payload = Buffer.from([0, 255, 128, 92]);
      await db.query(
        "INSERT INTO av_processed_batches(tenant_id,subject_id,namespace,batch_hash,manifest) VALUES ($1,$2,'legacy',$3,$4)",
        [tenant, subject, hash, { format: "findme-av-processed-archive@2" }],
      );
      await db.query("INSERT INTO av_processed_chunks VALUES ($1,$2,'legacy',$3,$3,0,$4,$5)", [
        tenant,
        subject,
        hash,
        sha256(payload),
        payload,
      ]);
      const coreFlags = (
        await db.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='subjects'::regclass",
        )
      ).rows;
      await db.query(adoption);
      expect(
        (
          await db.query(
            "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='subjects'::regclass",
          )
        ).rows,
      ).toEqual(coreFlags);
      expect(
        (
          await db.query(
            "SELECT conname FROM pg_constraint WHERE conrelid='av_processed_chunks'::regclass AND contype='f'",
          )
        ).rows[0].conname,
      ).toBe("av_processed_chunks_batch_fk");
      const row = (await db.query("SELECT * FROM av_processed_chunks")).rows[0];
      expect(row.payload).toEqual(payload);
      expect(row.part_hash).toBe(sha256(payload));
      expect((await db.query("SELECT status FROM av_processed_batches")).rows[0].status).toBe(
        "staging",
      );
      expect(
        (
          await db.query(
            "SELECT relrowsecurity FROM pg_class WHERE oid='av_processed_chunks'::regclass",
          )
        ).rows[0].relrowsecurity,
      ).toBe(false);
      await expect(db.query("DELETE FROM av_processed_batches")).rejects.toMatchObject({
        code: "23503",
      });
      await expect(
        db.query("UPDATE av_processed_chunks SET payload='\\x00'::bytea"),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(db.query("UPDATE av_processed_chunks SET part=-1")).rejects.toMatchObject({
        code: "23514",
      });
      await expect(
        db.query("UPDATE av_processed_chunks SET artifact_hash='bad'"),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.query("UPDATE av_processed_batches SET manifest='{}'::jsonb, status='bad'"),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.query(
          "UPDATE av_processed_chunks SET payload=decode(repeat('00',196609),'hex'), part_hash=encode(sha256(decode(repeat('00',196609),'hex')),'hex')",
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  }, 60000);

  it("rejects incompatible supplemental columns, defaults, constraints and partial pairs transactionally", async () => {
    await env.migrationDatabase(async (db) => {
      await db.query(await archiveFile("apps/api/scripts/av-processed-archive-schema.sql"));
      for (const mutate of [
        "ALTER TABLE av_processed_chunks ADD COLUMN unexpected text",
        "ALTER TABLE av_processed_chunks ALTER COLUMN part TYPE bigint",
        "ALTER TABLE av_processed_chunks ALTER COLUMN payload DROP NOT NULL",
        "CREATE UNIQUE INDEX incompatible_archive_unique ON av_processed_chunks(part)",
        "ALTER TABLE av_processed_batches ALTER COLUMN status SET DEFAULT 'complete'",
        "ALTER TABLE av_processed_chunks DROP CONSTRAINT av_processed_chunks_check",
        "ALTER TABLE av_processed_chunks DROP CONSTRAINT av_processed_chunks_part_check; ALTER TABLE av_processed_chunks ADD CHECK(part>=1)",
        "DROP TABLE av_processed_chunks",
      ]) {
        await db.query("BEGIN");
        try {
          await db.query(mutate);
          await expect(db.query(adoption)).rejects.toThrow("ARCHIVE_LEGACY_SHAPE_MISMATCH");
        } finally {
          await db.query("ROLLBACK");
        }
        expect(
          (
            await db.query(
              "SELECT to_regclass('_findme_archive_adoption._expected_av_processed_batches') AS t",
            )
          ).rows[0].t,
        ).toBeNull();
      }
    });
  }, 60000);

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
