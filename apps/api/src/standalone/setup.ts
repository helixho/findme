import { readFile } from "node:fs/promises";
import { createDb } from "@findme/db";
import { ProfileService } from "../auth/profiles.js";
import { ACCOUNT_ISSUER, createAccountAuth } from "../auth/server.js";
import { accountOptions } from "../cloud-diagnostic/config.js";
import { applyStructure, readMigrations } from "./migrate.js";

const env = process.env;

function required(key: string) {
  const value = env[key];
  if (!value) throw new Error(`${key}_REQUIRED`);
  return value;
}
if (!env.DATABASE_URL_ADMIN) throw new Error("DATABASE_URL_ADMIN_REQUIRED");
const admin = createDb(env.DATABASE_URL_ADMIN, { max: 1 });
try {
  // New databases get schema.sql; existing ones apply pending migrations and keep their data.
  const schema = await readFile("packages/db/schema.sql", "utf8");
  const migrations = await readMigrations("packages/db/migrations");
  const { fresh, applied } = await applyStructure(admin.sql, schema, migrations);
  console.log(
    `[setup] ${fresh ? "created the database structure" : `existing database; applied ${applied.length ? applied.join(", ") : "no new migrations"}`}`,
  );
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
    // No sign-in: one account owns the data and has no password. Existing
    // passwords and sessions from the former login are removed.
    let [owner] = await admin.sql<{ id: string }[]>`select id from auth_users order by "createdAt"`;
    if (!owner) {
      const context = await auth.auth.$context;
      owner = await context.internalAdapter.createUser(
        { email: "owner@findme.local", name: "我", emailVerified: true },
        { method: "admin" },
      );
    }
    await admin.sql`delete from auth_accounts where "providerId" = 'credential'`;
    await admin.sql`delete from auth_sessions`;
    const user = owner;
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
