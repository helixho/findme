// Requires process.env.FINDME_ACCOUNT_VERIFY_CONFIG; must be registered in the DB manifest.
import { randomUUID } from "node:crypto";
import { KnowledgeProcessingRecord } from "@findme/core";
import { coreSchema as c, knowledgeSchema as k } from "@findme/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getKnowledgeTopic,
  getKnowledgeTopicVersions,
  listKnowledgeTopics,
  processKnowledgeTopic,
  recordKnowledgeFeedback,
} from "../src/knowledge-processing/service.js";
import {
  type KnowledgeEnvironment,
  knowledgeEnvironment,
  link,
  serviceDb,
} from "./helpers/knowledge-fixture.js";

describe("knowledge processing / real isolated PostgreSQL / five service exports", () => {
  let env: KnowledgeEnvironment;
  beforeAll(async () => {
    env = await knowledgeEnvironment();
  });
  afterAll(async () => {
    await env?.close();
  });
  const input = (source: string, topic = "tasks", version = 0) => ({
    topic_key: topic,
    title: "合成任务",
    question: "这个限定范围有哪些已有认识？",
    source_ids: [source],
    expected_version: version,
  });
  const process = (
    f: Awaited<ReturnType<KnowledgeEnvironment["fixture"]>>,
    topic = "tasks",
    version = 0,
  ) =>
    env.within(f.ctx, (tx) =>
      processKnowledgeTopic(serviceDb(tx), f.ctx, input(f.source, topic, version)),
    );
  const get = (f: Awaited<ReturnType<KnowledgeEnvironment["fixture"]>>, topic = "tasks") =>
    env.within(f.ctx, (tx) => getKnowledgeTopic(serviceDb(tx), f.ctx, topic));
  const versions = (f: Awaited<ReturnType<KnowledgeEnvironment["fixture"]>>, topic = "tasks") =>
    env.within(f.ctx, (tx) => getKnowledgeTopicVersions(serviceDb(tx), f.ctx, topic));
  const feedback = (
    f: Awaited<ReturnType<KnowledgeEnvironment["fixture"]>>,
    kind: string,
    topic = "tasks",
    version = 1,
    revisions = [f.revision],
  ) =>
    env.within(f.ctx, (tx) =>
      recordKnowledgeFeedback(
        serviceDb(tx),
        f.ctx,
        { expected_version: version, kind, note: "合成本人反馈", claim_revision_ids: revisions },
        topic,
      ),
    );

  it("publishes existing claims only, lists/gets/versions and replays unchanged processing without appending", async () => {
    const f = await env.fixture();
    expect(await get(f)).toBeUndefined();
    expect(await versions(f)).toEqual([]);
    const first = await process(f);
    expect(
      KnowledgeProcessingRecord.parse(first).result?.findings.map((x) => x.claim_revision_id),
    ).toEqual([f.revision]);
    expect(first.result?.findings[0]?.text).toBe("合成认识：短时任务中更容易开始");
    const replay = await process(f, "tasks", 1);
    expect(replay).toEqual(first);
    expect((await versions(f)).map((x) => [x.version, x.is_current])).toEqual([[1, true]]);
    const list = await env.within(f.ctx, (tx) => listKnowledgeTopics(serviceDb(tx), f.ctx));
    expect(list).toEqual([first]);
    await expect(process(f)).rejects.toMatchObject({ code: "STALE_VERSION", status: 409 });
  });

  it("rejects zero, duplicate, malformed and foreign source selections without writes", async () => {
    const f = await env.fixture();
    const foreign = await env.fixture();
    for (const source_ids of [[], [f.source, f.source], ["invalid"]]) {
      await expect(
        env.within(f.ctx, (tx) =>
          processKnowledgeTopic(serviceDb(tx), f.ctx, { ...input(f.source), source_ids }),
        ),
      ).rejects.toMatchObject({ name: "ZodError" });
    }
    for (const source of [randomUUID(), foreign.source])
      await expect(
        env.within(f.ctx, (tx) => processKnowledgeTopic(serviceDb(tx), f.ctx, input(source))),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await versions(f)).toEqual([]);
  });

  it("returns unknown without inventing claims, respects changed eligibility, and rolls back processing", async () => {
    const f = await env.fixture();
    await env.within(f.ctx, (tx) =>
      tx.delete(c.claimEvidence).where(eq(c.claimEvidence.claimRevisionId, f.revision)),
    );
    const empty = await process(f);
    expect(empty.result?.status).toBe("unknown");
    expect(empty.result?.findings).toEqual([]);
    expect(empty.coverage[0]?.disposition).toBe("unknown");
    await env.within(f.ctx, async (tx) => {
      await tx.insert(c.claimEvidence).values(link(f.revision, f.span));
      await tx
        .update(c.sourceAssessments)
        .set({ eligibility: "excluded" })
        .where(eq(c.sourceAssessments.sourceItemId, f.source));
    });
    const excluded = await process(f, "tasks", 1);
    expect(excluded.result?.findings).toEqual([]);
    expect(excluded.coverage[0]?.disposition).toBe("excluded");
    await env.within(f.ctx, (tx) =>
      tx
        .update(c.sourceAssessments)
        .set({ eligibility: "eligible" })
        .where(eq(c.sourceAssessments.sourceItemId, f.source)),
    );
    await expect(
      env.within(f.ctx, async (tx) => {
        const restored = await processKnowledgeTopic(
          serviceDb(tx),
          f.ctx,
          input(f.source, "tasks", 2),
        );
        expect(restored.result?.findings).toHaveLength(1);
        throw new Error("KNOWLEDGE_PROCESS_ROLLBACK");
      }),
    ).rejects.toThrow("KNOWLEDGE_PROCESS_ROLLBACK");
    expect((await versions(f)).map((x) => x.version)).toEqual([2, 1]);
    const restored = await process(f, "tasks", 2);
    expect(restored.result?.findings).toHaveLength(1);
  });

  it("isolates identical topic keys across profiles in all reads, processing and feedback", async () => {
    const a = await env.fixture();
    const b = await env.fixture();
    await process(a);
    expect(await get(b)).toBeUndefined();
    expect(await versions(b)).toEqual([]);
    expect(await env.within(b.ctx, (tx) => listKnowledgeTopics(serviceDb(tx), b.ctx))).toEqual([]);
    await expect(feedback(b, "fact_correction")).rejects.toMatchObject({ code: "STALE_VERSION" });
    await process(b);
    await expect(feedback(b, "fact_correction", "tasks", 1, [a.revision])).rejects.toMatchObject({
      code: "FINDING_NOT_FOUND",
    });
    expect((await get(a))?.version).toBe(1);
    expect((await get(b))?.claim_revision_ids).toEqual([b.revision]);
  });

  it("excludes sources immediately from current/list/history, restores only live valid dependencies", async () => {
    const f = await env.fixture();
    await process(f);
    await feedback(f, "utility_feedback"); // produce a genuinely historical version
    await env.within(f.ctx, (tx) =>
      tx
        .update(c.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(c.sourceItems.id, f.source)),
    );
    expect((await get(f))?.result?.findings).toEqual([]);
    const list = await env.within(f.ctx, (tx) => listKnowledgeTopics(serviceDb(tx), f.ctx));
    expect(list[0]?.pending_review).toBe(true);
    const history = await versions(f);
    for (const record of history) {
      expect(record.result?.findings).toEqual([]);
      expect(record.historical_result?.findings ?? []).toEqual([]);
    }
    expect(JSON.stringify(history)).not.toContain("合成原话");
    await env.within(f.ctx, (tx) =>
      tx.update(c.sourceItems).set({ usageStatus: "active" }).where(eq(c.sourceItems.id, f.source)),
    );
    expect((await get(f))?.result?.findings).toHaveLength(1);
    await env.within(f.ctx, (tx) =>
      tx
        .update(c.claimRevisions)
        .set({ evidenceStatus: "invalid" })
        .where(eq(c.claimRevisions.id, f.revision)),
    );
    expect((await get(f))?.result?.findings).toEqual([]);
    // The old version remains identifiable as history, never a current claim.
    expect((await versions(f))[1]?.is_current).toBe(false);
  });

  it("does not republish a source replaced by corrects/updates links", async () => {
    const f = await env.fixture();
    await process(f);
    const replacement = randomUUID();
    await env.within(f.ctx, async (tx) => {
      await tx.insert(c.sourceItems).values({
        ...f.ctx,
        id: replacement,
        sourceKind: "quick_note",
        authorKind: "subject",
        content: "合成更正来源",
      });
      await tx
        .insert(c.sourceLinks)
        .values({ sourceItemId: replacement, targetSourceItemId: f.source, relation: "corrects" });
    });
    expect((await get(f))?.result?.findings).toEqual([]);
    expect((await get(f))?.coverage[0]?.disposition).toBe("excluded");
    const next = await process(f, "tasks", 1);
    expect(next.result?.findings).toEqual([]);
    expect(next.result?.status).toBe("unknown");
    expect(next.coverage[0]?.disposition).toBe("excluded");
    expect((await versions(f)).every((x) => !x.result?.findings.length)).toBe(true);
  });

  it("masks rebound and reattributed evidence in current and historical snapshots", async () => {
    const f = await env.fixture();
    await process(f);
    await feedback(f, "utility_feedback");
    const rebound = randomUUID();
    await env.within(f.ctx, async (tx) => {
      await tx.insert(c.sourceItems).values({
        ...f.ctx,
        id: rebound,
        sourceKind: "quick_note",
        authorKind: "subject",
        content: "合成改绑目标",
      });
      await tx
        .update(c.evidenceSpans)
        .set({ sourceItemId: rebound })
        .where(eq(c.evidenceSpans.id, f.span));
    });
    expect((await get(f))?.result?.findings).toEqual([]);
    expect(JSON.stringify(await versions(f))).not.toContain("合成原话");
    await env.within(f.ctx, (tx) =>
      tx
        .update(c.evidenceSpans)
        .set({ sourceItemId: f.source, authorKind: "third_party", aboutSubject: false })
        .where(eq(c.evidenceSpans.id, f.span)),
    );
    expect(JSON.stringify(await versions(f))).not.toContain("合成原话");
    expect((await process(f, "tasks", 2)).result?.findings).toEqual([]);
  });

  it("collapses a shared evidence root across an unselected intermediate source", async () => {
    const f = await env.fixture();
    const middle = randomUUID();
    const derived = randomUUID();
    const span = randomUUID();
    await env.within(f.ctx, async (tx) => {
      for (const id of [middle, derived]) {
        await tx.insert(c.sourceItems).values({
          ...f.ctx,
          id,
          sourceKind: "quick_note",
          authorKind: "subject",
          content: "合成同源材料",
        });
        await tx.insert(c.sourceAssessments).values({
          sourceItemId: id,
          version: 1,
          attributionStatus: "confirmed_subject",
          contextCompleteness: "sufficient",
          temporalPrecision: "exact",
          eligibility: "eligible",
          rationale: "合成同源",
        });
      }
      await tx
        .insert(c.evidenceSpans)
        .values({ id: span, sourceItemId: derived, quote: "合成派生原话", authorKind: "subject" });
      await tx.insert(c.claimEvidence).values(link(f.revision, span));
      await tx.insert(c.sourceLinks).values([
        { sourceItemId: derived, targetSourceItemId: middle, relation: "quoted_from" },
        { sourceItemId: middle, targetSourceItemId: f.source, relation: "derived_from" },
      ]);
    });
    const record = await env.within(f.ctx, (tx) =>
      processKnowledgeTopic(serviceDb(tx), f.ctx, {
        ...input(f.source),
        source_ids: [derived, f.source],
      }),
    );
    expect(record.result?.findings[0]?.independent_support_count).toBe(1);
    expect(record.coverage.find((x) => x.source_id === derived)?.disposition).toBe("reused");
  });

  it.each(["fact_correction", "interpretation_disagreement", "temporal_change"])(
    "propagates %s to shared topics and overview, blocks new publications",
    async (kind) => {
      const f = await env.fixture();
      await process(f);
      await process(f, "related");
      await process(f, "personal_overview");
      const other = await env.fixture(f.ctx);
      await process(other, "unrelated");
      const response = await feedback(f, kind);
      expect(response.affected_topics).toEqual(["related"]);
      expect(response.affected_overviews).toEqual(["personal_overview"]);
      for (const topic of ["tasks", "related", "personal_overview"]) {
        const record = await get(f, topic);
        expect(record?.pending_review).toBe(true);
        expect(record?.result?.findings).toEqual([]);
        expect(record?.feedback[0]?.kind).toBe(kind);
      }
      const newTopic = await process(f, "after-feedback");
      expect(newTopic.pending_review).toBe(true);
      expect(newTopic.result?.findings).toEqual([]);
      expect(newTopic.blocking_feedback[0]?.topic_key).toBe("tasks");
      const reprocessed = await process(f, "tasks", 2);
      expect(reprocessed.pending_review).toBe(true);
      expect(reprocessed.feedback[0]?.resolved_at).toBeUndefined();
      expect((await get(other, "unrelated"))?.version).toBe(1);
      const claimRows = await env.within(f.ctx, (tx) =>
        tx.select().from(c.claimRevisions).where(eq(c.claimRevisions.id, f.revision)),
      );
      expect(claimRows[0]).toMatchObject({ status: "current", evidenceStatus: "valid" });
    },
  );

  it.each(["fact_correction", "interpretation_disagreement"])(
    "%s distinguishes shared factual material from a different interpretation",
    async (kind) => {
      const f = await env.fixture();
      await process(f);
      const otherClaim = randomUUID();
      const otherRevision = randomUUID();
      await env.within(f.ctx, async (tx) => {
        await tx
          .insert(c.claims)
          .values({ ...f.ctx, id: otherClaim, claimKey: randomUUID(), claimKind: "pattern" });
        await tx.insert(c.claimRevisions).values({
          id: otherRevision,
          claimId: otherClaim,
          version: 1,
          mode: "observation",
          text: "另一条合成解释",
          scope: "不同解释",
          confidenceLevel: "low",
          confidenceBasis: "同一合成材料",
        });
        await tx.insert(c.claimEvidence).values(link(otherRevision, f.span));
      });
      await process(f, "related");
      await feedback(f, kind);
      const related = await get(f, "related");
      expect(related?.result?.findings.map((x) => x.claim_revision_id)).toEqual(
        kind === "fact_correction" ? [] : [otherRevision],
      );
      expect(related?.pending_review).toBe(true);
    },
  );

  it("a superseding claim resolves feedback only after explicit reprocessing with the new revision", async () => {
    const f = await env.fixture();
    await process(f);
    await feedback(f, "interpretation_disagreement");
    const replacement = randomUUID();
    await env.within(f.ctx, async (tx) => {
      await tx
        .update(c.claimRevisions)
        .set({ status: "superseded" })
        .where(eq(c.claimRevisions.id, f.revision));
      await tx.insert(c.claimRevisions).values({
        id: replacement,
        claimId: f.claim,
        version: 2,
        mode: "observation",
        text: "修订后的合成认识",
        scope: "修订后的限定范围",
        confidenceLevel: "low",
        confidenceBasis: "重新评估",
        supersedesRevisionId: f.revision,
      });
      await tx.insert(c.claimEvidence).values(link(replacement, f.span));
    });
    expect((await get(f))?.pending_review).toBe(true);
    const next = await process(f, "tasks", 2);
    expect(next.pending_review).toBe(false);
    expect(next.feedback[0]?.resolved_at).toBeDefined();
    expect(next.feedback[0]?.resolved_by_revision_ids).toEqual([replacement]);
    expect(next.result?.findings.map((x) => x.claim_revision_id)).toEqual([replacement]);
    const old = (await versions(f)).find((x) => x.version === 1);
    expect(old?.is_current).toBe(false);
    expect(old?.result?.findings[0]?.claim_revision_id).toBe(f.revision);
  });

  it("helpful feedback is not acceptance, does not invalidate or add support, and stale/invalid feedback writes nothing", async () => {
    const f = await env.fixture();
    await process(f);
    await process(f, "related");
    const before = await get(f);
    const helpful = await feedback(f, "utility_feedback");
    expect(helpful.result).toEqual(before?.result);
    expect(helpful.pending_review).toBe(false);
    expect(helpful.affected_topics).toEqual([]);
    expect((await get(f, "related"))?.version).toBe(1);
    expect(helpful.result?.findings[0]?.independent_support_count).toBe(1);
    await expect(feedback(f, "fact_correction")).rejects.toMatchObject({ code: "STALE_VERSION" });
    await expect(feedback(f, "invented_kind", "tasks", 2)).rejects.toMatchObject({
      name: "ZodError",
    });
    expect((await versions(f)).map((x) => x.version)).toEqual([2, 1]);
  });

  it.each(["fact_correction", "interpretation_disagreement"])(
    "source exclusion settles %s only according to its meaning",
    async (kind) => {
      const f = await env.fixture();
      await process(f);
      await feedback(f, kind);
      await env.within(f.ctx, (tx) =>
        tx
          .update(c.sourceItems)
          .set({ usageStatus: "excluded" })
          .where(eq(c.sourceItems.id, f.source)),
      );
      const next = await process(f, "tasks", 2);
      expect(next.result?.findings).toEqual([]);
      expect(next.pending_review).toBe(kind === "interpretation_disagreement");
      expect(Boolean(next.feedback[0]?.resolved_at)).toBe(kind === "fact_correction");
    },
  );

  it("optimistic concurrent writes serialize, and transaction failure rolls back origin plus propagated records", async () => {
    const f = await env.fixture();
    await process(f);
    await process(f, "related");
    const results = await Promise.allSettled([
      feedback(f, "fact_correction"),
      feedback(f, "interpretation_disagreement"),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((x) => x.status === "rejected")).toMatchObject([
      { reason: { code: "STALE_VERSION" } },
    ]);
    expect((await versions(f)).map((x) => x.version)).toEqual([2, 1]);
    expect((await get(f, "related"))?.version).toBe(2);
    const before = await env.within(f.ctx, (tx) =>
      tx
        .select()
        .from(k.knowledgeProcessingRecords)
        .orderBy(k.knowledgeProcessingRecords.topicKey, k.knowledgeProcessingRecords.version),
    );
    await expect(
      env.within(f.ctx, async (tx) => {
        await recordKnowledgeFeedback(
          serviceDb(tx),
          f.ctx,
          {
            expected_version: 2,
            kind: "temporal_change",
            note: "合成回滚探针",
            claim_revision_ids: [f.revision],
          },
          "tasks",
        );
        throw new Error("KNOWLEDGE_ROLLBACK_PROBE");
      }),
    ).rejects.toThrow("KNOWLEDGE_ROLLBACK_PROBE");
    const after = await env.within(f.ctx, (tx) =>
      tx
        .select()
        .from(k.knowledgeProcessingRecords)
        .orderBy(k.knowledgeProcessingRecords.topicKey, k.knowledgeProcessingRecords.version),
    );
    expect(after).toEqual(before);
  });

  it("concurrent first processing creates one version; changed question creates a new bounded snapshot", async () => {
    const f = await env.fixture();
    const results = await Promise.allSettled([process(f), process(f)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((x) => x.status === "rejected")).toMatchObject([
      { reason: { code: "STALE_VERSION" } },
    ]);
    const next = await env.within(f.ctx, (tx) =>
      processKnowledgeTopic(serviceDb(tx), f.ctx, {
        ...input(f.source, "tasks", 1),
        question: "另一个合成问题",
      }),
    );
    expect(next.version).toBe(2);
    expect(next.result?.question).toBe("另一个合成问题");
    expect((await versions(f)).map((x) => x.is_current)).toEqual([true, false]);
  });
});
