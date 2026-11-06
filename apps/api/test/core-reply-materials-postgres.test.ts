import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { coreSchema as c, createDb } from "@findme/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { ProfileService } from "../src/auth/profiles.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import type { PersonalContext } from "../src/core/exploration-types.js";
import { createCoreReportBackend } from "../src/core/report-source-service.js";
import { onError } from "../src/middleware/error.js";
import { coreRoutes } from "../src/routes/core.js";

it("reads only scoped, qualified reply dependencies with bounded source and text pagination", async () => {
  const config = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const runtime = createDb(config.runtime_url);
  const identity = createDb(config.identity_url);
  try {
    const profiles = new ProfileService(identity.db);
    const principal = { provider: "reply-materials", principalId: randomUUID() };
    const ctx = await profiles.resolve(principal);
    const other = await profiles.resolve({ ...principal, principalId: randomUUID() });
    let requestCtx = ctx;
    const source = async (owner: PersonalContext, text: string, authorKind = "subject") =>
      withProfileTransaction(runtime.db, owner, async (tx) => {
        const [row] = await tx
          .insert(c.sourceItems)
          .values({ ...owner, sourceKind: "native_event", authorKind, content: text })
          .returning();
        if (!row) throw new Error("fixture source missing");
        await tx.insert(c.sourceAssessments).values({
          sourceItemId: row.id,
          version: 1,
          attributionStatus: "confirmed_subject",
          contextCompleteness: "sufficient",
          temporalPrecision: "unknown",
          eligibility: authorKind === "assistant" ? "context_only" : "eligible",
          rationale: "synthetic",
        });
        return row;
      });
    const first = await source(ctx, `${"甲".repeat(1999)}😀后续原话`);
    const second = await source(ctx, "助手的旧解释，不是本人自述", "assistant");
    const unrelated = await source(ctx, "NOT_USED_BY_THIS_REPLY");
    const foreign = await source(other, "OTHER_PROFILE_PRIVATE");
    const fixture = await withProfileTransaction(runtime.db, ctx, async (tx) => {
      const [experience] = await tx
        .insert(c.experiences)
        .values({ ...ctx, summary: "查看参考范围" })
        .returning();
      if (!experience) throw new Error("fixture experience missing");
      const [thread] = await tx
        .insert(c.explorations)
        .values({ ...ctx, experienceId: experience.id })
        .returning();
      if (!thread) throw new Error("fixture thread missing");
      const [turn] = await tx
        .insert(c.explorationTurns)
        .values({
          explorationId: thread.id,
          role: "assistant",
          turnKind: "pi_reply",
          content: "已交付的回应",
        })
        .returning();
      if (!turn) throw new Error("fixture turn missing");
      const [owner] = await tx
        .insert(c.sourceItems)
        .values({
          ...ctx,
          sourceKind: "native_event",
          authorKind: "subject",
          content: "原始问题",
          sourceMeta: {
            exploration_id: thread.id,
            reply: {
              engine: "pi",
              turn_id: turn.id,
              source_ids: [first.id, second.id, foreign.id],
              raw_prompt: "PRIVATE_PROMPT",
              review: "INTERNAL_REVIEW_REASON",
            },
          },
        })
        .returning();
      if (!owner) throw new Error("fixture owner missing");
      return { thread, turn, owner };
    });
    const app = new Hono();
    app.onError(onError);
    app.route(
      "/api/core",
      coreRoutes(runtime.db, undefined, async () => principal, undefined, {
        contextFor: async () => requestCtx,
        backend: createCoreReportBackend(runtime.db),
      }),
    );
    const endpoint = `/api/core/explorations/${fixture.thread.id}/replies/${fixture.turn.id}/materials`;
    const firstPage = await app.request(`${endpoint}?limit=1`);
    expect(firstPage.status).toBe(200);
    const page = await firstPage.json();
    expect(page.qualification).toBe("reference_range_not_statement_support");
    expect(page.next_cursor).toBe(1);
    expect(page.items[0].author_kind).toBe("subject");
    expect(page.items[0].text).toBe("甲".repeat(1999));
    expect(page.items[0].next_text_offset).toBe(1999);
    expect(JSON.stringify(page)).not.toContain("PRIVATE_PROMPT");
    expect(JSON.stringify(page)).not.toContain("INTERNAL_REVIEW_REASON");
    const tail = await (await app.request(`${endpoint}?source_id=${first.id}&start=1999`)).json();
    expect(page.items[0].text + tail.items[0].text).toBe(first.content);
    expect(tail.items[0].next_text_offset).toBeNull();
    const next = await (await app.request(`${endpoint}?cursor=1&limit=2`)).json();
    expect(next.items).toHaveLength(1);
    expect(next.items[0].source_id).toBe(second.id);
    expect(next.items[0].author_kind).toBe("assistant");
    expect(next.unavailable_in_page).toBe(1);
    expect(JSON.stringify(next)).not.toContain("OTHER_PROFILE_PRIVATE");
    expect((await app.request(`${endpoint}?source_id=${unrelated.id}`)).status).toBe(404);
    requestCtx = other;
    expect((await app.request(endpoint)).status).toBe(404);
    requestCtx = ctx;
    expect(
      (
        await app.request(
          `/api/core/explorations/${randomUUID()}/replies/${fixture.turn.id}/materials`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/api/core/explorations/${fixture.thread.id}/replies/${randomUUID()}/materials`,
        )
      ).status,
    ).toBe(404);
    await withProfileTransaction(runtime.db, ctx, async (tx) => {
      await tx
        .update(c.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(c.sourceItems.id, first.id));
      await tx
        .update(c.sourceItems)
        .set({ usageStatus: "deleted", content: "" })
        .where(eq(c.sourceItems.id, second.id));
    });
    const excluded = await (await app.request(endpoint)).json();
    expect(excluded.items).toEqual([]);
    expect(excluded.unavailable_in_page).toBe(3);
    expect(JSON.stringify(excluded)).not.toContain("助手的旧解释");
    await withProfileTransaction(runtime.db, ctx, (tx) =>
      tx
        .update(c.explorationTurns)
        .set({ content: "" })
        .where(eq(c.explorationTurns.id, fixture.turn.id)),
    );
    expect((await app.request(endpoint)).status).toBe(404);
  } finally {
    await Promise.all([runtime.sql.end(), identity.sql.end()]);
  }
});
