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
