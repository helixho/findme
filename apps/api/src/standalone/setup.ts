import { readFile } from "node:fs/promises";
import { createDb } from "@findme/db";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ProfileService } from "../auth/profiles.js";
import { createAccountAuth, createOwnerLogin } from "../auth/server.js";
import { cloudOptions } from "../cloud-diagnostic/config.js";

const env = process.env;
function required(key: string) {
  const value = env[key];
  if (!value) throw new Error(`${key}_REQUIRED`);
  return value;
}
if (!env.DATABASE_URL_MIGRATION) throw new Error("DATABASE_URL_MIGRATION_REQUIRED");
const admin = createDb(env.DATABASE_URL_MIGRATION, { max: 1 });
try {
  await migrate(admin.db, { migrationsFolder: "packages/db/migrations" });
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
  const config = cloudOptions(env);
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
      provider: `findme-account:${new URL(config.auth.baseUrl).origin}`,
      principalId: user.id,
    });
    console.log("[setup] migrations, runtime roles and owner account ready");
  } finally {
    await Promise.all([auth.close(), identity.sql.end()]);
  }
} finally {
  await admin.sql.end();
}
