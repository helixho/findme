import { createDb } from "@findme/db";
import type { AccountSessionProvider } from "./account.js";
import { ACCOUNT_ISSUER } from "./server.js";

/**
 * Personal instance without sign-in: every request acts as the single owner
 * account, which only exists to own the data. There is no password, login page
 * or session cookie.
 */
export function ownerSessions(ownerId: string): AccountSessionProvider {
  const identity = {
    provider: ACCOUNT_ISSUER,
    principalId: ownerId,
    sessionId: "owner",
    expiresAt: new Date("9999-12-31T00:00:00Z"),
  };
  return { resolve: async () => identity };
}

/** The single account that owns this instance's data (created by setup). */
export async function loadOwnerId(authUrl: string) {
  const db = createDb(authUrl, { max: 1 });
  try {
    const users = await db.sql<{ id: string }[]>`select id from auth_users order by "createdAt"`;
    if (users.length !== 1 || !users[0]) throw new Error("OWNER_ACCOUNT_REQUIRED");
    return users[0].id;
  } finally {
    await db.sql.end();
  }
}
