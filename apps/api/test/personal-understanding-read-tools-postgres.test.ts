import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { coreSchema, createDb } from "@findme/db";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { ProfileService } from "../src/auth/profiles.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import type { PersonalContext } from "../src/core/exploration-types.js";
import { UnderstandingReadTools } from "../src/personal-understanding/read-tools.js";

async function source(
  db: any,
  ctx: PersonalContext,
  input: { content: string; eligibility: string; attribution: string; author?: string },
) {
  return withProfileTransaction(db, ctx, async (tx) => {
    const [s] = await tx
      .insert(coreSchema.sourceItems)
      .values({
        ...ctx,
        sourceKind: "test",
        authorKind: input.author ?? "subject",
        content: input.content,
      })
      .returning();
    const [a] = await tx
      .insert(coreSchema.sourceAssessments)
      .values({
        sourceItemId: s!.id,
        version: 1,
        attributionStatus: input.attribution,
        contextCompleteness: "complete",
        temporalPrecision: "unknown",
        eligibility: input.eligibility,
        rationale: "synthetic DB fixture",
      })
      .returning();
    const [span] = await tx
      .insert(coreSchema.evidenceSpans)
      .values({
        sourceItemId: s!.id,
        quote: input.content,
        locator: { start: 0, end: input.content.length },
        authorKind: input.author ?? "subject",
        aboutSubject: true,
      })
      .returning();
    const [claim] = await tx
      .insert(coreSchema.claims)
      .values({ ...ctx, claimKey: `test:${randomUUID()}`, claimKind: "pattern" })
      .returning();
    const [revision] = await tx
      .insert(coreSchema.claimRevisions)
      .values({
        claimId: claim!.id,
        version: 1,
        mode: "observation",
        text: "候选认识正文",
        scope: "测试范围",
        status: "current",
        evidenceStatus: "valid",
        confidenceLevel: "low",
        confidenceBasis: "test",
        details: { should_not_leak: true },
      })
      .returning();
    await tx.insert(coreSchema.claimEvidence).values({
      claimRevisionId: revision!.id,
      evidenceSpanId: span!.id,
      relation: "supports",
      directness: "direct",
      contribution: "medium",
      independenceGroup: `test:${s!.id}`,
      scopeMatch: "exact",
      rationale: "synthetic",
    });
    return {
      sourceId: s!.id,
      assessmentId: a!.id,
      revisionId: revision!.id,
      spanId: span!.id,
      claimId: claim!.id,
    };
  });
}

it("scopes reads, hides excluded source, retains a safe candidate, and suppresses unqualified current text", async () => {
  const cfg = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const db = createDb(cfg.runtime_url);
  const identity = createDb(cfg.identity_url);
  try {
    const profiles = new ProfileService(identity.db);
    const ctx = await profiles.resolve({ provider: "read-tools-test", principalId: randomUUID() });
    const other = await profiles.resolve({
      provider: "read-tools-test",
      principalId: randomUUID(),
    });
    const tool = new UnderstandingReadTools(db.db);
    const good = await source(db.db, ctx, {
      content: "自述来源",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const weak = await source(db.db, ctx, {
      content: "导入候选来源",
      eligibility: "needs_review",
      attribution: "ambiguous",
      author: "assistant",
    });
    const outside = await source(db.db, other, {
      content: "另一资料",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const goodRevision = await tool.readRevision(ctx, { id: good.revisionId });
    expect(goodRevision.qualified).toBe(true);
    expect(goodRevision.text).toBe("候选认识正文");
    const weakRevision = await tool.readRevision(ctx, { id: weak.revisionId });
    expect(weakRevision.qualified).toBe(false);
    expect(weakRevision.text).toBeNull();
    expect(weakRevision.details).toBeNull();
    await expect(tool.readSource(ctx, { id: outside.sourceId })).rejects.toThrow(
      "SOURCE_NOT_AVAILABLE",
    );
    const before = await tool.readSource(ctx, { id: good.sourceId });
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx
        .update(coreSchema.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(coreSchema.sourceItems.id, good.sourceId));
    });
    await expect(tool.readSource(ctx, { id: good.sourceId })).rejects.toThrow(
      "SOURCE_NOT_AVAILABLE",
    );
    const hidden = await tool.readRevision(ctx, { id: good.revisionId });
    expect(hidden.text).toBeNull();
    expect(hidden.scope).toBeNull();
    expect(hidden.details).toBeNull();
    expect(hidden.evidence).toEqual([]);
    expect(hidden.omitted_evidence).toBe(1);
    const after = await tool.listUnderstandings(ctx, { limit: 20 });
    expect(after.items.find((x: any) => x.revision_id === good.revisionId)?.text).toBeNull();
    expect(before.source.fingerprint).not.toBe(await sourceFingerprint(tool, ctx, good.sourceId));
    expect((await tool.searchSources(ctx, { query: "自述" })).items).toEqual([]);
  } finally {
    await Promise.all([db.sql.end(), identity.sql.end()]);
  }
});

async function sourceFingerprint(tool: UnderstandingReadTools, ctx: PersonalContext, id: string) {
  try {
    return (await tool.readSource(ctx, { id })).source.fingerprint;
  } catch {
    return "unavailable";
  }
}

it("reads a conversation import with pagination and never leaks excluded turns", async () => {
  const cfg = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const db = createDb(cfg.runtime_url);
  const identity = createDb(cfg.identity_url);
  try {
    const ctx = await new ProfileService(identity.db).resolve({
      provider: "read-tools-test",
      principalId: randomUUID(),
    });
    const [batch] = await withProfileTransaction(db.db, ctx, async (tx) => {
      const [b] = await tx
        .insert((await import("@findme/db")).platformSchema.importBatches)
        .values({
          ...ctx,
          inputHash: "0".repeat(64),
          status: "committed",
          payload: {},
          committedAt: new Date(),
        })
        .returning();
      const saved = [];
      for (let i = 0; i < 3; i++) {
        const [s] = await tx
          .insert(coreSchema.sourceItems)
          .values({
            ...ctx,
            sourceKind: "conversation_import",
            authorKind: i === 1 ? "assistant" : "subject",
            content: `turn ${i}`,
            externalRef: `test-read:${b!.id}:${i}`,
            sourceMeta: {
              import_batch: b!.id,
              namespace: `test-${b!.id}`,
              external_id: `m${i}`,
              sequence: i,
              role: i === 1 ? "assistant" : "user",
              message_kind: i === 1 ? "final_answer" : "user",
              original_recorded_at: null,
              original_time_basis: "unknown",
            },
          })
          .returning();
        saved.push(s!);
        await tx.insert(coreSchema.sourceAssessments).values({
          sourceItemId: s!.id,
          version: 1,
          attributionStatus: i === 1 ? "not_subject" : "confirmed_subject",
          contextCompleteness: "complete",
          temporalPrecision: "unknown",
          eligibility: i === 1 ? "context_only" : "eligible",
          rationale: "synthetic",
        });
      }
      await tx
        .update((await import("@findme/db")).platformSchema.importBatches)
        .set({
          result: { understanding_namespace: `test-${b!.id}`, source_ids: saved.map((x) => x.id) },
        })
        .where(eq((await import("@findme/db")).platformSchema.importBatches.id, b!.id));
      await tx
        .update(coreSchema.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(coreSchema.sourceItems.id, saved[1]!.id));
      return [b, saved] as const;
    });
    const tool = new UnderstandingReadTools(db.db);
    const first = await tool.readConversation(ctx, { namespace: `test-${batch!.id}`, limit: 1 });
    expect(first.sources).toHaveLength(1);
    expect(first.sources[0]!.external_id).toBe("m0");
    expect(first.next_cursor).toBe(1);
    const second = await tool.readConversation(ctx, {
      namespace: `test-${batch!.id}`,
      cursor: first.next_cursor!,
      limit: 2,
    });
    expect(second.sources.map((x: any) => x.external_id)).toEqual(["m2"]);
    expect(second.sources.some((x: any) => x.external_id === "m1")).toBe(false);
    await expect(tool.readConversation(ctx, { namespace: `other-${batch!.id}` })).rejects.toThrow(
      "IMPORT_NOT_AVAILABLE",
    );
    const counts = await tool.coverage(ctx);
    expect(counts.coverage.active).toBe(2);
    expect(counts.coverage.excluded).toBe(1);
    expect(counts.exhaustive).toBe(true);
  } finally {
    await Promise.all([db.sql.end(), identity.sql.end()]);
  }
});

it("filters every evidence edge and exposes partial material without resurrecting its claim", async () => {
  const cfg = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const db = createDb(cfg.runtime_url);
  const identity = createDb(cfg.identity_url);
  try {
    const ctx = await new ProfileService(identity.db).resolve({
      provider: "domain-partial",
      principalId: randomUUID(),
    });
    const a = await source(db.db, ctx, {
      content: "第一段可核对材料",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const b = await source(db.db, ctx, {
      content: "第二段可核对材料",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx.insert(coreSchema.claimEvidence).values({
        claimRevisionId: a.revisionId,
        evidenceSpanId: b.spanId,
        relation: "supports",
        directness: "direct",
        contribution: "medium",
        independenceGroup: "second-event",
        scopeMatch: "exact",
        rationale: "synthetic",
      });
      await tx
        .update(coreSchema.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(coreSchema.sourceItems.id, a.sourceId));
    });
    const reader = new UnderstandingReadTools(db.db);
    const partial = await reader.readRevision(ctx, { id: a.revisionId });
    expect(partial.text).toBeNull();
    expect(partial.qualified).toBe(false);
    expect(partial.evidence.map((e) => e.source_id)).toEqual([b.sourceId]);
    expect(partial.omitted_evidence).toBe(1);
    expect(partial.dependencies.map((d) => d.sourceId)).toEqual([b.sourceId]);
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx
        .update(coreSchema.sourceAssessments)
        .set({ eligibility: "excluded" })
        .where(eq(coreSchema.sourceAssessments.id, b.assessmentId));
    });
    const hidden = await reader.readRevision(ctx, { id: a.revisionId });
    expect(hidden.evidence).toEqual([]);
    expect(hidden.omitted_evidence).toBe(2);
    await expect(reader.readSource(ctx, { id: b.sourceId })).rejects.toThrow(
      "SOURCE_NOT_AVAILABLE",
    );
    expect((await reader.searchSources(ctx, { query: "第二段" })).items).toEqual([]);
  } finally {
    await Promise.all([db.sql.end(), identity.sql.end()]);
  }
});

it("uses content cutoffs while preserving current retirement and scoped explicit preferences", async () => {
  const cfg = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const db = createDb(cfg.runtime_url);
  const identity = createDb(cfg.identity_url);
  try {
    const ctx = await new ProfileService(identity.db).resolve({
      provider: "domain-context",
      principalId: randomUUID(),
    });
    const old = await source(db.db, ctx, {
      content: "本次对话请用简短选项交流。",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const future = await source(db.db, ctx, {
      content: "未来记录不可提前使用",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const cutoff = new Date(Date.now() - 30_000);
    const oldAt = new Date(cutoff.getTime() - 30_000);
    const conversationId = randomUUID();
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx
        .update(coreSchema.sourceItems)
        .set({ capturedAt: oldAt })
        .where(eq(coreSchema.sourceItems.id, old.sourceId));
      await tx
        .update(coreSchema.claimRevisions)
        .set({
          createdAt: oldAt,
          text: "本次对话用简短选项",
          details: {
            interaction_preference: {
              explicit: true,
              source_id: old.sourceId,
              source_assessment_version: 1,
              original_text: "本次对话请用简短选项交流。",
              scope: { kind: "conversation", id: conversationId },
            },
          },
        })
        .where(eq(coreSchema.claimRevisions.id, old.revisionId));
    });
    const reader = new UnderstandingReadTools(db.db, { asOf: cutoff.toISOString() });
    await expect(reader.readSource(ctx, { id: future.sourceId })).rejects.toThrow(
      "SOURCE_NOT_AVAILABLE",
    );
    await expect(reader.readRevision(ctx, { id: future.revisionId })).rejects.toThrow(
      "REVISION_NOT_AVAILABLE",
    );
    const task = {
      id: randomUUID(),
      conversationId,
      input: "简短选项",
      taskType: "conversation",
      intent: "conversation" as const,
      writesUnderstanding: false,
    };
    const context = await reader.initialContext(ctx, task);
    expect(context.preferences.map((p) => p.sourceId)).toEqual([old.sourceId]);
    expect(context.understandingIndex.map((i) => i.id)).toContain(old.revisionId);
    expect(context.revision_dependencies.map((d) => d.revisionId)).toContain(old.revisionId);
    expect(
      (await reader.initialContext(ctx, { ...task, conversationId: randomUUID() })).preferences,
    ).toEqual([]);
    const before = await reader.readSource(ctx, { id: old.sourceId });
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx
        .update(coreSchema.sourceItems)
        .set({ sourceMeta: { reply_status: "replied" } })
        .where(eq(coreSchema.sourceItems.id, old.sourceId));
    });
    expect((await reader.readSource(ctx, { id: old.sourceId })).source.fingerprint).toBe(
      before.source.fingerprint,
    );
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx
        .update(coreSchema.claimRevisions)
        .set({ status: "withdrawn" })
        .where(eq(coreSchema.claimRevisions.id, old.revisionId));
    });
    expect((await reader.initialContext(ctx, task)).preferences).toEqual([]);
    await expect(reader.readRevision(ctx, { id: old.revisionId })).rejects.toThrow(
      "REVISION_NOT_AVAILABLE",
    );
    const retired = await reader.readRevision(ctx, { id: old.revisionId, includeHistory: true });
    expect(retired.qualified).toBe(false);
    expect(retired.qualification).toBe("historical_not_current_premise");
  } finally {
    await Promise.all([db.sql.end(), identity.sql.end()]);
  }
});

it("keeps source-valid assistant replies unavailable after their referenced revision is withdrawn", async () => {
  const cfg = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const db = createDb(cfg.runtime_url);
  const identity = createDb(cfg.identity_url);
  try {
    const ctx = await new ProfileService(identity.db).resolve({
      provider: "domain-lineage",
      principalId: randomUUID(),
    });
    const data = await source(db.db, ctx, {
      content: "合成个人原话",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const thread = await withProfileTransaction(db.db, ctx, async (tx) => {
      const [experience] = await tx
        .insert(coreSchema.experiences)
        .values({ ...ctx, summary: "独立讨论" })
        .returning();
      const [exploration] = await tx
        .insert(coreSchema.explorations)
        .values({ ...ctx, experienceId: experience!.id })
        .returning();
      await tx.insert(coreSchema.explorationTurns).values({
        explorationId: exploration!.id,
        sourceItemId: data.sourceId,
        role: "user",
        turnKind: "event",
        content: "合成个人原话",
      });
      const [reply] = await tx
        .insert(coreSchema.explorationTurns)
        .values({
          explorationId: exploration!.id,
          role: "assistant",
          turnKind: "pi_reply",
          content: "依赖某条认识形成的旧回复",
        })
        .returning();
      const { capturePiRevisionDependency } = await import(
        "../src/personal-understanding/revision-dependencies.js"
      );
      const revisionDependency = await capturePiRevisionDependency(tx, ctx, data.revisionId);
      await tx
        .update(coreSchema.sourceItems)
        .set({
          sourceMeta: {
            exploration_id: exploration!.id,
            reply: {
              engine: "pi",
              turn_id: reply!.id,
              source_ids: [data.sourceId],
              revision_dependencies: [revisionDependency],
            },
          },
        })
        .where(eq(coreSchema.sourceItems.id, data.sourceId));
      return exploration!;
    });
    const { NativeConversationReader } = await import(
      "../src/personal-understanding/native-conversations.js"
    );
    const reader = new NativeConversationReader(db.db);
    expect(
      (await reader.read(ctx, { conversationId: thread.id, includeAnalysis: true })).turns.find(
        (t) => t.role === "assistant",
      )?.content,
    ).toContain("旧回复");
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx
        .update(coreSchema.claimRevisions)
        .set({ status: "withdrawn" })
        .where(eq(coreSchema.claimRevisions.id, data.revisionId));
    });
    const hidden = await reader.read(ctx, { conversationId: thread.id, includeAnalysis: true });
    expect(hidden.turns.find((t) => t.role === "assistant")?.content).toBeNull();
    expect(hidden.assistant_context_withheld).toBe(true);
  } finally {
    await Promise.all([db.sql.end(), identity.sql.end()]);
  }
});

it("bounds initial preferences and keeps conversation scope ahead of a newer default with paging", async () => {
  const cfg = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const db = createDb(cfg.runtime_url);
  const identity = createDb(cfg.identity_url);
  try {
    const ctx = await new ProfileService(identity.db).resolve({
      provider: "domain-preference-page",
      principalId: randomUUID(),
    });
    const scoped = await source(db.db, ctx, {
      content: "本次对话请简短回答。",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const persistent = await source(db.db, ctx, {
      content: "以后所有对话请详细回答。",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const conversationId = randomUUID();
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx
        .update(coreSchema.claimRevisions)
        .set({
          details: {
            interaction_preference: {
              explicit: true,
              source_id: persistent.sourceId,
              source_assessment_version: 1,
              original_text: "以后所有对话请详细回答。",
              scope_quote: "以后所有对话请详细回答。",
              scope: { kind: "default", explicitlyLongTerm: true },
            },
          },
        })
        .where(eq(coreSchema.claimRevisions.id, persistent.revisionId));
      for (let i = 0; i < 10; i++) {
        const [claim] = await tx
          .insert(coreSchema.claims)
          .values({ ...ctx, claimKey: `scoped-pref:${randomUUID()}`, claimKind: "preference" })
          .returning();
        const [revision] = await tx
          .insert(coreSchema.claimRevisions)
          .values({
            claimId: claim!.id,
            version: 1,
            mode: "observation",
            text: `简短回答${"的表达范围".repeat(50)}`,
            scope: "本次对话",
            status: "current",
            evidenceStatus: "valid",
            confidenceLevel: "low",
            confidenceBasis: "synthetic",
            details: {
              interaction_preference: {
                explicit: true,
                source_id: scoped.sourceId,
                source_assessment_version: 1,
                original_text: "本次对话请简短回答。",
                scope: { kind: "conversation", id: conversationId },
              },
            },
          })
          .returning();
        await tx.insert(coreSchema.claimEvidence).values({
          claimRevisionId: revision!.id,
          evidenceSpanId: scoped.spanId,
          relation: "supports",
          directness: "direct",
          contribution: "medium",
          independenceGroup: scoped.sourceId,
          scopeMatch: "exact",
          rationale: "synthetic",
        });
      }
    });
    const reader = new UnderstandingReadTools(db.db);
    const task = {
      id: randomUUID(),
      conversationId,
      input: "简短回答",
      taskType: "conversation",
      intent: "conversation" as const,
      writesUnderstanding: false,
    };
    const initial = await reader.initialContext(ctx, task);
    expect(initial.preferences).toHaveLength(8);
    expect(initial.preferences.every((p) => p.scope.kind === "conversation")).toBe(true);
    expect(initial.understandingIndex.every((i) => i.title.length <= 160)).toBe(true);
    expect(initial.omitted.preferences).toBe(3);
    const more = await reader.interactionPreferences(ctx, task, { cursor: 8, limit: 10 });
    expect(more.items).toHaveLength(3);
    expect(more.next_cursor).toBeNull();
    expect(more.items.at(-1)?.preference.scope.kind).toBe("default");
  } finally {
    await Promise.all([db.sql.end(), identity.sql.end()]);
  }
});

it("navigates claim versions and reads only source-backed feedback while new objections invalidate dependencies", async () => {
  const cfg = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const db = createDb(cfg.runtime_url);
  const identity = createDb(cfg.identity_url);
  try {
    const profiles = new ProfileService(identity.db);
    const ctx = await profiles.resolve({ provider: "domain-feedback", principalId: randomUUID() });
    const other = await profiles.resolve({
      provider: "domain-feedback",
      principalId: randomUUID(),
    });
    const base = await source(db.db, ctx, {
      content: "当时只在这次展览核对入场名单。",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const note = await source(db.db, ctx, {
      content: "我补充的情境是一次展览，不是所有活动。",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const agreement = await source(db.db, ctx, {
      content: "这条范围我认同。",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const hidden = await source(db.db, ctx, {
      content: "EXCLUDED_FEEDBACK_BODY_MUST_NOT_LEAK",
      eligibility: "excluded",
      attribution: "confirmed_subject",
    });
    const outside = await source(db.db, other, {
      content: "OTHER_PROFILE_FEEDBACK_MUST_NOT_LEAK",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const data = await withProfileTransaction(db.db, ctx, async (tx) => {
      const [experience] = await tx
        .insert(coreSchema.experiences)
        .values({ ...ctx, summary: "展览核对" })
        .returning();
      const [thread] = await tx
        .insert(coreSchema.explorations)
        .values({ ...ctx, experienceId: experience!.id })
        .returning();
      await tx
        .update(coreSchema.claims)
        .set({ claimKey: `${thread!.id}/entry-list` })
        .where(eq(coreSchema.claims.id, base.claimId));
      await tx
        .update(coreSchema.claimRevisions)
        .set({ status: "superseded" })
        .where(eq(coreSchema.claimRevisions.id, base.revisionId));
      const [revision] = await tx
        .insert(coreSchema.claimRevisions)
        .values({
          claimId: base.claimId,
          version: 2,
          mode: "self_report",
          text: "这次展览核对入场名单",
          scope: "这一次展览",
          status: "current",
          evidenceStatus: "valid",
          confidenceLevel: "low",
          confidenceBasis: "synthetic",
          revisionReason: "把范围明确为一次展览",
          supersedesRevisionId: base.revisionId,
        })
        .returning();
      await tx.insert(coreSchema.claimEvidence).values({
        claimRevisionId: revision!.id,
        evidenceSpanId: base.spanId,
        relation: "supports",
        directness: "direct",
        contribution: "medium",
        independenceGroup: base.sourceId,
        scopeMatch: "exact",
        rationale: "synthetic",
      });
      return { revision: revision!, thread: thread! };
    });
    const { capturePiRevisionDependency, assertPiRevisionsCurrent } = await import(
      "../src/personal-understanding/revision-dependencies.js"
    );
    const before = await withProfileTransaction(db.db, ctx, (tx) =>
      capturePiRevisionDependency(tx, ctx, data.revision.id),
    );
    await withProfileTransaction(db.db, ctx, async (tx) => {
      for (const [sourceId, type] of [
        [note.sourceId, "missing_context"],
        [agreement.sourceId, "fact_agreement"],
        [hidden.sourceId, "wrong_fact"],
        [null, "other"],
      ] as const)
        await tx.insert(coreSchema.feedbackEvents).values({
          ...ctx,
          targetType: "claim_revision",
          targetId: data.revision.id,
          feedbackType: type,
          sourceItemId: sourceId,
          note: "PRIVATE_FEEDBACK_NOTE_DO_NOT_RETURN",
        });
    });
    await expect(
      withProfileTransaction(db.db, other, async (tx) => {
        await tx.insert(coreSchema.feedbackEvents).values({
          ...other,
          targetType: "claim_revision",
          targetId: data.revision.id,
          feedbackType: "wrong_fact",
          sourceItemId: outside.sourceId,
          note: "OTHER_PROFILE_NOTE_DO_NOT_RETURN",
        });
      }),
    ).rejects.toThrow();
    await expect(
      withProfileTransaction(db.db, ctx, (tx) => assertPiRevisionsCurrent(tx, ctx, [before])),
    ).rejects.toThrow("PI_REVISION_STALE_DEPENDENCY");
    const reader = new UnderstandingReadTools(db.db);
    const versions = await reader.listUnderstandings(ctx, {
      claimId: base.claimId,
      includeHistory: true,
    });
    expect(versions.items.map((item) => item.revision_id)).toEqual(
      expect.arrayContaining([base.revisionId, data.revision.id]),
    );
    expect(versions.items).toHaveLength(2);
    const first = await reader.readRevision(ctx, { id: data.revision.id, feedbackLimit: 1 });
    expect(first.revision_reason).toBe("把范围明确为一次展览");
    expect(first.supersedes_revision_id).toBe(base.revisionId);
    expect(first.text).toBe("这次展览核对入场名单");
    expect(first.qualified).toBe(false);
    expect(first.requires_reassessment).toBe(true);
    expect(first.feedback.total_available).toBe(2);
    expect(first.feedback.omitted_unavailable).toBe(2);
    expect(first.feedback.items).toHaveLength(1);
    expect(first.feedback.next_cursor).toBe(1);
    const second = await reader.readRevision(ctx, {
      id: data.revision.id,
      feedbackCursor: 1,
      feedbackLimit: 1,
    });
    const texts = [...first.feedback.items, ...second.feedback.items].map(
      (item) => item.source_expression.text,
    );
    expect(texts).toEqual(
      expect.arrayContaining(["我补充的情境是一次展览，不是所有活动。", "这条范围我认同。"]),
    );
    expect(second.feedback.next_cursor).toBeNull();
    expect(JSON.stringify(first)).not.toContain("PRIVATE_FEEDBACK_NOTE");
    expect(JSON.stringify(first)).not.toContain("EXCLUDED_FEEDBACK_BODY");
    expect(JSON.stringify(first)).not.toContain("OTHER_PROFILE");
    for (const item of first.feedback.items)
      expect(first.dependencies.some((dependency) => dependency.sourceId === item.source_id)).toBe(
        true,
      );
    const { getCurrentUnderstanding } = await import("../src/core/exploration-views.js");
    const { loadCurrentClaimRows } = await import("../src/core/exploration-reading.js");
    const { loadPriorUnderstanding } = await import("../src/core/prior-understanding.js");
    const ui = await withProfileTransaction(db.db, ctx, (tx) =>
      getCurrentUnderstanding(tx as never, ctx),
    );
    expect(ui.claims.some((claim) => claim.claim_revision_id === data.revision.id)).toBe(false);
    expect(
      ui.needs_review.find((claim) => claim.claim_revision_id === data.revision.id),
    ).toMatchObject({
      text: "这次展览核对入场名单",
      pending_feedback: true,
      evidence_status: "valid",
    });
    const current = await withProfileTransaction(db.db, ctx, (tx) =>
      loadCurrentClaimRows(tx, ctx, data.thread.id),
    );
    expect(current.find((claim) => claim.revisionId === data.revision.id)?.pendingFeedback).toBe(
      true,
    );
    const prior = await withProfileTransaction(db.db, ctx, (tx) =>
      loadPriorUnderstanding(tx, ctx, { explorationId: randomUUID(), queryText: "展览入场名单" }),
    );
    expect(prior.claims.some((claim) => claim.revisionId === data.revision.id)).toBe(false);
    expect(prior.excluded.find((claim) => claim.revisionId === data.revision.id)?.reason).toBe(
      "pending_feedback",
    );
  } finally {
    await Promise.all([db.sql.end(), identity.sql.end()]);
  }
});

it("does not turn agreement or unbacked notes into objections and keeps later feedback out of historical text", async () => {
  const cfg = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const db = createDb(cfg.runtime_url);
  const identity = createDb(cfg.identity_url);
  try {
    const ctx = await new ProfileService(identity.db).resolve({
      provider: "feedback-time",
      principalId: randomUUID(),
    });
    const base = await source(db.db, ctx, {
      content: "只在这一轮核对材料。",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const agree = await source(db.db, ctx, {
      content: "这句话符合我的意思。",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const late = await source(db.db, ctx, {
      content: "FUTURE_FEEDBACK_EXPRESSION_DO_NOT_LEAK",
      eligibility: "eligible",
      attribution: "confirmed_subject",
    });
    const cutoff = new Date(Date.now() + 120_000);
    const later = new Date(cutoff.getTime() + 60_000);
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx.insert(coreSchema.feedbackEvents).values({
        ...ctx,
        targetType: "claim_revision",
        targetId: base.revisionId,
        feedbackType: "fact_agreement",
        sourceItemId: agree.sourceId,
        note: "PRIVATE_AGREEMENT_NOTE",
      });
    });
    const reader = new UnderstandingReadTools(db.db, { asOf: cutoff.toISOString() });
    const positive = await reader.readRevision(ctx, { id: base.revisionId });
    expect(positive.qualified).toBe(true);
    expect(positive.requires_reassessment).toBe(false);
    expect(positive.feedback.items[0]?.qualification).toBe(
      "subject_feedback_not_independent_support",
    );
    const { capturePiRevisionDependency } = await import(
      "../src/personal-understanding/revision-dependencies.js"
    );
    const before = await withProfileTransaction(db.db, ctx, (tx) =>
      capturePiRevisionDependency(tx, ctx, base.revisionId),
    );
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx.insert(coreSchema.feedbackEvents).values({
        ...ctx,
        targetType: "claim_revision",
        targetId: base.revisionId,
        feedbackType: "wrong_fact",
        sourceItemId: null,
        note: "UNBACKED_NOTE_IS_NOT_A_PERSONAL_FACT",
      });
    });
    const afterUnbacked = await withProfileTransaction(db.db, ctx, (tx) =>
      capturePiRevisionDependency(tx, ctx, base.revisionId),
    );
    expect(afterUnbacked.fingerprint).toBe(before.fingerprint);
    expect((await reader.readRevision(ctx, { id: base.revisionId })).qualified).toBe(true);
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx
        .update(coreSchema.sourceItems)
        .set({ capturedAt: later })
        .where(eq(coreSchema.sourceItems.id, late.sourceId));
      await tx.insert(coreSchema.feedbackEvents).values({
        ...ctx,
        targetType: "claim_revision",
        targetId: base.revisionId,
        feedbackType: "wrong_fact",
        sourceItemId: late.sourceId,
        createdAt: later,
        note: "PRIVATE_LATE_NOTE",
      });
    });
    const history = await reader.readRevision(ctx, { id: base.revisionId });
    expect(JSON.stringify(history)).not.toContain("FUTURE_FEEDBACK_EXPRESSION");
    expect(JSON.stringify(history)).not.toContain(late.sourceId);
    expect(JSON.stringify(history)).not.toContain("PRIVATE_LATE_NOTE");
    expect(history.qualified).toBe(false);
    expect(history.requires_reassessment).toBe(true);
    const after = await withProfileTransaction(db.db, ctx, (tx) =>
      capturePiRevisionDependency(tx, ctx, base.revisionId),
    );
    expect(after.fingerprint).not.toBe(before.fingerprint);
    await expect(
      withProfileTransaction(db.db, ctx, (tx) =>
        capturePiRevisionDependency(tx, ctx, base.revisionId, true),
      ),
    ).rejects.toThrow("PI_REVISION_STALE_DEPENDENCY");
    await withProfileTransaction(db.db, ctx, async (tx) => {
      const [stored] = await tx
        .select()
        .from(coreSchema.claimRevisions)
        .where(eq(coreSchema.claimRevisions.id, base.revisionId));
      expect(stored?.status).toBe("current");
      expect(stored?.evidenceStatus).toBe("valid");
    });
  } finally {
    await Promise.all([db.sql.end(), identity.sql.end()]);
  }
});
