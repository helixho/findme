import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";
import { coreSchema as core, createDb } from "@findme/db";
import { and, eq } from "drizzle-orm";
import { ProfileService } from "../src/auth/profiles.js";
import { createAccountAuth, createOwnerLogin, deleteOwnerLogin } from "../src/auth/server.js";

const confirmation = "CREATE OWNER ACCOUNT";
const sourceProvider = "findme-runtime";
const sourcePrincipalId = "owner";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`OWNER_ACCOUNT_CONFIG_REQUIRED:${name}`);
  return value;
}

async function readHidden(prompt: string) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function")
    throw new Error("OWNER_ACCOUNT_INTERACTIVE_TTY_REQUIRED");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const decoder = new StringDecoder("utf8");
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      error ? reject(error) : resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const character of decoder.write(chunk)) {
        if (character === "\u0003") return finish(new Error("OWNER_ACCOUNT_CANCELLED"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (character >= " " && value.length < 128) value += character;
      }
    };
    stdin.on("data", onData);
  });
}

async function findOwnerScope(db: ReturnType<typeof createDb>["db"]) {
  const [owner] = await db
    .select({
      tenantId: core.identityBindings.tenantId,
      subjectId: core.identityBindings.subjectId,
      tenantStatus: core.tenants.status,
      subjectType: core.subjects.subjectType,
    })
    .from(core.identityBindings)
    .innerJoin(
      core.subjects,
      and(
        eq(core.identityBindings.subjectId, core.subjects.id),
        eq(core.identityBindings.tenantId, core.subjects.tenantId),
      ),
    )
    .innerJoin(core.tenants, eq(core.identityBindings.tenantId, core.tenants.id))
    .where(
      and(
        eq(core.identityBindings.provider, sourceProvider),
        eq(core.identityBindings.principalId, sourcePrincipalId),
      ),
    )
    .limit(1);
  if (!owner) throw new Error("OWNER_ACCOUNT_SOURCE_BINDING_NOT_FOUND");
  if (owner.subjectType !== "self" || owner.tenantStatus !== "active")
    throw new Error("OWNER_ACCOUNT_SOURCE_SCOPE_INVALID");
  return { tenantId: owner.tenantId, subjectId: owner.subjectId };
}

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("OWNER_ACCOUNT_INTERACTIVE_TTY_REQUIRED");
  const rl = createInterface({ input: stdin, output: stdout });
  let email: string;
  let name: string;
  let confirm: string;
  try {
    email = await rl.question("本人登录邮箱: ");
    name = await rl.question("本人显示名称: ");
    confirm = await rl.question(`输入 ${confirmation} 执行一次性建号: `);
  } finally {
    rl.close();
  }
  if (confirm !== confirmation) throw new Error("OWNER_ACCOUNT_CONFIRMATION_REQUIRED");
  const password = await readHidden("新账号密码（输入不回显）: ");
  const repeatedPassword = await readHidden("再次输入密码: ");
  if (password !== repeatedPassword) throw new Error("OWNER_ACCOUNT_PASSWORD_MISMATCH");

  const baseUrl = required("ACCOUNT_BASE_URL");
  const trustedOrigins = required("ACCOUNT_TRUSTED_ORIGINS")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const account = createAccountAuth({
    databaseUrl: required("DATABASE_URL_AUTH"),
    secret: required("ACCOUNT_SECRET"),
    baseUrl,
    trustedOrigins,
    registrationEnabled: false,
  });
  const identity = createDb(required("DATABASE_URL_IDENTITY"), { max: 1 });
  try {
    const scope = await findOwnerScope(identity.db);
    const user = await createOwnerLogin(account.auth, { email, name, password });
    const principal = {
      provider: `findme-account:${new URL(baseUrl).origin}`,
      principalId: user.id,
    };
    const sourcePrincipal = { provider: sourceProvider, principalId: sourcePrincipalId };
    const profiles = new ProfileService(identity.db);
    let bindingState: { bindingCreated: boolean; membershipCreated: boolean } | undefined;
    try {
      bindingState = await profiles.bindExistingScope(principal, scope, sourcePrincipal);
      const [profile] = await profiles.list(principal);
      if (!profile) throw new Error("OWNER_ACCOUNT_DEFAULT_PROFILE_FAILED");
      stdout.write(
        `账号已绑定到既有本人 scope 并创建默认 Profile。账号 ID: ${user.id}；Profile ID: ${profile.id}\n`,
      );
    } catch (error) {
      if (bindingState && !bindingState.bindingCreated)
        throw new Error(`OWNER_ACCOUNT_PROFILE_INIT_FAILED_ACCOUNT_RETAINED:${user.id}`);
      try {
        await deleteOwnerLogin(account.auth, user.id);
      } catch {
        // Keep the existing-scope binding if the account may still be able to log in.
        throw new Error(`OWNER_ACCOUNT_PROFILE_INIT_FAILED_ACCOUNT_RETAINED:${user.id}`);
      }
      try {
        if (bindingState) await profiles.rollbackExistingScope(principal, scope, bindingState);
      } catch {
        throw new Error(`OWNER_ACCOUNT_IDENTITY_ROLLBACK_INCOMPLETE:${user.id}`);
      }
      throw error;
    }
  } finally {
    await Promise.all([account.close(), identity.sql.end()]);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "OWNER_ACCOUNT_FAILED";
  console.error(message);
  process.exitCode = 1;
});
