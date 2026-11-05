import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { createDb } from "@findme/db";

type Sql = ReturnType<typeof createDb>["sql"];

export type Migration = { name: string; sql: string };

/** Ordered upgrade scripts: packages/db/migrations/NNNN-name.sql. */
export async function readMigrations(dir: string): Promise<Migration[]> {
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => /^\d{4}-[\w-]+\.sql$/.test(name))
    .sort();
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(path.join(dir, name), "utf8") })),
  );
}

/** Table and column names defined by schema.sql (pg_dump format: one column per indented line). */
export function expectedColumns(schema: string) {
  const columns = new Set<string>();
  for (const [, table, body] of schema.matchAll(/CREATE TABLE public\.(\w+) \(\n([\s\S]*?)\n\);/g))
    for (const line of (body ?? "").split("\n")) {
      const name = line.match(/^ {4}("?)(\w+)\1 /)?.[2];
      if (name && name !== "CONSTRAINT") columns.add(`${table}.${name}`);
    }
  return columns;
}

/**
 * Bring a database to the current structure while keeping its data.
 * An empty database gets schema.sql, which already contains every migration,
 * so all of them are recorded as applied. An existing database runs the
 * migrations it has not applied yet, in name order, each in its own
 * transaction. The final column check catches a schema.sql change that was
 * made without a matching migration.
 */
export async function applyStructure(sql: Sql, schema: string, migrations: Migration[]) {
  const [structure] = await sql`select to_regclass('public.tenants') is not null as ready`;
  const fresh = !structure?.ready;
  if (fresh) await sql.unsafe(schema);
  await sql`create table if not exists public.schema_migrations (
    name text primary key,
    applied_at timestamp with time zone default now() not null
  )`;
  const done = new Set(
    (await sql<{ name: string }[]>`select name from public.schema_migrations`).map((r) => r.name),
  );
  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    await sql.begin(async (tx) => {
      if (!fresh) await tx.unsafe(migration.sql);
      await tx`insert into public.schema_migrations (name) values (${migration.name})`;
    });
    if (!fresh) applied.push(migration.name);
  }
  const actual = await sql<{ name: string }[]>`
    select table_name || '.' || column_name as name from information_schema.columns
    where table_schema = 'public'`;
  const present = new Set(actual.map((row) => row.name));
  const missing = [...expectedColumns(schema)].filter((name) => !present.has(name));
  if (missing.length)
    throw new Error(
      `DATABASE_STRUCTURE_MISMATCH: missing ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " …" : ""}; add a migration in packages/db/migrations for this change.`,
    );
  return { fresh, applied };
}
