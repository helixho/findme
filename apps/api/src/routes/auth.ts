import type { Db } from "@findme/db";
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  createSession,
  getSessionFromHeaders,
  revokeSessionFromHeaders,
  verifyLoginPassword,
} from "../auth/session.js";

const LoginBody = z.object({ password: z.string().min(1) });
type LoginRateLimit = { maxFailures: number; windowSeconds: number };

function clientKey(c: Context) {
  const forwardedFor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || c.req.header("x-real-ip") || "unknown";
}

export function authRoutes(
  db: Db,
  opts: { loginPassword: string; sessionTtlDays?: number; rateLimit?: LoginRateLimit },
) {
  const r = new Hono();
  const rateLimit = opts.rateLimit ?? { maxFailures: 5, windowSeconds: 300 };
  const failures = new Map<string, { count: number; resetAt: number }>();

  function getFailure(key: string, now: number) {
    const current = failures.get(key);
    if (!current || current.resetAt <= now) {
      const fresh = { count: 0, resetAt: now + rateLimit.windowSeconds * 1000 };
      failures.set(key, fresh);
      return fresh;
    }
    return current;
  }

  r.post("/login", zValidator("json", LoginBody), async (c) => {
    const { password } = c.req.valid("json");
    const now = Date.now();
    const key = clientKey(c);
    const failure = getFailure(key, now);
    if (failure.count >= rateLimit.maxFailures) {
      return c.json({ error: "too_many_login_attempts" }, 429);
    }
    if (!verifyLoginPassword(password, opts.loginPassword)) {
      failure.count++;
      return c.json({ error: "invalid_password" }, 401);
    }
    failures.delete(key);
    const { token, session } = await createSession(db, {
      userAgent: c.req.header("user-agent"),
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip"),
      ttlDays: opts.sessionTtlDays,
    });
    return c.json({ token, expiresAt: session.expiresAt.toISOString() });
  });

  r.get("/session", async (c) => {
    const session = await getSessionFromHeaders(db, c.req.raw.headers);
    return c.json({
      authenticated: Boolean(session),
      expiresAt: session?.expiresAt.toISOString() ?? null,
    });
  });

  r.post("/logout", async (c) => {
    await revokeSessionFromHeaders(db, c.req.raw.headers);
    return c.json({ ok: true });
  });

  return r;
}
