import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { coreSchema as c, createDb } from "@findme/db";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { ProfileService } from "../src/auth/profiles.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import { NativeConversationReader } from "../src/personal-understanding/native-conversations.js";

it("reads complete native messages, preserves short-answer context and withholds excluded history", async () => {
  const config = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const runtime = createDb(config.runtime_url);
  const identity = createDb(config.identity_url);
  try {
    const profiles = new ProfileService(identity.db);
    const ctx = await profiles.resolve({
      provider: "native-reader-test",
      principalId: randomUUID(),
    });
    const other = await profiles.resolve({
      provider: "native-reader-test",
      principalId: randomUUID(),
    });
    const { conversationId, sourceId } = await withProfileTransaction(
      runtime.db,
      ctx,
      async (tx) => {
        const [experience] = await tx
          .insert(c.experiences)
          .values({ ...ctx, summary: "合成活动选择" })
          .returning();
        const [conversation] = await tx
          .insert(c.explorations)
          .values({ ...ctx, experienceId: experience!.id })
          .returning();
        const [source] = await tx
          .insert(c.sourceItems)
          .values({ ...ctx, sourceKind: "native_event", authorKind: "subject", content: "B" })
          .returning();
        await tx.insert(c.sourceAssessments).values({
          sourceItemId: source!.id,
          version: 1,
          attributionStatus: "confirmed_subject",
          contextCompleteness: "partial",
          temporalPrecision: "unknown",
          eligibility: "eligible",
          rationale: "synthetic",
        });
        await tx.insert(c.explorationTurns).values([
          {
            explorationId: conversation!.id,
            role: "assistant",
            turnKind: "reply",
            content: `A 参加；B 休息。${"具体背景".repeat(500)}`,
            createdAt: new Date(1000),
          },
          {
            explorationId: conversation!.id,
            role: "user",
            turnKind: "message",
            content: "B",
            sourceItemId: source!.id,
            createdAt: new Date(2000),
          },
        ]);
        return { conversationId: conversation!.id, sourceId: source!.id };
      },
    );
    const reader = new NativeConversationReader(runtime.db);
    const full = await reader.read(ctx, { conversationId });
    expect(full.turns[0]!.content!.length).toBeGreaterThan(1500);
    expect(full.turns[1]!.content).toBe("B");
    expect(full.turns[0]!.qualification).toBe("assistant_context_not_evidence");
    const first = await reader.read(ctx, { conversationId, limit: 1 });
    expect(first.next_cursor).toBe(1);
    await expect(reader.read(other, { conversationId })).rejects.toThrow(
      "CONVERSATION_NOT_AVAILABLE",
    );
    await withProfileTransaction(runtime.db, ctx, (tx) =>
      tx
        .update(c.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(c.sourceItems.id, sourceId)),
    );
    const hidden = await reader.read(ctx, { conversationId, limit: 1 });
    expect(hidden.assistant_context_withheld).toBe(true);
    expect(hidden.turns[0]!.content).toBeNull();
    expect((await reader.read(ctx, { conversationId, cursor: 1 })).turns[0]!.content).toBeNull();
  } finally {
    await Promise.all([runtime.sql.end(), identity.sql.end()]);
  }
});
