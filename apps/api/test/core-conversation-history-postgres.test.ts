import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { coreSchema as c, createDb } from "@findme/db";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { ProfileService } from "../src/auth/profiles.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import {
  assertConversationSourcesCurrent,
  readConversationContext,
} from "../src/core/conversation-context.js";

it("filters excluded history and derived query context while allowing context-only reading", async () => {
  const config = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const runtime = createDb(config.runtime_url);
  const identity = createDb(config.identity_url);
  try {
    const ctx = await new ProfileService(identity.db).resolve({
      provider: "history-test",
      principalId: randomUUID(),
    });
    const ids = await withProfileTransaction(runtime.db, ctx, async (tx) => {
      const ids: string[] = [];
      for (const [content, status, eligibility] of [
        ["EXCLUDED_PRIVATE_FACT", "excluded", "eligible"],
        ["当前问题", "active", "context_only"],
      ]) {
        const [source] = await tx
          .insert(c.sourceItems)
          .values({
            ...ctx,
            sourceKind: "native_event",
            authorKind: "subject",
            content,
            usageStatus: status,
          })
          .returning();
        if (!source) throw new Error("fixture source missing");
        ids.push(source.id);
        await tx.insert(c.sourceAssessments).values({
          sourceItemId: source.id,
          version: 1,
          attributionStatus: "confirmed_subject",
          contextCompleteness: "partial",
          temporalPrecision: "unknown",
          eligibility,
          rationale: "synthetic",
        });
      }
      return ids;
    });
    const turns = [
      {
        role: "user",
        turnKind: "event",
        content: "EXCLUDED_PRIVATE_FACT",
        sourceItemId: ids[0] ?? null,
      },
      {
        role: "assistant",
        turnKind: "reply",
        content: "EXCLUDED_PRIVATE_FACT in reply",
        sourceItemId: null,
      },
      { role: "user", turnKind: "message", content: "当前问题", sourceItemId: ids[1] ?? null },
    ];
    const before = await withProfileTransaction(runtime.db, ctx, (tx) =>
      readConversationContext(tx as never, ctx, turns),
    );
    expect(before.hasUnavailable).toBe(true);
    expect(before.matter).toBe("");
    expect(before.recentUser).toBe("当前问题");
    expect(before.turns).toHaveLength(1);
    expect(JSON.stringify(before)).not.toContain("EXCLUDED_PRIVATE_FACT");
    await withProfileTransaction(runtime.db, ctx, async (tx) => {
      // Processing status must not invalidate the content dependency.
      await tx
        .update(c.sourceItems)
        .set({ sourceMeta: { reply_status: "replied" } })
        .where(eq(c.sourceItems.id, ids[1] ?? ""));
      await assertConversationSourcesCurrent(tx as never, ctx, before.sources);
    });
    await withProfileTransaction(runtime.db, ctx, (tx) =>
      tx
        .update(c.sourceItems)
        .set({ content: "已修订问题" })
        .where(eq(c.sourceItems.id, ids[1] ?? "")),
    );
    await expect(
      withProfileTransaction(runtime.db, ctx, (tx) =>
        assertConversationSourcesCurrent(tx as never, ctx, before.sources),
      ),
    ).rejects.toThrow("对话材料已变化");
  } finally {
    await Promise.all([runtime.sql.end(), identity.sql.end()]);
  }
});
