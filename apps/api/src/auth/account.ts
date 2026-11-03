import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { Principal } from "../core/identity.js";

/** Verified server-side identity, never a principal supplied by the browser. */
export interface AccountIdentity extends Principal {
  sessionId: string;
  expiresAt: Date;
}
export interface AccountSessionProvider {
  resolve(request: Request): Promise<AccountIdentity | null>;
}
export interface BetterAuthSessionApi {
  api: {
    getSession(input: {
      headers: Headers;
      query: { disableCookieCache: true };
    }): Promise<unknown>;
  };
}
const Session = z.object({
  user: z.object({ id: z.string().min(1).max(200) }),
  session: z.object({
    id: z.string().min(1).max(200),
    userId: z.string().min(1).max(200),
    expiresAt: z.coerce.date(),
  }),
});

/** Pass the configured Better Auth server instance; this does not provision an IdP. */
export function betterAuthSessions(
  auth: BetterAuthSessionApi,
  issuer: string,
): AccountSessionProvider {
  if (!issuer.trim() || issuer.length > 200) throw new Error("ACCOUNT_ISSUER_REQUIRED");
  return {
    async resolve(request) {
      const raw = await auth.api.getSession({
        headers: request.headers,
        query: { disableCookieCache: true },
      });
      if (raw === null) return null;
      const value = Session.parse(raw);
      if (value.session.userId !== value.user.id || value.session.expiresAt <= new Date())
        return null;
      return {
        provider: issuer,
        principalId: value.user.id,
        sessionId: value.session.id,
        expiresAt: value.session.expiresAt,
      };
    },
  };
}

export function accountSessionAccess(provider: AccountSessionProvider, allowedOrigins: string[]) {
  if (!allowedOrigins.length) throw new Error("ACCOUNT_TRUSTED_ORIGINS_REQUIRED");
  const origins = new Set(
    allowedOrigins.map((value) => {
      const url = new URL(value);
      if (url.origin !== value || !["https:", "http:"].includes(url.protocol))
        throw new Error("ACCOUNT_TRUSTED_ORIGIN_INVALID");
      return url.origin;
    }),
  );
  // Middleware may replace Request while reading a bounded body; the Hono Context remains stable.
  const identities = new WeakMap<Context, AccountIdentity>();
  const middleware = createMiddleware(async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("Origin");
      if (!origin || !origins.has(origin))
        return c.json({ error: { code: "ACCOUNT_ORIGIN_REQUIRED" } }, 403);
    }
    let identity: AccountIdentity | null;
    try {
      identity = await provider.resolve(c.req.raw);
    } catch {
      return c.json({ error: { code: "ACCOUNT_SESSION_UNAVAILABLE" } }, 503);
    }
    if (
      !identity ||
      !identity.provider ||
      !identity.principalId ||
      !identity.sessionId ||
      !(identity.expiresAt instanceof Date) ||
      !Number.isFinite(identity.expiresAt.getTime()) ||
      identity.expiresAt <= new Date()
    )
      return c.json({ error: { code: "unauthorized" } }, 401);
    identities.set(c, identity);
    try {
      await next();
    } finally {
      identities.delete(c);
    }
  });
  return {
    middleware,
    principal(c: Context): Principal {
      const identity = identities.get(c);
      if (!identity) throw new Error("ACCOUNT_CONTEXT_REQUIRED");
      return { provider: identity.provider, principalId: identity.principalId };
    },
  };
}
