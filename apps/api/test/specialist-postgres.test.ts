import { randomUUID } from "node:crypto";
import { coreSchema as c, specialistSchema as s } from "@findme/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listPublishedContent } from "../src/content/catalog.js";
import { specialistRoutes } from "../src/routes/specialist.js";
import { type SpecialistEnvironment, specialistEnvironment } from "./helpers/specialist-fixture.js";

// Real RLS/runtime role, explicit FINDME_ACCOUNT_VERIFY_CONFIG only. No .env or model.
describe("specialist / isolated PostgreSQL / actual scoped HTTP services", () => {
  let env: SpecialistEnvironment;
  beforeAll(async () => {
    env = await specialistEnvironment();
  });
  afterAll(async () => {
    await env?.close();
  });
  async function fixture() {
    const f = await env.fixture();
    const app = specialistRoutes(env.runtime.db, async () => f.ctx);
    async function request(path: string, body?: unknown, method = "POST", key?: string) {
      return app.request(path, {
        method,
        headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    async function json(path: string, body?: unknown, method = "POST", status = 200, key?: string) {
      const r = await request(path, body, method, key);
      const value = await r.json();
      expect(r.status, JSON.stringify(value)).toBe(status);
      return value;
    }
    const { session } = await json(
      "/adhd/sessions",
      {
        voluntary: true,
        goal: "完成合成任务",
        setting: "合成工作台",
        difficulty: "合成噪声",
        difficulty_categories: ["noise"],
      },
      "POST",
      201,
      randomUUID(),
    );
    const version = listPublishedContent().find((v) =>
      v.claims.some((c) => c.applicability_keys.includes("noise")),
    )!;
    const claim = version.claims.find((c) => c.applicability_keys.includes("noise"))!;
    const proposalBody = {
      content_id: version.content_id,
      content_version: version.version,
      claim_id: claim.id,
      adjustment_kind: "environment",
      action_text: claim.candidate_options[0],
      applicability_confirmed: ["noise"],
      scope_reviewed: true,
    };
    async function propose() {
      return (
        await json(
          `/adhd/sessions/${session.id}/proposals`,
          proposalBody,
          "POST",
          201,
          randomUUID(),
        )
      ).proposal;
    }
    async function trial() {
      const proposal = await propose();
      const confirmed = await json(
        `/proposals/${proposal.id}/confirm`,
        { expected_version: 1 },
        "POST",
        201,
      );
      return { proposal, trial: confirmed.trial };
    }
    return { ...f, request, json, session, propose, trial, proposalBody };
  }
  it("updates context once, detects stale writes and freezes the changed personal basis in new proposals", async () => {
    const f = await fixture();
    const before = await f.propose();
    const patch = { expected_version: 1, setting: "新的合成场景" };
    const updated = await f.json(`/adhd/sessions/${f.session.id}`, patch, "PATCH");
    expect(updated.session.version).toBe(2);
    expect((await f.json(`/adhd/sessions/${f.session.id}`, patch, "PATCH")).replayed).toBe(true);
    await f.json(`/adhd/sessions/${f.session.id}`, { ...patch, setting: "冲突场景" }, "PATCH", 409);
    const after = await f.propose();
    expect(before.personalBasis.setting).toBe("合成工作台");
    expect(after.personalBasis.setting).toBe("新的合成场景");
    await f.json(
      `/adhd/sessions/${f.session.id}`,
      { expected_version: 2, scope_flags: ["safety_constraint"] },
      "PATCH",
    );
    await f.json(
      `/adhd/sessions/${f.session.id}/proposals`,
      f.proposalBody,
      "POST",
      422,
      randomUUID(),
    );
  });
  it("creates a trial only by explicit confirmation and replays confirmation without duplication", async () => {
    const f = await fixture();
    const proposal = await f.propose();
    expect((await f.json(`/adhd/sessions/${f.session.id}`, undefined, "GET")).trials).toHaveLength(
      0,
    );
    const confirmed = await f.json(
      `/proposals/${proposal.id}/confirm`,
      { expected_version: 1, modified_action_text: "本人调整后的合成尝试" },
      "POST",
      201,
    );
    expect(confirmed.proposal.evidenceMode).toBe("exploratory");
    expect(confirmed.trial.acceptedAction).toBe("本人调整后的合成尝试");
    expect(
      (await f.json(`/proposals/${proposal.id}/confirm`, { expected_version: 1 })).replayed,
    ).toBe(true);
    expect((await f.json(`/adhd/sessions/${f.session.id}`, undefined, "GET")).trials).toHaveLength(
      1,
    );
  });
  it("records a personal source, invalidates the linked current claim once, and replays without duplicate records", async () => {
    const f = await fixture();
    const { trial } = await f.trial();
    const body = {
      expected_version: 1,
      execution: "completed",
      outcome: "helpful",
      observation: "合成观察",
      related_claim_revision_id: f.revision,
      continue_trial: false,
    };
    const result = await f.json(`/trials/${trial.id}/review`, body);
    expect(result.source).toMatchObject({
      sourceKind: "action_trial_review",
      authorKind: "subject",
    });
    expect((await f.json(`/trials/${trial.id}/review`, body)).replayed).toBe(true);
    await f.json(`/trials/${trial.id}/review`, { ...body, expected_version: 2 }, "POST", 409);
    await f.json(`/trials/${trial.id}/review`, { ...body, observation: "changed" }, "POST", 409);
    await env.within(f.ctx, async (tx) => {
      const [revision] = await tx
        .select()
        .from(c.claimRevisions)
        .where(eq(c.claimRevisions.id, f.revision));
      expect(revision.evidenceStatus).toBe("stale");
      expect(revision.invalidationReason).toBe("action_trial_outcome_needs_review");
      expect(
        await tx.select().from(c.feedbackEvents).where(eq(c.feedbackEvents.targetId, f.revision)),
      ).toHaveLength(1);
      const reviews = (await tx.select().from(c.sourceItems)).filter(
        (r) => r.sourceKind === "action_trial_review",
      );
      expect(reviews).toHaveLength(1);
      expect(
        await tx
          .select()
          .from(c.sourceAssessments)
          .where(eq(c.sourceAssessments.sourceItemId, reviews[0].id)),
      ).toHaveLength(1);
      expect(
        await tx
          .select()
          .from(c.evidenceSpans)
          .where(eq(c.evidenceSpans.sourceItemId, reviews[0].id)),
      ).toHaveLength(1);
    });
    expect((await f.json(`/trials/${trial.id}`, undefined, "GET")).review_sources).toHaveLength(1);
  });
  it("invalidates a linked current claim only once across distinct executed reviews", async () => {
    const f = await fixture();
    const { trial } = await f.trial();
    const body = {
      expected_version: 1,
      execution: "completed",
      outcome: "helpful",
      related_claim_revision_id: f.revision,
      continue_trial: true,
    };
    await f.json(`/trials/${trial.id}/review`, body);
    const read = () =>
      env.within(
        f.ctx,
        async (tx) =>
          (await tx.select().from(c.claimRevisions).where(eq(c.claimRevisions.id, f.revision)))[0],
      );
    const first = await read();
    await f.json(`/trials/${trial.id}/review`, {
      ...body,
      expected_version: 2,
      execution: "partly_executed",
      outcome: "mixed",
      continue_trial: false,
    });
    const second = await read();
    expect(second.invalidatedAt).toEqual(first.invalidatedAt);
    expect(second.evidenceStatus).toBe("stale");
    expect((await f.json(`/trials/${trial.id}`, undefined, "GET")).review_sources).toHaveLength(2);
  });
  it("pause and non-execution remain normal choices and do not invalidate a claim", async () => {
    const f = await fixture();
    const { trial } = await f.trial();
    const paused = await f.json(`/trials/${trial.id}/pause`, { expected_version: 1 });
    expect(paused.trial).toMatchObject({
      status: "paused",
      latestExecution: null,
      latestOutcome: null,
    });
    const review = await f.json(`/trials/${trial.id}/review`, {
      expected_version: 2,
      execution: "not_executed",
      outcome: "unknown",
      related_claim_revision_id: f.revision,
      continue_trial: false,
    });
    expect(review.source.content).toContain("未执行");
    expect(review.source.content).toContain("作用未知");
    await env.within(f.ctx, async (tx) => {
      const [revision] = await tx
        .select()
        .from(c.claimRevisions)
        .where(eq(c.claimRevisions.id, f.revision));
      expect(revision.evidenceStatus).toBe("valid");
      expect(revision.invalidatedAt).toBeNull();
    });
    await f.json(`/adhd/sessions/${f.session.id}/pause`, { expected_version: 1 });
    expect(
      (await f.json(`/adhd/content-candidates?session_id=${f.session.id}`, undefined, "GET")).items,
    ).toEqual([]);
    await f.json(`/adhd/sessions/${f.session.id}/resume`, { expected_version: 2 });
  });
  it("rejects foreign session, proposal, trial and linked claim IDs under real RLS", async () => {
    const owner = await fixture();
    const other = await fixture();
    const { proposal, trial } = await owner.trial();
    for (const path of [
      `/adhd/sessions/${owner.session.id}`,
      `/trials/${trial.id}`,
      `/adhd/sessions/${owner.session.id}/proposals`,
    ])
      await other.json(path, undefined, "GET", 404);
    await other.json(
      `/adhd/sessions/${owner.session.id}`,
      { expected_version: 1, goal: "foreign" },
      "PATCH",
      404,
    );
    await other.json(`/proposals/${proposal.id}/confirm`, { expected_version: 1 }, "POST", 404);
    await other.json(`/trials/${trial.id}/pause`, { expected_version: 1 }, "POST", 404);
    const own = await other.trial();
    await other.json(
      `/trials/${own.trial.id}/review`,
      {
        expected_version: 1,
        execution: "completed",
        outcome: "helpful",
        continue_trial: false,
        related_claim_revision_id: owner.revision,
      },
      "POST",
      404,
    );
    await env.within(other.ctx, async (tx) => {
      expect(
        await tx.select().from(s.specialistTrials).where(eq(s.specialistTrials.id, trial.id)),
      ).toEqual([]);
    });
  });
});
