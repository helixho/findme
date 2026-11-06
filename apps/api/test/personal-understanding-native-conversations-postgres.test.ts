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
            content: `OLD_ANALYSIS。你更想选哪个？\nA. 参加\nB. 休息\n${"具体背景".repeat(500)}`,
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
    const full = await reader.read(ctx, { conversationId, includeAnalysis: true });
    expect(full.turns[0]!.content!.length).toBeGreaterThan(1500);
    expect(full.turns[1]!.content).toBe("B");
    const filtered = await reader.read(ctx, { conversationId });
    expect(filtered.turns[0]!.content).toContain("你更想选哪个？");
    expect(filtered.turns[0]!.content).toContain("B. 休息");
    expect(JSON.stringify(filtered)).not.toContain("OLD_ANALYSIS");
    expect(JSON.stringify(filtered)).not.toContain("具体背景");
    const answerPage = await reader.read(ctx, { conversationId, cursor: 1, limit: 1 });
    expect(answerPage.preceding_question_background).toContain("B. 休息");
    expect(full.turns[0]!.qualification).toBe("assistant_context_not_evidence");
    const first = await reader.read(ctx, { conversationId, limit: 1 });
    expect(first.next_cursor).toBe(1);
    await expect(reader.read(other, { conversationId })).rejects.toThrow(
      "CONVERSATION_NOT_AVAILABLE",
    );
    // A source read by B must remain a dependency when C reads B's reply.
    const sourceA = await withProfileTransaction(runtime.db, ctx, async (tx) => {
      const [a] = await tx
        .insert(c.sourceItems)
        .values({
          ...ctx,
          sourceKind: "native_event",
          authorKind: "subject",
          content: "A-private-original",
        })
        .returning();
      if (!a) throw new Error("fixture");
      await tx.insert(c.sourceAssessments).values({
        sourceItemId: a.id,
        version: 1,
        attributionStatus: "confirmed_subject",
        contextCompleteness: "partial",
        temporalPrecision: "unknown",
        eligibility: "eligible",
        rationale: "synthetic",
      });
      const [reply] = await tx
        .insert(c.explorationTurns)
        .values({
          explorationId: conversationId,
          role: "assistant",
          turnKind: "pi_reply",
          content: "A-private-original inside B",
          createdAt: new Date(3000),
        })
        .returning();
      if (!reply) throw new Error("fixture");
      await tx
        .update(c.sourceItems)
        .set({
          sourceMeta: { reply: { engine: "pi", turn_id: reply.id, source_ids: [a.id, sourceId] } },
        })
        .where(eq(c.sourceItems.id, sourceId));
      return a.id;
    });
    const beforeAExcluded = await reader.read(ctx, { conversationId, includeAnalysis: true });
    expect(beforeAExcluded.dependencies.map((d) => d.sourceId)).toContain(sourceA);
    expect(beforeAExcluded.turns.find((t) => t.kind === "pi_reply")?.content).toContain(
      "A-private-original",
    );
    await withProfileTransaction(runtime.db, ctx, (tx) =>
      tx
        .update(c.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(c.sourceItems.id, sourceA)),
    );
    const afterAExcluded = await reader.read(ctx, { conversationId, includeAnalysis: true });
    expect(afterAExcluded.turns.find((t) => t.kind === "pi_reply")?.content).toBeNull();
    expect(JSON.stringify(afterAExcluded)).not.toContain("A-private-original");
    await withProfileTransaction(runtime.db, ctx, (tx) =>
      tx
        .update(c.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(c.sourceItems.id, sourceId)),
    );
    const independentReply = await withProfileTransaction(runtime.db, ctx, async (tx) => {
      const [independent] = await tx
        .insert(c.sourceItems)
        .values({
          ...ctx,
          sourceKind: "native_event",
          authorKind: "subject",
          content: "independent valid input",
        })
        .returning();
      if (!independent) throw new Error("fixture");
      await tx.insert(c.sourceAssessments).values({
        sourceItemId: independent.id,
        version: 1,
        attributionStatus: "confirmed_subject",
        contextCompleteness: "sufficient",
        temporalPrecision: "unknown",
        eligibility: "eligible",
        rationale: "synthetic",
      });
      await tx.insert(c.explorationTurns).values({
        explorationId: conversationId,
        sourceItemId: independent.id,
        role: "user",
        turnKind: "message",
        content: independent.content,
        createdAt: new Date(4000),
      });
      const [reply] = await tx
        .insert(c.explorationTurns)
        .values({
          explorationId: conversationId,
          role: "assistant",
          turnKind: "pi_reply",
          content: "Independent answer. Which option?\nA. Continue\nB. Stop",
          createdAt: new Date(5000),
        })
        .returning();
      if (!reply) throw new Error("fixture");
      await tx
        .update(c.sourceItems)
        .set({
          sourceMeta: { reply: { engine: "pi", turn_id: reply.id, source_ids: [independent.id] } },
        })
        .where(eq(c.sourceItems.id, independent.id));
      return reply.id;
    });
    const precise = await reader.read(ctx, { conversationId, includeAnalysis: true });
    expect(precise.turns.find((turn) => turn.id === independentReply)?.content).toContain(
      "Independent answer",
    );
    expect(precise.turns[0]?.content).toBeNull();
    const hidden = await reader.read(ctx, { conversationId, limit: 1 });
    expect(hidden.assistant_context_withheld).toBe(true);
    expect(hidden.turns[0]!.content).toBeNull();
    expect((await reader.read(ctx, { conversationId, cursor: 1 })).turns[0]!.content).toBeNull();
  } finally {
    await Promise.all([runtime.sql.end(), identity.sql.end()]);
  }
});

it("cuts cross-conversation bodies and question background off at asOf but checks present source status", async () => {
  const cfg = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const runtime = createDb(cfg.runtime_url);
  const identity = createDb(cfg.identity_url);
  try {
    const ctx = await new ProfileService(identity.db).resolve({
      provider: "native-asof",
      principalId: randomUUID(),
    });
    const base = 1700000000000;
    const fixture = await withProfileTransaction(runtime.db, ctx, async (tx) => {
      const [experience] = await tx
        .insert(c.experiences)
        .values({ ...ctx, summary: "MUTABLE_FUTURE_SUMMARY" })
        .returning();
      const [conversation] = await tx
        .insert(c.explorations)
        .values({ ...ctx, experienceId: experience!.id })
        .returning();
      if (!conversation) throw Error("fixture");
      const add = async (text: string, captured: number, posted: number) => {
        const [source] = await tx
          .insert(c.sourceItems)
          .values({
            ...ctx,
            sourceKind: "native_event",
            authorKind: "subject",
            content: text,
            capturedAt: new Date(base + captured),
            sourceMeta: { exploration_id: conversation.id },
          })
          .returning();
        if (!source) throw Error("fixture");
        await tx.insert(c.sourceAssessments).values({
          sourceItemId: source.id,
          version: 1,
          attributionStatus: "confirmed_subject",
          contextCompleteness: "sufficient",
          temporalPrecision: "unknown",
          eligibility: "eligible",
          rationale: "synthetic",
        });
        await tx.insert(c.explorationTurns).values({
          explorationId: conversation.id,
          sourceItemId: source.id,
          role: "user",
          turnKind: "message",
          content: text,
          createdAt: new Date(base + posted),
        });
        return source.id;
      };
      const early = await add("EARLY_ALLOWED_ORIGINAL", 1000, 1000);
      await tx.insert(c.explorationTurns).values({
        explorationId: conversation.id,
        role: "assistant",
        turnKind: "reply",
        content: "EARLY_BACKGROUND。你选哪个？\nA. 前者\nB. 后者",
        createdAt: new Date(base + 1500),
      });
      await add("FUTURE_SOURCE_AND_TURN", 3000, 3000);
      await add("FUTURE_CAPTURE_BACKDATED_TURN", 3000, 1200);
      await add("FUTURE_TURN_EARLY_CAPTURE", 1000, 3500);
      await tx.insert(c.explorationTurns).values({
        explorationId: conversation.id,
        role: "assistant",
        turnKind: "reply",
        content: "FUTURE_ASSISTANT_QUESTION？",
        createdAt: new Date(base + 4000),
      });
      return { conversationId: conversation.id, early };
    });
    const reader = new NativeConversationReader(runtime.db);
    const input = {
      conversationId: fixture.conversationId,
      asOf: new Date(base + 2000).toISOString(),
      includeAnalysis: true,
    };
    const result = await reader.read(ctx, input);
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]?.content).toBe("EARLY_ALLOWED_ORIGINAL");
    expect(JSON.stringify(result)).not.toContain("FUTURE_");
    expect(result.dependencies.map((d) => d.sourceId)).toEqual([fixture.early]);
    const page = await reader.read(ctx, { ...input, includeAnalysis: false, cursor: 1, limit: 1 });
    expect(page.turns[0]?.content).toContain("你选哪个？");
    expect(page.next_cursor).toBeNull();
    await withProfileTransaction(runtime.db, ctx, (tx) =>
      tx
        .update(c.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(c.sourceItems.id, fixture.early)),
    );
    const nowExcluded = await reader.read(ctx, input);
    expect(nowExcluded.turns[0]?.content).toBeNull();
    expect(JSON.stringify(nowExcluded)).not.toContain("EARLY_ALLOWED_ORIGINAL");
    expect(nowExcluded.turns[1]?.content).toBeNull();
  } finally {
    await Promise.all([runtime.sql.end(), identity.sql.end()]);
  }
});
