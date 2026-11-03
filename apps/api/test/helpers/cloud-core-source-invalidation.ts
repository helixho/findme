import { randomUUID } from "node:crypto";
import { type Db, coreSchema as c } from "@findme/db";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { CloudLifecycleService } from "../../src/cloud-diagnostic/lifecycle.js";
import { cloudSourceHash } from "../../src/cloud-diagnostic/repository.js";
import { withProfileTransaction } from "../../src/cloud-diagnostic/scope.js";
import {
  type PersonalContext,
  amendExplorationSource,
  getCurrentUnderstanding,
} from "../../src/core/exploration-service.js";
import { updateSourceAssessment } from "../../src/core/source-service.js";

type Environment = {
  db: () => Db;
  context: () => Promise<PersonalContext>;
  otherContext: () => Promise<PersonalContext>;
  corePost: (path: string, body: unknown, key: string) => Promise<Response>;
};

// Uses the existing account suite's real PostgreSQL roles and synthetic identities.
export function cloudCoreSourceInvalidation(env: Environment) {
  async function fixture(additionalSupport = false) {
    const db = env.db();
    const ctx = await env.context();
    const lifecycle = new CloudLifecycleService(db);
    const ids = Array.from({ length: 12 }, () => randomUUID());
    const [
      source,
      otherSource,
      replacement,
      span,
      otherSpan,
      experience,
      exploration,
      completed,
      claim,
      current,
      historical,
      unrelated,
    ] = ids as string[];
    await withProfileTransaction(db, ctx, async (tx) => {
      for (const id of [source!, otherSource!, replacement!]) {
        await tx.insert(c.sourceItems).values({
          ...ctx,
          id,
          sourceKind: "quick_note",
          authorKind: "subject",
          content: `合成来源 ${id}`,
          capturedAt: new Date(),
        });
        await tx.insert(c.sourceAssessments).values({
          sourceItemId: id,
          version: 1,
          attributionStatus: "confirmed_subject",
          contextCompleteness: "sufficient",
          temporalPrecision: "exact",
          eligibility: "eligible",
          rationale: "合成夹具",
        });
      }
      await tx.insert(c.evidenceSpans).values([
        { id: span!, sourceItemId: source!, quote: `合成来源 ${source}`, authorKind: "subject" },
        {
          id: otherSpan!,
          sourceItemId: otherSource!,
          quote: `合成来源 ${otherSource}`,
          authorKind: "subject",
        },
      ]);
      await tx.insert(c.experiences).values({ ...ctx, id: experience!, summary: "合成经历" });
      await tx.insert(c.experienceEvidence).values([
        { experienceId: experience!, evidenceSpanId: span! },
        { experienceId: experience!, evidenceSpanId: otherSpan! },
      ]);
      await tx.insert(c.explorations).values([
        { ...ctx, id: exploration!, experienceId: experience!, version: 3 },
        { ...ctx, id: completed!, experienceId: experience!, status: "completed", version: 5 },
      ]);
      await tx.insert(c.claims).values([
        { ...ctx, id: claim!, claimKey: `${exploration}/affected`, claimKind: "pattern" },
        { ...ctx, id: unrelated!, claimKey: `${randomUUID()}/unrelated`, claimKind: "pattern" },
      ]);
      await tx.insert(c.claimRevisions).values([
        {
          id: historical!,
          claimId: claim!,
          version: 1,
          mode: "observation",
          text: "历史认识",
          scope: "历史范围",
          status: "superseded",
          confidenceLevel: "low",
          confidenceBasis: "历史依据",
        },
        {
          id: current!,
          claimId: claim!,
          version: 2,
          mode: "observation",
          text: "当前认识",
          scope: "当前范围",
          confidenceLevel: "low",
          confidenceBasis: "当前依据",
        },
        {
          id: unrelated!,
          claimId: unrelated!,
          version: 1,
          mode: "observation",
          text: "无关认识",
          scope: "另一来源",
          confidenceLevel: "low",
          confidenceBasis: "独立依据",
        },
      ]);
      const link = (revision: string, evidence: string) => ({
        claimRevisionId: revision,
        evidenceSpanId: evidence,
        relation: "supports",
        directness: "direct",
        contribution: "high",
        independenceGroup: evidence,
        scopeMatch: "合成范围",
        rationale: "合成支持",
      });
      await tx
        .insert(c.claimEvidence)
        .values([
          link(current!, span!),
          link(historical!, span!),
          link(unrelated!, otherSpan!),
          ...(additionalSupport ? [link(current!, otherSpan!)] : []),
        ]);
    });
    async function action(kind: "exclude" | "restore" | "delete", key = randomUUID()) {
      const [row, assessment] = await withProfileTransaction(db, ctx, async (tx) => {
        const [s] = await tx.select().from(c.sourceItems).where(eq(c.sourceItems.id, source!));
        const a = await tx
          .select()
          .from(c.sourceAssessments)
          .where(eq(c.sourceAssessments.sourceItemId, source!));
        return [s!, a.find((item) => item.isCurrent)!] as const;
      });
      const body = {
        action: kind,
        expected_hash: await cloudSourceHash(row),
        expected_assessment_version: assessment.version,
        ...(kind === "delete" ? { confirmation: source! } : {}),
      };
      const result = await lifecycle.act(ctx, source!, body, key);
      return { body, result, key };
    }
    async function state() {
      return withProfileTransaction(db, ctx, async (tx) => ({
        revisions: await tx.select().from(c.claimRevisions),
        explorations: await tx.select().from(c.explorations),
        understanding: await getCurrentUnderstanding(tx as unknown as Db, ctx),
      }));
    }
    return {
      db,
      ctx,
      source: source!,
      replacement: replacement!,
      current: current!,
      historical: historical!,
      unrelated: unrelated!,
      exploration: exploration!,
      completed: completed!,
      lifecycle,
      action,
      state,
    };
  }
  describe("shared Core source invalidation through account lifecycle", () => {
    it("exclude invalidates current Core understanding, keeps text/history and is idempotent", async () => {
      const f = await fixture();
      const first = await f.action("exclude");
      const after = await f.state();
      expect(after.revisions.find((r) => r.id === f.current)).toMatchObject({
        status: "current",
        evidenceStatus: "invalid",
        text: "当前认识",
        scope: "当前范围",
      });
      expect(after.revisions.find((r) => r.id === f.current)?.invalidatedAt).not.toBeNull();
      expect(after.revisions.find((r) => r.id === f.historical)).toMatchObject({
        status: "superseded",
        evidenceStatus: "valid",
        text: "历史认识",
      });
      expect(after.revisions.find((r) => r.id === f.unrelated)?.evidenceStatus).toBe("valid");
      expect(after.understanding.claims.some((r) => r.claim_revision_id === f.current)).toBe(false);
      expect(after.understanding.needs_review.some((r) => r.claim_revision_id === f.current)).toBe(
        true,
      );
      expect(after.explorations.find((r) => r.id === f.exploration)?.version).toBe(4);
      expect(after.explorations.find((r) => r.id === f.completed)?.version).toBe(5);
      expect(await f.lifecycle.act(f.ctx, f.source, first.body, first.key)).toEqual(first.result);
      expect(await f.state()).toEqual(after);
    });
    it("retains a stale current revision when another active eligible support remains", async () => {
      const f = await fixture(true);
      await f.action("exclude");
      const after = await f.state();
      expect(after.revisions.find((r) => r.id === f.current)).toMatchObject({
        status: "current",
        evidenceStatus: "stale",
        text: "当前认识",
      });
      expect(after.understanding.claims.some((r) => r.claim_revision_id === f.current)).toBe(false);
    });
    it("rebind excludes the old source even if its old assessment still says eligible", async () => {
      const f = await fixture();
      const [source] = await withProfileTransaction(f.db, f.ctx, (tx) =>
        tx.select().from(c.sourceItems).where(eq(c.sourceItems.id, f.source)),
      );
      await f.lifecycle.rebind(
        f.ctx,
        f.source,
        { expected_hash: await cloudSourceHash(source!), replacement_source_id: f.replacement },
        randomUUID(),
      );
      expect((await f.state()).revisions.find((r) => r.id === f.current)).toMatchObject({
        status: "current",
        evidenceStatus: "invalid",
        text: "当前认识",
      });
    });
    it("restore does not silently reactivate an old claim or inherit its qualification", async () => {
      const f = await fixture();
      await f.action("exclude");
      await f.action("restore");
      const after = await f.state();
      expect(after.revisions.find((r) => r.id === f.current)?.evidenceStatus).toBe("invalid");
      expect(after.understanding.claims.some((r) => r.claim_revision_id === f.current)).toBe(false);
      const assessment = await withProfileTransaction(f.db, f.ctx, (tx) =>
        tx.select().from(c.sourceAssessments).where(eq(c.sourceAssessments.sourceItemId, f.source)),
      );
      expect(assessment.find((a) => a.isCurrent)?.eligibility).toBe("needs_review");
    });
    it("hard delete still withdraws and clears current and historical text, unlike exclusion", async () => {
      const f = await fixture();
      await f.action("delete");
      const after = await f.state();
      for (const id of [f.current, f.historical])
        expect(after.revisions.find((r) => r.id === id)).toMatchObject({
          status: "withdrawn",
          evidenceStatus: "invalid",
          text: "",
          scope: "",
          confidenceBasis: "",
          invalidationReason: "source_deleted",
        });
      expect(after.revisions.find((r) => r.id === f.unrelated)).toMatchObject({
        status: "current",
        evidenceStatus: "valid",
        text: "无关认识",
      });
      await expect(f.action("restore")).rejects.toThrow("已删除原文不可恢复");
    });
    it.each([false, true])(
      "native assessment and cloud exclude agree with additional support=%s",
      async (extra) => {
        const native = await fixture(extra);
        await withProfileTransaction(native.db, native.ctx, (tx) =>
          updateSourceAssessment(tx as unknown as Db, native.ctx, {
            source_id: native.source,
            expected_assessment_version: 1,
            assessment: {
              attribution_status: "confirmed_subject",
              context_completeness: "sufficient",
              temporal_precision: "exact",
              eligibility: "excluded",
              rationale: "本人排除",
            },
          }),
        );
        const cloud = await fixture(extra);
        await cloud.action("exclude");
        const select = (rows: Awaited<ReturnType<typeof native.state>>, id: string) => {
          const r = rows.revisions.find((row) => row.id === id)!;
          return {
            status: r.status,
            evidenceStatus: r.evidenceStatus,
            text: r.text,
            scope: r.scope,
          };
        };
        expect(select(await cloud.state(), cloud.current)).toEqual(
          select(await native.state(), native.current),
        );
      },
    );
    it("account Core HTTP assessment invalidates once, not again in the report wrapper", async () => {
      const f = await fixture();
      const key = randomUUID();
      const body = {
        expected_assessment_version: 1,
        assessment: {
          attribution_status: "confirmed_subject",
          context_completeness: "sufficient",
          temporal_precision: "exact",
          eligibility: "excluded",
          rationale: "合成 HTTP 排除",
        },
      };
      const first = await env.corePost(`/api/core/sources/${f.source}/assessment`, body, key);
      expect(first.status).toBe(200);
      const after = await f.state();
      expect(after.revisions.find((r) => r.id === f.current)?.evidenceStatus).toBe("invalid");
      expect(after.explorations.find((r) => r.id === f.exploration)?.version).toBe(4);
      const replay = await env.corePost(`/api/core/sources/${f.source}/assessment`, body, key);
      expect(replay.status).toBe(200);
      expect(await f.state()).toEqual(after);
    });
    it.each(["cloud", "native"] as const)(
      "%s source change waits before taking assessment locks, then revalidates after concurrent amendment",
      async (entry) => {
        const f = await fixture();
        let ready!: () => void;
        const locked = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const outcome = <T>(promise: Promise<T>) =>
          promise.then(
            (value) => ({ ok: true, value, error: null as any }),
            (error) => ({ ok: false, value: null, error }),
          );
        const amendment = outcome(
          withProfileTransaction(f.db, f.ctx, async (tx) => {
            await tx.execute(sql`select id from explorations where id=${f.exploration} for update`);
            const [pid] = await tx.execute(sql`select pg_backend_pid() as pid`);
            ready();
            let blocked = false;
            for (let i = 0; i < 150; i++) {
              const [row] = await tx.execute(sql`select exists (
              select 1 from pg_stat_activity a where ${Number(pid!.pid)} = any(pg_blocking_pids(a.pid))
            ) as waiting`);
              if (row!.waiting) {
                blocked = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(blocked, "the competing source change really waited on this exploration").toBe(
              true,
            );
            return amendExplorationSource(tx as unknown as Db, f.ctx, {
              exploration_id: f.exploration,
              expected_version: 3,
              target_source_id: f.source,
              type: "corrects",
              note: "合成更正：旧输入缺少当时的条件。",
            });
          }),
        );
        await locked;
        const exclusion = outcome(
          entry === "cloud"
            ? f.action("exclude")
            : withProfileTransaction(f.db, f.ctx, (tx) =>
                updateSourceAssessment(tx as unknown as Db, f.ctx, {
                  source_id: f.source,
                  expected_assessment_version: 1,
                  assessment: {
                    attribution_status: "confirmed_subject",
                    context_completeness: "sufficient",
                    temporal_precision: "exact",
                    eligibility: "excluded",
                    rationale: "并发排除",
                  },
                }),
              ),
        );
        const [changed, excluded] = await Promise.all([amendment, exclusion]);
        expect(changed.ok, String(changed.error?.cause?.code ?? changed.error)).toBe(true);
        expect(excluded.ok).toBe(false);
        expect(excluded.error).toMatchObject({ code: "SOURCE_VERSION_CONFLICT" });
        const after = await f.state();
        expect(after.explorations.find((r) => r.id === f.exploration)?.version).toBe(4);
        expect(after.revisions.find((r) => r.id === f.current)?.evidenceStatus).toBe("stale");
      },
    );
    it("rejects another Profile's source without altering either Profile", async () => {
      const f = await fixture();
      const before = await f.state();
      const [source] = await withProfileTransaction(f.db, f.ctx, (tx) =>
        tx.select().from(c.sourceItems).where(eq(c.sourceItems.id, f.source)),
      );
      await expect(
        f.lifecycle.act(
          await env.otherContext(),
          f.source,
          {
            action: "exclude",
            expected_hash: await cloudSourceHash(source!),
            expected_assessment_version: 1,
          },
          randomUUID(),
        ),
      ).rejects.toThrow("来源版本已变化");
      expect(await f.state()).toEqual(before);
    });
  });
}
