import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDb } from "@findme/db";
import { afterAll, describe, expect, it } from "vitest";
import { applyStructure, readMigrations } from "../src/standalone/migrate.js";

// Deploy-time structure: a new database gets schema.sql, an existing one keeps
// its data and applies pending migrations.
const adminUrl = process.env.DATABASE_URL_TEST;
const dbDescribe = adminUrl ? describe : describe.skip;

dbDescribe("standalone database structure / migrations", () => {
  const name = `migrate_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = createDb(adminUrl ?? "", { max: 1 });
  let scratch: ReturnType<typeof createDb> | null = null;
  afterAll(async () => {
    await scratch?.sql.end();
    await admin.sql.unsafe(`drop database if exists ${name} with (force)`);
    await admin.sql.end();
  });

  it("creates a new database and upgrades an existing one without losing data", async () => {
    await admin.sql.unsafe(`create database ${name}`);
    const url = new URL(adminUrl ?? "");
    url.pathname = `/${name}`;
    scratch = createDb(url.toString(), { max: 1 });
    const schema = await readFile("../../packages/db/schema.sql", "utf8");
    const shipped = await readMigrations("../../packages/db/migrations");

    const created = await applyStructure(scratch.sql, schema, shipped);
    expect(created).toEqual({ fresh: true, applied: [] });

    await scratch.sql`insert into app_settings (key, value) values ('kept', '{"a":1}')`;
    const next = {
      name: "9999-add-note.sql",
      sql: "alter table app_settings add column note text",
    };
    const upgraded = await applyStructure(
      scratch.sql,
      schema.replace(
        "    updated_at timestamp with time zone DEFAULT now() NOT NULL\n);",
        "    updated_at timestamp with time zone DEFAULT now() NOT NULL,\n    note text\n);",
      ),
      [...shipped, next],
    );
    expect(upgraded).toEqual({ fresh: false, applied: ["9999-add-note.sql"] });
    const [kept] = await scratch.sql`select value, note from app_settings where key = 'kept'`;
    expect(kept).toEqual({ value: { a: 1 }, note: null });

    // Applied once only; a schema change without its migration is reported.
    expect(await applyStructure(scratch.sql, schema, [...shipped, next])).toEqual({
      fresh: false,
      applied: [],
    });
    await expect(
      applyStructure(
        scratch.sql,
        schema.replace(
          "CREATE TABLE public.app_settings (",
          "CREATE TABLE public.app_settings (\n    extra text,",
        ),
        [...shipped, next],
      ),
    ).rejects.toThrow("DATABASE_STRUCTURE_MISMATCH");
  });
});
