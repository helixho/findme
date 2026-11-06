import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { coreSchema as c, createDb } from "@findme/db";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { ProfileService } from "../src/auth/profiles.js";
import { invalidateCloudSources } from "../src/cloud-diagnostic/effects.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import { loadPendingInputs } from "../src/core/conversation.js";

it("invalidates only dependent replies and restores only readable user inputs to pending", async () => {
  const config = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const runtime = createDb(config.runtime_url);
  const identity = createDb(config.identity_url);
  try {
    const ctx = await new ProfileService(identity.db).resolve({
      provider: "precise-pi-invalidation",
      principalId: randomUUID(),
    });
    const fixture = await withProfileTransaction(runtime.db, ctx, async (tx) => {
      const [experience] = await tx
        .insert(c.experiences)
        .values({ ...ctx, summary: "synthetic" })
        .returning();
      const [thread] = await tx
        .insert(c.explorations)
        .values({ ...ctx, experienceId: experience!.id })
        .returning();
      const inputs = [];
      for (const eligibility of ["eligible", "eligible", "context_only", "eligible"]) {
        const [source] = await tx
          .insert(c.sourceItems)
          .values({
            ...ctx,
            sourceKind: "native_event",
            authorKind: "subject",
            content: `synthetic ${eligibility}`,
          })
          .returning();
        await tx.insert(c.sourceAssessments).values({
          sourceItemId: source!.id,
          version: 1,
          attributionStatus: "confirmed_subject",
          contextCompleteness: "partial",
          temporalPrecision: "unknown",
          eligibility,
          rationale: "synthetic",
        });
        await tx.insert(c.explorationTurns).values({
          explorationId: thread!.id,
          sourceItemId: source!.id,
          role: "user",
          turnKind: "message",
          content: source!.content,
        });
        inputs.push(source!);
      }
      const replies = [];
      const operations = [];
      for (let i = 0; i < inputs.length; i++) {
        const source = inputs[i]!;
        const [turn] = await tx
          .insert(c.explorationTurns)
          .values({
            explorationId: thread!.id,
            role: "assistant",
            turnKind: "pi_reply",
            content: `reply-${i}`,
          })
          .returning();
        const deps = i === 3 ? [source.id] : [inputs[0]!.id, source.id];
        await tx
          .update(c.sourceItems)
          .set({
            sourceMeta: {
              exploration_id: thread!.id,
              reply_status: "replied",
              reply: { engine: "pi", turn_id: turn!.id, source_ids: deps },
            },
          })
          .where(eq(c.sourceItems.id, source.id));
        const [operation] = await tx
          .insert(c.coreOperations)
          .values({
            ...ctx,
            explorationId: thread!.id,
            idempotencyKey: randomUUID(),
            operationType: "exploration_reply",
            requestHash: "synthetic",
            status: "completed",
            responseStatus: 201,
            responseBody: { engine: "pi", message_source_id: source.id, reply: `reply-${i}` },
          })
          .returning();
        replies.push(turn!.id);
        operations.push(operation!.id);
      }
      return { id: thread!.id, inputs: inputs.map((s) => s.id), replies, operations };
    });
    await withProfileTransaction(runtime.db, ctx, async (tx) => {
      await tx
        .update(c.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(c.sourceItems.id, fixture.inputs[0]!));
      await invalidateCloudSources(tx, ctx, [fixture.inputs[0]!]);
    });
    const after = await withProfileTransaction(runtime.db, ctx, async (tx) => ({
      sources: await tx.select().from(c.sourceItems),
      turns: await tx.select().from(c.explorationTurns),
      operations: await tx.select().from(c.coreOperations),
      pending: await loadPendingInputs(tx as never, ctx, fixture.id),
    }));
    expect(
      fixture.inputs.map((id) => after.sources.find((s) => s.id === id)?.sourceMeta?.reply_status),
    ).toEqual(["unavailable", "pending", "pending", "replied"]);
    expect(fixture.replies.map((id) => after.turns.find((t) => t.id === id)?.content)).toEqual([
      "",
      "",
      "",
      "reply-3",
    ]);
    expect(
      fixture.operations.map((id) => after.operations.find((op) => op.id === id)?.status),
    ).toEqual(["stale", "stale", "stale", "completed"]);
    expect(
      after.operations.find((op) => op.id === fixture.operations[3])?.responseBody,
    ).toMatchObject({ reply: "reply-3" });
    expect(after.pending.messages.map((m) => m.source_id).sort()).toEqual(
      fixture.inputs.slice(1, 3).sort(),
    );
  } finally {
    await Promise.all([runtime.sql.end(), identity.sql.end()]);
  }
});
