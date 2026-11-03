import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "@findme/db";
import { schema } from "@findme/db";
import { eq } from "drizzle-orm";

const TOKEN_BYTES = 32;
export const DEFAULT_SESSION_TTL_DAYS = 30;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sameSecret(a: string, b: string) {
  const ah = Buffer.from(sha256(a));
  const bh = Buffer.from(sha256(b));
  return ah.length === bh.length && timingSafeEqual(ah, bh);
}

export function verifyLoginPassword(input: string, expected: string) {
  return expected.length > 0 && sameSecret(input, expected);
}

export function bearerToken(headers: Headers) {
  const header = headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function hashSessionToken(token: string) {
  return sha256(token);
}

export async function createSession(
  db: Db,
  opts: { userAgent?: string | null; ipAddress?: string | null; ttlDays?: number } = {},
) {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const ttlDays = opts.ttlDays ?? DEFAULT_SESSION_TTL_DAYS;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const [row] = await db
    .insert(schema.appSessions)
    .values({
      tokenHash: hashSessionToken(token),
      expiresAt,
      userAgent: opts.userAgent ?? null,
      ipAddress: opts.ipAddress ?? null,
    })
    .returning();
  if (!row) throw new Error("session_create_failed");
  return { token, session: row };
}

export async function getSessionByToken(db: Db, token: string) {
  const [session] = await db
    .select()
    .from(schema.appSessions)
    .where(eq(schema.appSessions.tokenHash, hashSessionToken(token)))
    .limit(1);
  if (!session) return null;
  const now = new Date();
  if (session.revokedAt || session.expiresAt <= now) return null;
  await db
    .update(schema.appSessions)
    .set({ lastSeenAt: now })
    .where(eq(schema.appSessions.id, session.id));
  return session;
}

export async function getSessionFromHeaders(db: Db, headers: Headers) {
  const token = bearerToken(headers);
  if (!token) return null;
  return getSessionByToken(db, token);
}

export async function revokeSessionFromHeaders(db: Db, headers: Headers) {
  const token = bearerToken(headers);
  if (!token) return false;
  const [row] = await db
    .update(schema.appSessions)
    .set({ revokedAt: new Date() })
    .where(eq(schema.appSessions.tokenHash, hashSessionToken(token)))
    .returning();
  return Boolean(row);
}
