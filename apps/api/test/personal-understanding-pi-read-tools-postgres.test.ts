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
      const declaredArgs =
        name === "read_source" || name === "read_conversation"
          ? { intended_use: "fact_context", relation: "核对原问题的表达归属", ...(args as object) }
          : args;
      const result = await execute("synthetic-call", declaredArgs);
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
    const inspection = await call("read_source", {
      id: source.id,
      intended_use: "inspection",
      relation: "尚不确定是否相关，先核对这段记录谈的是什么",
      include_analysis: true,
    });
    expect(inspection.content).toContain("合成关键词");
    expect(inspection.use_declaration).toEqual({
      intended_use: "inspection",
      relation: "尚不确定是否相关，先核对这段记录谈的是什么",
      status: "candidate_not_adopted",
    });
    expect(inspection.relevance_status).toBe("undetermined");
    expect(inspection.adoption_instruction).toContain("尚未采用的候选");
    for (const name of ["read_source", "read_conversation"]) {
      const tool = toolset.tools.find((item) => item.name === name)!;
      const schema = tool.parameters as unknown as {
        properties: { intended_use: { enum: string[] } };
      };
      expect(schema.properties.intended_use.enum).toEqual([
        "inspection",
        "fact_context",
        "analogy",
        "counterexample",
      ]);
    }
    expect(toolset.dependencies()).toHaveLength(1);
    expect(toolset.dependencies()[0]!.sourceId).toBe(source.id);
    const foreign = createPiReadTools(db.db, other).tools.find((t) => t.name === "read_source")!;
    await expect(
      (foreign.execute as unknown as (id: string, input: unknown) => Promise<unknown>)("call", {
        id: source.id,
        intended_use: "fact_context",
        relation: "核对原问题表达",
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

it("keeps search misses empty, discovers bounded clues separately, and enforces time and current qualification", async () => {
  const cfg = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const db = createDb(cfg.runtime_url);
  const identity = createDb(cfg.identity_url);
  try {
    const profiles = new ProfileService(identity.db);
    const ctx = await profiles.resolve({
      provider: "pi-discovery-test",
      principalId: randomUUID(),
    });
    const other = await profiles.resolve({
      provider: "pi-discovery-test",
      principalId: randomUUID(),
    });
    const insert = async (
      scope: typeof ctx,
      name: string,
      n: number,
      author = "subject",
      status = "active",
      eligibility = "eligible",
      meta: Record<string, unknown> = {},
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
            sourceMeta: meta,
          })
          .returning();
        if (!source) throw Error("fixture");
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
          `RECENT_ORIGINAL_${i}：${"仅展开后可见的长原文".repeat(30)}`,
          i,
          "subject",
          "active",
          i === 11 ? "context_only" : "eligible",
        ),
      );
    const conversationId = randomUUID();
    const current = await insert(ctx, "CURRENT_MESSAGE", 20, "subject", "active", "eligible", {
      exploration_id: conversationId,
    });
    const selfMatch = await insert(
      ctx,
      "ONLY_CURRENT_KEYWORD",
      19,
      "subject",
      "active",
      "eligible",
      { exploration_id: conversationId },
    );
    const future = await insert(ctx, "FUTURE_MESSAGE", 21, "subject", "active", "eligible", {
      exploration_id: conversationId,
    });
    const lateCross = await insert(ctx, "LATE_CROSS_CONVERSATION", 30);
    const excluded = await insert(ctx, "EXCLUDED_ORIGINAL", 8, "subject", "excluded");
    const assistant = await insert(ctx, "ASSISTANT_INTERPRETATION", 9, "assistant");
    const ineligible = await insert(
      ctx,
      "INELIGIBLE_ORIGINAL",
      10,
      "subject",
      "active",
      "needs_review",
    );
    const foreign = await insert(other, "FOREIGN_ORIGINAL", 11);
    const namespace = "synthetic-import-time";
    const earlyNeighbor = await insert(ctx, "IMPORT_EARLY", 1, "subject", "active", "eligible", {
      namespace,
      sequence: 1,
    });
    const lateNeighbor = await insert(ctx, "IMPORT_FUTURE", 31, "subject", "active", "eligible", {
      namespace,
      sequence: 2,
    });
    const toolset = createPiReadTools(db.db, ctx, [], {
      currentConversationId: conversationId,
      currentMessageId: current,
      withheldSourceIds: [future],
      asOf: new Date(1700000020000).toISOString(),
    });
    const call = async (name: string, input: unknown) => {
      const tool = toolset.tools.find((t) => t.name === name);
      if (!tool) throw Error("missing tool");
      const result = await (
        tool.execute as unknown as (
          id: string,
          input: unknown,
        ) => Promise<{ content: Array<{ text: string }> }>
      )("discovery", input);
      return JSON.parse(result.content[0]?.text || "{}");
    };
    const miss = await call("search_history", { query: "UNSEEN_QUERY_NO_HIT" });
    expect(miss.items).toEqual([]);
    expect(toolset.dependencies()).toHaveLength(0);
    const selfOnly = await call("search_history", { query: "ONLY_CURRENT_KEYWORD" });
    expect(selfOnly.items.map((item: { id: string }) => item.id)).toEqual([selfMatch]);
    expect(selfOnly.items[0].stage).toBe("discovery_only");
    const clues = await call("discover_conversations", {});
    expect(clues.items).toHaveLength(10);
    expect(
      clues.items.every(
        (item: { stage: string; title: string; content?: string; excerpt?: string }) =>
          item.stage === "discovery_only" &&
          item.title.length <= 80 &&
          item.content === undefined &&
          item.excerpt === undefined,
      ),
    ).toBe(true);
    const ids = clues.items.map((item: { id: string }) => item.id);
    expect(ids.every((id: string) => allowed.includes(id) || id === earlyNeighbor)).toBe(true);
    for (const id of [
      current,
      selfMatch,
      future,
      lateCross,
      excluded,
      assistant,
      ineligible,
      foreign,
      lateNeighbor,
    ])
      expect(ids).not.toContain(id);
    expect((await call("search_history", { query: "LATE_CROSS_CONVERSATION" })).items).toEqual([]);
    const use = { intended_use: "analogy", relation: "比较表达结构，不推定共同机制" };
    const original = await call("read_source", { id: earlyNeighbor, ...use });
    expect(original.content).toBe("IMPORT_EARLY");
    expect(original.use_declaration).toEqual({ ...use, status: "proposed_not_verified" });
    expect(JSON.stringify(original)).not.toContain("IMPORT_FUTURE");
    await expect(call("read_source", { id: lateCross, ...use })).rejects.toThrow(
      "SOURCE_NOT_AVAILABLE",
    );
    await expect(call("read_source", { id: earlyNeighbor })).rejects.toThrow();
    // Current qualification wins even though the old source predates the cutoff.
    await withProfileTransaction(db.db, ctx, (tx) =>
      tx
        .update(c.sourceItems)
        .set({ usageStatus: "superseded" })
        .where(eq(c.sourceItems.id, earlyNeighbor)),
    );
    await expect(call("read_source", { id: earlyNeighbor, ...use })).rejects.toThrow(
      "STALE_DEPENDENCY",
    );
  } finally {
    await Promise.all([db.sql.end(), identity.sql.end()]);
  }
});

it("registers source and revision dependencies for knowledge tools and initial context", async () => {
  const cfg = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const db = createDb(cfg.runtime_url);
  const identity = createDb(cfg.identity_url);
  try {
    const profiles = new ProfileService(identity.db);
    const ctx = await profiles.resolve({ provider: "pi-domain-test", principalId: randomUUID() });
    const other = await profiles.resolve({ provider: "pi-domain-test", principalId: randomUUID() });
    const data = await withProfileTransaction(db.db, ctx, async (tx) => {
      const [source] = await tx
        .insert(c.sourceItems)
        .values({
          ...ctx,
          sourceKind: "event",
          authorKind: "subject",
          content: "图书馆值班时我核对归还清单。",
        })
        .returning();
      await tx.insert(c.sourceAssessments).values({
        sourceItemId: source!.id,
        version: 1,
        attributionStatus: "confirmed_subject",
        contextCompleteness: "complete",
        temporalPrecision: "unknown",
        eligibility: "eligible",
        rationale: "synthetic",
      });
      const [span] = await tx
        .insert(c.evidenceSpans)
        .values({
          sourceItemId: source!.id,
          quote: source!.content,
          locator: { start: 0, end: source!.content.length },
          authorKind: "subject",
          aboutSubject: true,
        })
        .returning();
      const [claim] = await tx
        .insert(c.claims)
        .values({ ...ctx, claimKey: `knowledge:${randomUUID()}`, claimKind: "behavior" })
        .returning();
      const [revision] = await tx
        .insert(c.claimRevisions)
        .values({
          claimId: claim!.id,
          version: 1,
          mode: "observation",
          text: "图书馆值班会核对归还清单",
          scope: "该次图书馆值班",
          status: "current",
          evidenceStatus: "valid",
          confidenceLevel: "low",
          confidenceBasis: "synthetic",
        })
        .returning();
      await tx.insert(c.claimEvidence).values({
        claimRevisionId: revision!.id,
        evidenceSpanId: span!.id,
        relation: "supports",
        directness: "direct",
        contribution: "medium",
        independenceGroup: source!.id,
        scopeMatch: "exact",
        rationale: "synthetic",
      });
      return { source: source!, revision: revision! };
    });
    const collector = createPiReadTools(db.db, ctx);
    const call = async (
      set: ReturnType<typeof createPiReadTools>,
      name: string,
      input: unknown,
    ) => {
      const tool = set.tools.find((t) => t.name === name);
      if (!tool) throw Error("tool missing");
      const out = await (
        tool.execute as unknown as (
          id: string,
          input: unknown,
        ) => Promise<{ content: Array<{ text: string }> }>
      )("domain", input);
      return JSON.parse(out.content[0]!.text);
    };
    const declaration = { intended_use: "inspection", relation: "先核对这条认识的来源和适用范围" };
    const viewed = await call(collector, "read_revision", { id: data.revision.id, ...declaration });
    expect(viewed.qualified).toBe(true);
    expect(viewed.text).toContain("归还清单");
    expect(viewed.use_declaration.status).toBe("candidate_not_adopted");
    expect(collector.dependencies().map((d) => d.sourceId)).toContain(data.source.id);
    expect(collector.revisionDependencies().map((d) => d.revisionId)).toEqual([data.revision.id]);
    const context = await collector.initialContext({
      id: randomUUID(),
      conversationId: randomUUID(),
      taskType: "conversation",
      intent: "conversation",
      input: "图书馆清单",
      writesUnderstanding: false,
    });
    expect(context.understandingIndex.map((i) => i.id)).toContain(data.revision.id);
    await expect(
      call(createPiReadTools(db.db, other), "read_revision", {
        id: data.revision.id,
        ...declaration,
      }),
    ).rejects.toThrow("REVISION_NOT_AVAILABLE");
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx
        .update(c.claimRevisions)
        .set({ status: "withdrawn" })
        .where(eq(c.claimRevisions.id, data.revision.id));
    });
    const { assertPiRevisionsCurrent } = await import(
      "../src/personal-understanding/revision-dependencies.js"
    );
    await expect(
      withProfileTransaction(db.db, ctx, (tx) =>
        assertPiRevisionsCurrent(tx, ctx, collector.revisionDependencies()),
      ),
    ).rejects.toThrow("PI_REVISION_STALE_DEPENDENCY");
    const history = await call(createPiReadTools(db.db, ctx), "read_revision", {
      id: data.revision.id,
      include_history: true,
      ...declaration,
    });
    expect(history.qualified).toBe(false);
    expect(history.qualification).toBe("historical_not_current_premise");
  } finally {
    await Promise.all([db.sql.end(), identity.sql.end()]);
  }
});
