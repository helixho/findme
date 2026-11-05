import { readFile } from "node:fs/promises";
import { createDb } from "@findme/db";
import { ProfileService } from "../auth/profiles.js";
import { ACCOUNT_ISSUER, createAccountAuth, createOwnerLogin } from "../auth/server.js";
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
    // runtime.env is the owner's login: OWNER_EMAIL may be a plain user name
    // (signs in as <name>@findme.local) and OWNER_PASSWORD is applied on every
    // setup, so changing either there and re-running setup changes the login.
    const login = (env.OWNER_EMAIL ?? "owner@findme.local").trim().toLowerCase();
    const email = login.includes("@") ? login : `${login}@findme.local`;
    let [existing] = await admin.sql<
      { id: string }[]
    >`select id from auth_users where email=${email}`;
    if (!existing) {
      // A personal instance has one account: a new name renames it.
      const users = await admin.sql<{ id: string }[]>`select id from auth_users`;
      if (users.length === 1 && users[0]) {
        existing = users[0];
        await admin.sql`update auth_users set email=${email}, "updatedAt"=now() where id=${existing.id}`;
      }
    }
    if (existing && env.OWNER_PASSWORD) {
      const context = await auth.auth.$context;
      await context.internalAdapter.updatePassword(
        existing.id,
        await context.password.hash(env.OWNER_PASSWORD),
      );
    }
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
