import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { coreSchema as c, createDb } from "@findme/db";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { ProfileService } from "../src/auth/profiles.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import { createPiReadTools } from "../src/personal-understanding/pi-read-tools.js";

it("collects exact source dependencies and rejects excluded or cross-profile reads", async () => {
  const cfg = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const db = createDb(cfg.runtime_url);
  const identity = createDb(cfg.identity_url);
  try {
    const profiles = new ProfileService(identity.db);
    const ctx = await profiles.resolve({ provider: "pi-tools-test", principalId: randomUUID() });
    const other = await profiles.resolve({ provider: "pi-tools-test", principalId: randomUUID() });
    const source = await withProfileTransaction(db.db, ctx, async (tx) => {
      const [s] = await tx
        .insert(c.sourceItems)
        .values({
          ...ctx,
          sourceKind: "conversation_import",
          authorKind: "assistant",
          content: "合成关键词：A参加，B休息",
          sourceMeta: { namespace: "synthetic-thread", sequence: 1 },
        })
        .returning();
      await tx.insert(c.sourceAssessments).values({
        sourceItemId: s!.id,
        version: 1,
        attributionStatus: "not_subject",
        contextCompleteness: "partial",
        temporalPrecision: "unknown",
        eligibility: "context_only",
        rationale: "synthetic",
      });
      return s!;
    });
    const toolset = createPiReadTools(db.db, ctx);
    const call = async (name: string, args: unknown) => {
      const tool = toolset.tools.find((t) => t.name === name)!;
      const execute = tool.execute as unknown as (
        id: string,
        input: unknown,
      ) => Promise<{ content: Array<{ text: string }> }>;
      const result = await execute("synthetic-call", args);
      return JSON.parse(result.content[0].text);
    };
    expect((await call("search_history", { query: "合成关键词" })).items[0].id).toBe(source.id);
    expect((await call("search_history", { query: "合成 关键词" })).items[0].id).toBe(source.id);
    const excluding = createPiReadTools(db.db, ctx, [], { currentMessageId: source.id }).tools.find(
      (t) => t.name === "search_history",
    );
    if (!excluding) throw new Error("missing search");
    const excludedResult = await (
      excluding.execute as unknown as (
        id: string,
        input: unknown,
      ) => Promise<{ content: Array<{ text: string }> }>
    )("exclude-current", { query: "合成 关键词" });
    expect(JSON.parse((excludedResult.content[0] as { text: string }).text).items).toEqual([]);
    expect((await call("read_source", { id: source.id })).content).toBeNull();
    expect(
      (await call("read_source", { id: source.id, include_analysis: true })).content,
    ).toContain("合成关键词");
    expect((await call("read_source", { id: source.id })).author).toBe("assistant");
    expect(toolset.dependencies()).toHaveLength(1);
    expect(toolset.dependencies()[0]!.sourceId).toBe(source.id);
    const foreign = createPiReadTools(db.db, other).tools.find((t) => t.name === "read_source")!;
    await expect(
      (foreign.execute as unknown as (id: string, input: unknown) => Promise<unknown>)("call", {
        id: source.id,
      }),
    ).rejects.toThrow("STALE_DEPENDENCY");
    await withProfileTransaction(db.db, ctx, (tx) =>
      tx
        .update(c.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(c.sourceItems.id, source.id)),
    );
    await expect(call("read_source", { id: source.id })).rejects.toThrow("STALE_DEPENDENCY");
    expect((await call("search_history", { query: "合成关键词" })).items).toEqual([]);
  } finally {
    await Promise.all([db.sql.end(), identity.sql.end()]);
  }
});

it("offers bounded recent subject originals only on zero keyword hits and keeps scope and exclusions", async () => {
  const cfg = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const db = createDb(cfg.runtime_url);
  const identity = createDb(cfg.identity_url);
  try {
    const profiles = new ProfileService(identity.db);
    const ctx = await profiles.resolve({ provider: "pi-fallback-test", principalId: randomUUID() });
    const other = await profiles.resolve({
      provider: "pi-fallback-test",
      principalId: randomUUID(),
    });
    const insert = async (
      scope: typeof ctx,
      name: string,
      n: number,
      author = "subject",
      status = "active",
      eligibility = "eligible",
    ) =>
      withProfileTransaction(db.db, scope, async (tx) => {
        const [source] = await tx
          .insert(c.sourceItems)
          .values({
            ...scope,
            sourceKind: "native_event",
            authorKind: author,
            content: name,
            usageStatus: status,
            capturedAt: new Date(1700000000000 + n * 1000),
          })
          .returning();
        if (!source) throw Error("missing source");
        await tx.insert(c.sourceAssessments).values({
          sourceItemId: source.id,
          version: 1,
          attributionStatus: author === "subject" ? "confirmed_subject" : "not_subject",
          contextCompleteness: "partial",
          temporalPrecision: "unknown",
          eligibility,
          rationale: "synthetic",
        });
        return source.id;
      });
    const allowed: string[] = [];
    for (let i = 0; i < 12; i++)
      allowed.push(
        await insert(
          ctx,
          `RECENT_ORIGINAL_${i}`,
          i,
          "subject",
          "active",
          i === 11 ? "context_only" : "eligible",
        ),
      );
    const current = await insert(ctx, "CURRENT_MESSAGE", 20);
    const future = await insert(ctx, "FUTURE_MESSAGE", 21);
    const excluded = await insert(ctx, "EXCLUDED_ORIGINAL", 22, "subject", "excluded");
    const assistant = await insert(ctx, "ASSISTANT_INTERPRETATION", 23, "assistant");
    const ineligible = await insert(
      ctx,
      "INELIGIBLE_ORIGINAL",
      24,
      "subject",
      "active",
      "needs_review",
    );
    const foreign = await insert(other, "FOREIGN_ORIGINAL", 25);
    const conversationId = randomUUID();
    const selfMatch = await insert(ctx, "ONLY_CURRENT_KEYWORD", 26);
    await withProfileTransaction(db.db, ctx, async (tx) => {
      for (const id of [current, future, selfMatch])
        await tx
          .update(c.sourceItems)
          .set({ sourceMeta: { exploration_id: conversationId } })
          .where(eq(c.sourceItems.id, id));
    });
    const toolset = createPiReadTools(db.db, ctx, [], {
      currentConversationId: conversationId,
      currentMessageId: current,
      withheldSourceIds: [future],
    });
    const search = toolset.tools.find((tool) => tool.name === "search_history");
    if (!search) throw Error("missing search");
    const call = async (query: string) => {
      const result = await (
        search.execute as unknown as (
          id: string,
          input: unknown,
        ) => Promise<{ content: Array<{ text: string }> }>
      )("fallback", { query });
      return JSON.parse(result.content[0]?.text || "{}");
    };
    const result = await call("UNSEEN_QUERY_NO_KEYWORD_HIT");
    expect(result.retrieval_kind).toBe("recent_fallback");
    expect(result.relevance_instruction).toContain("不是匹配结果");
    expect(result.items).toHaveLength(10);
    const ids = result.items.map((item: { id: string }) => item.id);
    expect(ids.every((id: string) => allowed.includes(id))).toBe(true);
    expect(ids).toContain(allowed[11]);
    for (const id of [current, future, excluded, assistant, ineligible, foreign])
      expect(ids).not.toContain(id);
    expect(
      toolset
        .dependencies()
        .map((dep) => dep.sourceId)
        .sort(),
    ).toEqual([...ids].sort());
    const selfOnly = await call("ONLY_CURRENT_KEYWORD");
    expect(selfOnly.retrieval_kind).toBe("keyword_with_recent_fallback");
    expect(selfOnly.keyword_match_count).toBe(1);
    expect(selfOnly.recent_fallback_count).toBe(10);
    const keywordItem = selfOnly.items.find((item: { id: string }) => item.id === selfMatch);
    expect(keywordItem.retrieval_kind).toBe("keyword_match");
    expect(keywordItem.current_conversation).toBe(true);
    const fallbackItems = selfOnly.items.filter(
      (item: { retrieval_kind: string }) => item.retrieval_kind === "recent_fallback",
    );
    expect(
      fallbackItems.every(
        (item: { id: string; author: string }) =>
          allowed.includes(item.id) && item.author === "subject",
      ),
    ).toBe(true);
    expect(selfOnly.relevance_instruction).toContain("重复问题不能算独立历史证据");
    const match = await call("RECENT_ORIGINAL_0");
    expect(match.retrieval_kind).toBe("keyword_match");
    expect(match.items.map((item: { id: string }) => item.id)).toEqual([allowed[0]]);
  } finally {
    await Promise.all([db.sql.end(), identity.sql.end()]);
  }
});
