import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { z } from "zod";
import { betterAuthSessions } from "./account.js";

/** Login identity issuer. Independent of the instance URL so a rebuilt node keeps its accounts. */
export const ACCOUNT_ISSUER = "findme-account";

export type AccountConfig = {
  databaseUrl: string;
  secret: string;
  baseUrl: string;
  trustedOrigins: string[];
  registrationEnabled?: boolean;
  sendMail?: (mail: { to: string; subject: string; text: string }) => Promise<void>;
};
type AccountAuth = ReturnType<typeof createAccountAuth>["auth"];

/**
 * Create a verified email/password account from a trusted, one-off maintenance
 * process. This deliberately uses Better Auth's own password hasher and
 * internal adapter; it is not exposed by the HTTP auth handler.
 */
export async function createOwnerLogin(
  auth: AccountAuth,
  input: { email: string; name: string; password: string },
) {
  const email = z.string().email().parse(input.email.trim().toLowerCase());
  const name = input.name.trim();
  if (!name) throw new Error("OWNER_ACCOUNT_INPUT_INVALID");

  const context = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = context.password.config;
  if (input.password.length < minPasswordLength || input.password.length > maxPasswordLength)
    throw new Error("OWNER_ACCOUNT_PASSWORD_LENGTH_INVALID");
  if (await context.internalAdapter.findUserByEmail(email))
    throw new Error("OWNER_ACCOUNT_ALREADY_EXISTS");

  const password = await context.password.hash(input.password);
  const user = await context.internalAdapter.createUser(
    { email, name, emailVerified: true },
    { method: "admin" },
  );
  try {
    await context.internalAdapter.linkAccount({
      providerId: "credential",
      accountId: user.id,
      userId: user.id,
      password,
    });
  } catch (error) {
    try {
      await context.internalAdapter.deleteUser(user.id);
    } catch {
      throw new Error(`OWNER_ACCOUNT_CREDENTIAL_ROLLBACK_INCOMPLETE:${user.id}`);
    }
    throw error;
  }
  return { id: user.id, email: user.email };
}

/** Compensate only a user created by the maintenance flow. */
export async function deleteOwnerLogin(auth: AccountAuth, userId: string) {
  const context = await auth.$context;
  await context.internalAdapter.deleteUser(userId);
}

/** Construction only: no migration, provisioning, or eager authentication request. */
export function createAccountAuth(config: AccountConfig) {
  if (config.secret.length < 32) throw new Error("ACCOUNT_SECRET_TOO_SHORT");
  const url = new URL(config.baseUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))
    throw new Error("ACCOUNT_HTTPS_REQUIRED");
  if (config.registrationEnabled && !config.sendMail) throw new Error("ACCOUNT_MAIL_REQUIRED");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  const auth = betterAuth({
    database: pool,
    secret: config.secret,
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    trustedOrigins: config.trustedOrigins,
    user: { modelName: "auth_users" },
    session: {
      modelName: "auth_sessions",
      cookieCache: { enabled: false },
      // Personal use: stays signed in. 400 days is the cookie maximum; each
      // day of use renews it, so only 400 days without any use signs out.
      expiresIn: 60 * 60 * 24 * 400,
      updateAge: 60 * 60 * 24,
    },
    account: { modelName: "auth_accounts", accountLinking: { enabled: false } },
    verification: { modelName: "auth_verifications" },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "auth_rate_limits",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 60, max: 8 },
        "/sign-up/email": { window: 60, max: 4 },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.registrationEnabled,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      sendResetPassword: async ({ user, url }) => {
        if (!config.sendMail) throw new Error("ACCOUNT_MAIL_UNAVAILABLE");
        await config.sendMail({
          to: user.email,
          subject: "FindMe · 重置密码",
          text: `使用此链接重置密码：${url}`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        if (!config.sendMail) throw new Error("ACCOUNT_MAIL_UNAVAILABLE");
        await config.sendMail({
          to: user.email,
          subject: "FindMe · 验证邮箱",
          text: `验证你的 FindMe 邮箱：${url}`,
        });
      },
    },
    advanced: { useSecureCookies: url.protocol === "https:" },
  });
  return {
    auth,
    sessions: betterAuthSessions(auth, ACCOUNT_ISSUER),
    close: () => pool.end(),
  };
}
