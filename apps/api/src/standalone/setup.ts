import { readFile } from "node:fs/promises";
import { createDb } from "@findme/db";
import { ProfileService } from "../auth/profiles.js";
import { ACCOUNT_ISSUER, createAccountAuth, createOwnerLogin } from "../auth/server.js";
import { accountOptions } from "../cloud-diagnostic/config.js";

const env = process.env;

/** Table and column names defined by schema.sql (pg_dump format: one column per indented line). */
function expectedColumns(schema: string) {
  const columns = new Set<string>();
  for (const [, table, body] of schema.matchAll(/CREATE TABLE public\.(\w+) \(\n([\s\S]*?)\n\);/g))
    for (const line of (body ?? "").split("\n")) {
      const name = line.match(/^ {4}("?)(\w+)\1 /)?.[2];
      if (name && name !== "CONSTRAINT") columns.add(`${table}.${name}`);
    }
  return columns;
}
function required(key: string) {
  const value = env[key];
  if (!value) throw new Error(`${key}_REQUIRED`);
  return value;
}
if (!env.DATABASE_URL_ADMIN) throw new Error("DATABASE_URL_ADMIN_REQUIRED");
const admin = createDb(env.DATABASE_URL_ADMIN, { max: 1 });
try {
  // The structure is created once on an empty database. An existing database is never changed
  // here; if it lacks anything schema.sql defines, stop instead of running against it.
  const schema = await readFile("packages/db/schema.sql", "utf8");
  const [structure] = await admin.sql`select to_regclass('public.tenants') is not null as ready`;
  if (!structure?.ready) await admin.sql.unsafe(schema);
  else {
    const actual = await admin.sql<{ name: string }[]>`
      select table_name || '.' || column_name as name from information_schema.columns
      where table_schema = 'public'`;
    const present = new Set(actual.map((row) => row.name));
    const missing = [...expectedColumns(schema)].filter((name) => !present.has(name));
    if (missing.length)
      throw new Error(
        `DATABASE_STRUCTURE_MISMATCH: this version does not convert existing databases; missing ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " …" : ""}. Deploy on an empty database (deployment/standalone/README.md, 数据库结构).`,
      );
  }
  await admin.sql.unsafe(await readFile("packages/db/access/account-runtime.sql", "utf8"));
  for (const role of ["runtime", "identity", "auth"]) {
    const password = env[`DB_${role.toUpperCase()}_PASSWORD`];
    if (!password || !/^[a-f0-9]{48,}$/.test(password)) throw new Error("DB_PASSWORD_INVALID");
    const name = `findme_${role}_login`;
    const [existing] = await admin.sql`select 1 from pg_roles where rolname=${name}`;
    if (!existing)
      await admin.sql.unsafe(
        `CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    await admin.sql.unsafe(
      `ALTER ROLE ${name} PASSWORD '${password}'; GRANT findme_${role} TO ${name}`,
    );
  }
  const config = { auth: accountOptions(env) };
  const auth = createAccountAuth({ ...config.auth, databaseUrl: required("DATABASE_URL_AUTH") });
  const identity = createDb(required("DATABASE_URL_IDENTITY"), { max: 1 });
  try {
    const email = env.OWNER_EMAIL ?? "owner@findme.local";
    const [existing] = await admin.sql`select id from auth_users where email=${email}`;
    const user =
      existing ??
      (await createOwnerLogin(auth.auth, {
        email,
        name: "Owner",
        password: required("OWNER_PASSWORD"),
      }));
    await new ProfileService(identity.db).resolve({
      provider: ACCOUNT_ISSUER,
      principalId: user.id,
    });
    console.log("[setup] database structure, runtime roles and owner account ready");
  } finally {
    await Promise.all([auth.close(), identity.sql.end()]);
  }
} finally {
  await admin.sql.end();
}
