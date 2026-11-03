import { coreSchema, createDb } from "@findme/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { invalidateCloudSources } from "../src/cloud-diagnostic/effects.js";
import { continueExplorationWith } from "../src/core/exploration-planning.js";
import { correctUnderstandingWith } from "../src/core/exploration-revision.js";
import { directCoreStore } from "../src/core/exploration-types.js";
import { resolvePersonalContext } from "../src/core/identity.js";
import { beginCoreOperation } from "../src/core/operations.js";
import { PRIOR_SELECTION_VERSION } from "../src/core/prior-understanding.js";
import { coreTestApp } from "./helper.js";

// Synthetic P1 main-chain scenario: an understanding formed in one experience is
// offered to the next, narrowed by new input, used in its narrowed form later,
// left unchanged by an unrelated input and never reused once withdrawn.
const testUrl = process.env.DATABASE_URL_TEST;
const dbDescribe = testUrl ? describe : describe.skip;

type Call = { system: string; text: string };

function priorClaims(text: string): Array<{ key: string; text: string; scope: string }> {
  const marker = text.indexOf("PRIOR_UNDERSTANDING (");
  if (marker < 0) return [];
  const line = text.slice(marker).split("\n")[1] ?? "[]";
  return JSON.parse(line);
}

function evidence(key = "E1", relation = "supports") {
  return {
    evidence_key: key,
    relation,
    directness: "direct",
    contribution: "high",
    scope_match: "同一事件",
    rationale: "合成场景中用户直接描述的经历。",
  };
}

function claim(key: string, text: string, scope: string) {
  return {
    key,
    kind: "pattern",
    mode: "observation",
    text,
    scope,
    confidence_level: "medium",
    confidence_basis: "来自一次合成经历，仍需其他情境验证。",
    evidence: [evidence()],
  };
}

const gap = {
  key: "gap_other",
  question: "其他情境下是否也会这样？",
  why_it_matters: "会改变适用范围。",
};

function scenarioGateway(calls: Call[], hooks: { onExtract?: () => Promise<void> } = {}) {
  return {
    extract: async (input: { system?: string; text?: string }) => {
      const system = input.system ?? "";
      const text = input.text ?? "";
      calls.push({ system, text });
      await hooks.onExtract?.();
      if (
        system.includes("目标不是延长对话") &&
        text.includes("ASK_WITH_PRIOR") &&
        text.includes('"asked":0')
      )
        return {
          current_reading: "这次可能与已有认识有关。",
          key_uncertainty: "已有认识是否适用？",
          decision: "ask",
          question: "之前提到“在会议讨论中，你倾向先听完别人再发言。”，这次也是这样吗？",
          intent: "不同答案会改变已有认识的适用范围。",
          quick_options: [],
          stop_reason: null,
        };
      if (system.includes("目标不是延长对话"))
        return {
          current_reading: "这次经历已经可以形成有限认识。",
          key_uncertainty: "其他情境留给后续经历验证。",
          decision: "stop",
          question: null,
          intent: "继续追问只会增加细节。",
          quick_options: [],
          stop_reason: "当前材料足以形成有限认识。",
        };
      if (system.includes("认识修订器") && text.includes("KEEP_FOREIGN")) {
        const foreign = text.match(/\[(E\d+)\][^\n]*\nSCENE_NARROW/)?.[1] ?? "missing";
        return {
          claims: [
            {
              ...claim("wait_first", "在会议讨论中，你倾向先听完别人再发言。", "仅限正式评审会。"),
              evidence: [evidence("E1"), evidence(foreign, "contextualizes")],
            },
          ],
          gaps: [],
          next_question: null,
          change_summary: "保留收窄。",
          revision_reason: "用户确认收窄后的范围。",
          withdrawn_claim_keys: [],
        };
      }
      if (system.includes("认识修订器"))
        return {
          claims: [],
          gaps: [],
          next_question: null,
          change_summary: "撤回原理解。",
          revision_reason: "用户说明这不是事实。",
          withdrawn_claim_keys: ["wait_first"],
        };
      const meeting = priorClaims(text).find((item) => item.text.includes("先听完"));
      if (text.includes("SCENE_A") && text.includes("SCENE_NARROW")) {
        // Continuing A after B attached its evidence to A's claim.
        const foreign = text.match(/\[(E\d+)\][^\n]*\nSCENE_NARROW/)?.[1] ?? "missing";
        return {
          claims: [
            {
              ...claim(
                "wait_first",
                "在会议讨论中，你倾向先听完别人再发言。",
                "仅限有上级在场的正式评审会。",
              ),
              evidence: [evidence("E1"), evidence(foreign, "contextualizes")],
            },
          ],
          gaps: [],
          next_question: null,
        };
      }
      if (text.includes("SCENE_A"))
        return {
          claims: [claim("wait_first", "在会议讨论中，你倾向先听完别人再发言。", "会议讨论情境。")],
          gaps: [gap],
          next_question: null,
        };
      if (text.includes("SCENE_NARROW"))
        return {
          claims: [
            claim("direct_with_peers", "在熟人小组讨论里，你会直接先说想法。", "熟人小组讨论。"),
          ],
          gaps: [],
          next_question: null,
          prior_updates: meeting
            ? [
                {
                  prior_key: meeting.key,
                  effect: "narrows",
                  revised_text: null,
                  revised_scope: "仅限有上级在场的正式评审会。",
                  rationale: "用户说明熟人讨论中会直接表达，先听完只出现在正式评审会。",
                  evidence: [evidence("E1", "contextualizes")],
                },
              ]
            : [],
        };
      if (text.includes("SCENE_UNRELATED"))
        return {
          claims: [claim("cook_plan", "这次做饭前你先列了清单。", "这次周末做饭。")],
          gaps: [],
          next_question: null,
          prior_updates: meeting
            ? [
                {
                  prior_key: meeting.key,
                  effect: "unchanged",
                  revised_text: null,
                  revised_scope: null,
                  rationale: "做饭经历与会议表达无关，不改变原认识。",
                  evidence: [],
                },
              ]
            : [],
        };
      if (text.includes("SCENE_PRIOR_ONLY"))
        return {
          claims: [],
          gaps: [],
          next_question: null,
          prior_updates: meeting
            ? [
                {
                  prior_key: meeting.key,
                  effect: "narrows",
                  revised_text: null,
                  revised_scope: "仅限正式评审会。",
                  rationale: "只收窄原认识，本次不形成新认识。",
                  evidence: [evidence("E1", "contextualizes")],
                },
              ]
            : [],
        };
      if (text.includes("SCENE_SUPPORT"))
        return {
          claims: [],
          gaps: [gap],
          next_question: null,
          prior_updates: meeting
            ? [
                {
                  prior_key: meeting.key,
                  effect: "supports",
                  revised_text: null,
                  revised_scope: null,
                  rationale: "又一次独立经历。",
                  evidence: [evidence()],
                },
              ]
            : [],
        };
      if (text.includes("SCENE_INVALID"))
        return {
          claims: [claim("other", "这次你推迟了发言。", "这次评审。")],
          gaps: [],
          next_question: null,
          prior_updates: meeting
            ? [
                {
                  prior_key: meeting.key,
                  effect: "narrows",
                  revised_text: null,
                  revised_scope: null,
                  rationale: "缺少新的适用范围。",
                  evidence: [evidence()],
                },
              ]
            : [],
        };
      return {
        claims: [claim("followup", "这次评审会上你先听完再发言。", "这次正式评审会。")],
        gaps: [],
        next_question: null,
      };
    },
    chat: async () => ({ text: "" }),
    describe: (route: string) => ({ route, model: "test-observation-model" }),
  } as unknown as NonNullable<Parameters<typeof coreTestApp>[0]["gateway"]>;
}

dbDescribe("P1 main chain: prior understanding in the next exploration", () => {
  const { db, sql } = createDb(testUrl ?? "");
  const calls: Call[] = [];
  const app = coreTestApp({
    db,
    gateway: scenarioGateway(calls),
    auth: { mode: "static", accessToken: "secret" },
  });
  const headers = { Authorization: "Bearer secret", "content-type": "application/json" };

  beforeEach(async () => {
    calls.length = 0;
    await sql.unsafe("TRUNCATE TABLE tenants RESTART IDENTITY CASCADE");
  });
  afterAll(async () => {
    await sql.end();
  });

  async function post(path: string, key: string, body: unknown, status = 201) {
    const response = await app.request(path, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(status);
    return value;
  }

  async function explore(key: string, event: string) {
    const started = await post("/api/core/explorations", `${key}-start`, { event });
    const done = await post(
      `/api/core/explorations/${started.exploration.id}/continue`,
      `${key}-continue`,
      { expected_version: started.exploration.version },
    );
    return { started, done };
  }

  async function revisionsOf(claimId: string) {
    return db
      .select()
      .from(coreSchema.claimRevisions)
      .where(eq(coreSchema.claimRevisions.claimId, claimId))
      .orderBy(coreSchema.claimRevisions.version);
  }

  it("zero history keeps the original synthesis contract and records an empty selection", async () => {
    const { done } = await explore("zero", "SCENE_A 评审会上我等别人说完才发言。");
    expect(done.processing.result).toBe("added");
    expect(done.processing.prior_effects).toEqual([]);
    expect(done.prior_understanding).toMatchObject({
      selection_version: PRIOR_SELECTION_VERSION,
      used: [],
      excluded: [],
    });
    expect(calls.some((call) => call.text.includes("PRIOR_UNDERSTANDING"))).toBe(false);
    expect(calls.every((call) => !call.system.includes("prior_updates"))).toBe(true);
  });

  it("narrows a prior understanding with new input and uses the narrowed version next time", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const prior = first.done.claims[0];
    expect(prior.scope).toBe("会议讨论情境。");

    calls.length = 0;
    const second = await explore(
      "narrow",
      "SCENE_NARROW 其实和熟人小组讨论时我会直接先说想法，只有上级在场的评审会我才先听完。",
    );
    // The planner and synthesis both received the prior claim as labelled context.
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.text).toContain("PRIOR_UNDERSTANDING");
      expect(call.text).toContain("在会议讨论中，你倾向先听完别人再发言。");
    }
    expect(calls[1]?.system).toContain("prior_updates");
    expect(second.done.prior_understanding.used).toEqual([
      expect.objectContaining({
        key: "P1",
        claim_id: prior.claim_id,
        claim_revision_id: prior.claim_revision_id,
        version: 1,
      }),
    ]);
    expect(second.done.processing.result).toBe("revised");
    const [effect] = second.done.processing.prior_effects;
    expect(effect).toMatchObject({
      claim_id: prior.claim_id,
      from_revision_id: prior.claim_revision_id,
      effect: "narrows",
      scope: "仅限有上级在场的正式评审会。",
    });
    expect(effect.to_revision_id).toBeTruthy();

    // A new ClaimRevision of the prior claim keeps old evidence and adds the new
    // experience as its own independence group.
    const revisions = await revisionsOf(prior.claim_id);
    expect(revisions.map((row) => [row.version, row.status])).toEqual([
      [1, "superseded"],
      [2, "current"],
    ]);
    expect(revisions[1]?.id).toBe(effect.to_revision_id);
    expect(revisions[1]?.supersedesRevisionId).toBe(prior.claim_revision_id);
    expect(revisions[1]?.revisionReason).toContain("收窄");
    const uses = await db
      .select()
      .from(coreSchema.claimEvidence)
      .where(eq(coreSchema.claimEvidence.claimRevisionId, effect.to_revision_id));
    expect(new Set(uses.map((use) => use.independenceGroup))).toEqual(
      new Set([
        `experience:${first.started.experience.id}`,
        `experience:${second.started.experience.id}`,
      ]),
    );
    expect(uses.find((use) => use.relation === "contextualizes")).toBeDefined();

    // Readable views show the narrowed version, not the original scope.
    const current = await (await app.request("/api/core/understanding", { headers })).json();
    const shown = current.claims.find(
      (item: { claim_id: string }) => item.claim_id === prior.claim_id,
    );
    expect(shown).toMatchObject({ version: 2, scope: "仅限有上级在场的正式评审会。" });
    const firstView = await (
      await app.request(`/api/core/explorations/${first.started.exploration.id}`, { headers })
    ).json();
    expect(JSON.stringify(firstView)).toContain("仅限有上级在场的正式评审会。");

    // The next related exploration is planned and synthesized with version 2 only.
    calls.length = 0;
    const third = await explore(
      "followup",
      "这周的正式评审会上，上级在场，我还是先听完了别人发言。",
    );
    const used = third.done.prior_understanding.used.map(
      (item: { claim_revision_id: string }) => item.claim_revision_id,
    );
    expect(used).toContain(effect.to_revision_id);
    expect(used).not.toContain(prior.claim_revision_id);
    for (const call of calls) {
      expect(call.text).toContain("仅限有上级在场的正式评审会。");
      expect(call.text).not.toContain('"scope":"会议讨论情境。"');
    }
    const step = await db
      .select()
      .from(coreSchema.explorationSteps)
      .where(eq(coreSchema.explorationSteps.explorationId, third.started.exploration.id));
    expect(step[0]?.modelMeta).toMatchObject({
      synthesis_prompt_version: "understanding-prior-prompt@v1",
      prior_validator_version: "prior-update-validator@v1",
      prior_understanding: {
        used: expect.arrayContaining([
          expect.objectContaining({ claim_revision_id: effect.to_revision_id }),
        ]),
      },
      processing: { result: "added" },
    });
  });

  it("keeps the prior understanding unchanged when new input does not bear on it", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const prior = first.done.claims[0];
    const other = await explore("cook", "SCENE_UNRELATED 周末做饭前我先列了一张清单。");
    expect(other.done.processing.result).toBe("added");
    expect(other.done.processing.prior_effects).toEqual([
      expect.objectContaining({
        claim_id: prior.claim_id,
        from_revision_id: prior.claim_revision_id,
        to_revision_id: null,
        effect: "unchanged",
      }),
    ]);
    expect((await revisionsOf(prior.claim_id)).map((row) => row.status)).toEqual(["current"]);
  });

  it("rejects an invalid prior update without writing anything", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const prior = first.done.claims[0];
    const started = await post("/api/core/explorations", "invalid-start", {
      event: "SCENE_INVALID 这次评审我推迟了发言。",
    });
    const response = await app.request(
      `/api/core/explorations/${started.exploration.id}/continue`,
      {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": "invalid-continue" },
        body: JSON.stringify({ expected_version: started.exploration.version }),
      },
    );
    expect(response.status).toBeGreaterThanOrEqual(500);
    const synthesis = calls.filter((call) => call.system.includes("prior_updates"));
    expect(synthesis).toHaveLength(2);
    expect(synthesis[1]?.text).toContain("prior_narrow_without_scope:P1");
    expect((await revisionsOf(prior.claim_id)).map((row) => row.status)).toEqual(["current"]);
    const [exploration] = await db
      .select()
      .from(coreSchema.explorations)
      .where(eq(coreSchema.explorations.id, started.exploration.id));
    expect(exploration?.version).toBe(started.exploration.version);
    // The saved input survives the failed processing and can be retried.
    expect(
      (await db.select().from(coreSchema.sourceItems)).some((row) =>
        row.content.includes("SCENE_INVALID"),
      ),
    ).toBe(true);
  });

  it("does not offer a withdrawn understanding as a premise again", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const prior = first.done.claims[0];
    const corrected = await post(
      `/api/core/explorations/${first.started.exploration.id}/correct`,
      "withdraw",
      {
        expected_version: first.done.version,
        claim_revision_ids: [prior.claim_revision_id],
        correction: { type: "wrong_fact", note: "这不对，我在会议上通常第一个发言。" },
      },
    );
    expect(corrected.outcome).toBe("withdrawn");

    calls.length = 0;
    const next = await explore("after-withdraw", "今天的评审会上我先听完了别人发言。");
    expect(next.done.prior_understanding.used).toEqual([]);
    expect(next.done.prior_understanding.excluded).toEqual([
      expect.objectContaining({ claim_id: prior.claim_id, reason: "withdrawn" }),
    ]);
    for (const call of calls) {
      const usable = priorClaims(call.text);
      expect(usable.some((item) => item.text.includes("先听完"))).toBe(false);
      expect(call.text).toContain("DO_NOT_USE_AS_PREMISE");
    }
  });

  it("skips an effect whose prior revision changed after it was read", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const prior = first.done.claims[0];
    const started = await post("/api/core/explorations", "race-start", {
      event: "SCENE_NARROW 熟人讨论我会直接说，上级在场才先听完。",
    });
    const ctx = await resolvePersonalContext(db, {
      provider: "findme-runtime",
      principalId: "owner",
    });
    const base = directCoreStore(db);
    // Simulate a concurrent correction committing between the read and the write.
    const racing = {
      read: base.read,
      write: async <T>(work: (handle: typeof db) => Promise<T>) => {
        await db
          .update(coreSchema.claimRevisions)
          .set({ status: "withdrawn" })
          .where(eq(coreSchema.claimRevisions.id, prior.claim_revision_id));
        return base.write(work);
      },
    };
    const done = await continueExplorationWith(racing, scenarioGateway([]), ctx, {
      exploration_id: started.exploration.id,
      expected_version: started.exploration.version,
    });
    const processing = done.processing as {
      result: string;
      prior_effects: Array<{ effect: string }>;
    };
    expect(processing.prior_effects.map((item) => item.effect)).toEqual(["skipped_stale"]);
    expect(processing.result).toBe("added");
    const current = await db
      .select()
      .from(coreSchema.claimRevisions)
      .where(
        and(
          eq(coreSchema.claimRevisions.claimId, prior.claim_id),
          eq(coreSchema.claimRevisions.status, "current"),
        ),
      );
    expect(current).toEqual([]);
  });

  it("keeps a prior-only result readable as completed instead of ready to plan", async () => {
    await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const only = await explore("only", "SCENE_PRIOR_ONLY 只有正式评审会我才这样。");
    expect(only.done.claims).toEqual([]);
    expect(only.done.processing.result).toBe("revised");
    expect(only.done.phase).toBe("review");
    const view = await (
      await app.request(`/api/core/explorations/${only.started.exploration.id}`, { headers })
    ).json();
    expect(view.phase).toBe("review");
    const list = await (
      await app.request("/api/core/explorations?status=active", { headers })
    ).json();
    expect(
      list.items.find((item: { id: string }) => item.id === only.started.exploration.id).phase,
    ).toBe("review");
  });

  it("redacts other explorations' copies when a used claim's source is deleted", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const second = await explore("cook", "SCENE_UNRELATED 周末做饭前我先列了一张清单。");
    const priorText = "在会议讨论中，你倾向先听完别人再发言。";
    const before = await db
      .select()
      .from(coreSchema.explorationSteps)
      .where(eq(coreSchema.explorationSteps.explorationId, second.started.exploration.id));
    expect(JSON.stringify(before)).toContain(priorText);
    const [source] = (await db.select().from(coreSchema.sourceItems)).filter((row) =>
      row.content.includes("SCENE_A"),
    );
    const ctx = await resolvePersonalContext(db, {
      provider: "findme-runtime",
      principalId: "owner",
    });
    await db.transaction((tx) => invalidateCloudSources(tx, ctx, [source!.id], true));
    const after = await db
      .select()
      .from(coreSchema.explorationSteps)
      .where(eq(coreSchema.explorationSteps.explorationId, second.started.exploration.id));
    expect(JSON.stringify(after)).not.toContain(priorText);
    expect(after.every((step) => (step.modelMeta as { redacted?: boolean }).redacted)).toBe(true);
    const view = await (
      await app.request(`/api/core/explorations/${second.started.exploration.id}`, { headers })
    ).json();
    expect(JSON.stringify(view)).not.toContain(priorText);
    // The deleted claim no longer appears anywhere as prior context.
    calls.length = 0;
    await explore("after-delete", "又一次评审会我先听完了。");
    expect(calls.every((call) => !call.text.includes(priorText))).toBe(true);
    expect(first.done.claims).toHaveLength(1);
  });

  it("clears assistant question turns that repeated a deleted prior claim", async () => {
    await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const started = await post("/api/core/explorations", "ask-start", {
      event: "ASK_WITH_PRIOR 今天评审会我又先听完了。",
    });
    const asked = await post(
      `/api/core/explorations/${started.exploration.id}/continue`,
      "ask-continue",
      { expected_version: started.exploration.version },
    );
    expect(asked.phase).toBe("awaiting_answer");
    const priorText = "在会议讨论中，你倾向先听完别人再发言。";
    const turnsOf = () =>
      db
        .select()
        .from(coreSchema.explorationTurns)
        .where(eq(coreSchema.explorationTurns.explorationId, started.exploration.id));
    expect(JSON.stringify(await turnsOf())).toContain(priorText);
    const [source] = (await db.select().from(coreSchema.sourceItems)).filter((row) =>
      row.content.includes("SCENE_A"),
    );
    const ctx = await resolvePersonalContext(db, {
      provider: "findme-runtime",
      principalId: "owner",
    });
    await db.transaction((tx) => invalidateCloudSources(tx, ctx, [source!.id], true));
    expect(JSON.stringify(await turnsOf())).not.toContain(priorText);
    const view = await (
      await app.request(`/api/core/explorations/${started.exploration.id}`, { headers })
    ).json();
    expect(JSON.stringify(view)).not.toContain(priorText);
  });

  it("never sends a withdrawn claim's text after its source is deleted", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const prior = first.done.claims[0];
    await post(`/api/core/explorations/${first.started.exploration.id}/correct`, "withdraw-del", {
      expected_version: first.done.version,
      claim_revision_ids: [prior.claim_revision_id],
      correction: { type: "wrong_fact", note: "这不对。" },
    });
    const [source] = (await db.select().from(coreSchema.sourceItems)).filter((row) =>
      row.content.includes("SCENE_A"),
    );
    const ctx = await resolvePersonalContext(db, {
      provider: "findme-runtime",
      principalId: "owner",
    });
    await db.transaction((tx) => invalidateCloudSources(tx, ctx, [source!.id], true));
    const remaining = await revisionsOf(prior.claim_id);
    expect(remaining.every((row) => row.text === "")).toBe(true);
    calls.length = 0;
    const next = await explore("after-withdraw-delete", "今天评审会我先听完了。");
    expect(next.done.prior_understanding.excluded).toEqual([]);
    expect(calls.every((call) => !call.text.includes("先听完别人再发言"))).toBe(true);
  });

  it("rejects model output when a prior source is deleted while the model runs", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    expect(first.done.claims).toHaveLength(1);
    const started = await post("/api/core/explorations", "race-del-start", {
      event: "SCENE_NARROW 熟人讨论我会直接说，上级在场才先听完。",
    });
    const ctx = await resolvePersonalContext(db, {
      provider: "findme-runtime",
      principalId: "owner",
    });
    const [source] = (await db.select().from(coreSchema.sourceItems)).filter((row) =>
      row.content.includes("SCENE_A"),
    );
    const base = directCoreStore(db);
    const racing = {
      read: base.read,
      write: async <T>(work: (handle: typeof db) => Promise<T>) => {
        await db.transaction((tx) => invalidateCloudSources(tx, ctx, [source!.id], true));
        return base.write(work);
      },
    };
    await expect(
      continueExplorationWith(racing, scenarioGateway([]), ctx, {
        exploration_id: started.exploration.id,
        expected_version: started.exploration.version,
      }),
    ).rejects.toMatchObject({ code: "STALE_EXPLORATION_CONTEXT" });
    const steps = await db
      .select()
      .from(coreSchema.explorationSteps)
      .where(eq(coreSchema.explorationSteps.explorationId, started.exploration.id));
    expect(steps).toEqual([]);
  });

  it("serialises two concurrent commits revising the same prior claim without deadlock", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const ctx = await resolvePersonalContext(db, {
      provider: "findme-runtime",
      principalId: "owner",
    });
    const left = await post("/api/core/explorations", "dl-left", {
      event: "SCENE_SUPPORT 评审会我先听完了。",
    });
    const right = await post("/api/core/explorations", "dl-right", {
      event: "SCENE_SUPPORT 另一场评审会我也先听完了。",
    });
    const base = directCoreStore(db);
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // Both commits start only after both model results are ready.
    const together = {
      read: base.read,
      write: async <T>(work: (handle: typeof db) => Promise<T>) => {
        if (++arrived === 2) open();
        await gate;
        return base.write(work);
      },
    };
    const results = await Promise.allSettled(
      [left, right].map((started) =>
        continueExplorationWith(together, scenarioGateway([]), ctx, {
          exploration_id: started.exploration.id,
          expected_version: started.exploration.version,
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const effects = results
      .map((r) =>
        r.status === "fulfilled"
          ? (r.value.processing as { prior_effects: Array<{ effect: string }> })
          : null,
      )
      .flatMap((p) => p?.prior_effects.map((e) => e.effect) ?? [])
      .sort();
    expect(effects).toEqual(["skipped_stale", "supports"]);
    expect((await revisionsOf(first.done.claims[0].claim_id)).map((r) => r.status)).toEqual([
      "superseded",
      "current",
    ]);
  });

  it("marks a cross-exploration revision stale when the input behind it is amended", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const prior = first.done.claims[0];
    const second = await explore("narrow", "SCENE_NARROW 熟人讨论我会直接说，上级在场才先听完。");
    const narrowed = second.done.processing.prior_effects[0].to_revision_id;
    const [source] = (await db.select().from(coreSchema.sourceItems)).filter((row) =>
      row.content.includes("SCENE_NARROW"),
    );
    await post(`/api/core/explorations/${second.started.exploration.id}/amend`, "amend-b", {
      expected_version: second.done.version,
      target_source_id: source!.id,
      type: "corrects",
      note: "我说错了，熟人讨论里我其实也会先听完。",
    });
    const [revision] = await db
      .select()
      .from(coreSchema.claimRevisions)
      .where(eq(coreSchema.claimRevisions.id, narrowed));
    expect(revision?.evidenceStatus).toBe("stale");
    const next = await explore("after-amend", "今天评审会我先听完了。");
    expect(
      next.done.prior_understanding.used.map((u: { claim_id: string }) => u.claim_id),
    ).not.toContain(prior.claim_id);
  });

  it("lets a correction keep evidence another experience added to the claim", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const prior = first.done.claims[0];
    const second = await explore("narrow", "SCENE_NARROW 熟人讨论我会直接说，上级在场才先听完。");
    const narrowed = second.done.processing.prior_effects[0].to_revision_id;
    const view = await (
      await app.request(`/api/core/explorations/${first.started.exploration.id}`, { headers })
    ).json();
    const corrected = await post(
      `/api/core/explorations/${first.started.exploration.id}/correct`,
      "keep-foreign",
      {
        expected_version: view.version,
        claim_revision_ids: [narrowed],
        correction: { type: "missing_context", note: "KEEP_FOREIGN 收窄是对的。" },
      },
    );
    const kept = corrected.claims[0];
    expect(kept.claim_id).toBe(prior.claim_id);
    const uses = await db
      .select()
      .from(coreSchema.claimEvidence)
      .where(eq(coreSchema.claimEvidence.claimRevisionId, kept.claim_revision_id));
    expect(uses.map((u) => u.independenceGroup)).toContain(
      `experience:${second.started.experience.id}`,
    );
  });

  it("clears gaps synthesized with a deleted prior claim as context", async () => {
    await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const second = await explore("support", "SCENE_SUPPORT 评审会我又先听完了。");
    const gapsOf = () =>
      db
        .select()
        .from(coreSchema.knowledgeGaps)
        .where(eq(coreSchema.knowledgeGaps.explorationId, second.started.exploration.id));
    expect((await gapsOf()).some((g) => g.question !== "")).toBe(true);
    const [source] = (await db.select().from(coreSchema.sourceItems)).filter((row) =>
      row.content.includes("SCENE_A"),
    );
    const ctx = await resolvePersonalContext(db, {
      provider: "findme-runtime",
      principalId: "owner",
    });
    await db.transaction((tx) => invalidateCloudSources(tx, ctx, [source!.id], true));
    expect((await gapsOf()).every((g) => g.question === "" && g.whyItMatters === "")).toBe(true);
  });

  it("stops treating a prior-only result as completed once its input is amended", async () => {
    await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const only = await explore("only", "SCENE_PRIOR_ONLY 只有正式评审会我才这样。");
    const [source] = (await db.select().from(coreSchema.sourceItems)).filter((row) =>
      row.content.includes("SCENE_PRIOR_ONLY"),
    );
    await post(`/api/core/explorations/${only.started.exploration.id}/amend`, "amend-only", {
      expected_version: only.done.version,
      target_source_id: source!.id,
      type: "supplements",
      note: "补充：熟人讨论里我也会先听完。",
    });
    const view = await (
      await app.request(`/api/core/explorations/${only.started.exploration.id}`, { headers })
    ).json();
    expect(view.phase).toBe("ready_to_plan");
  });

  it("takes the operation lock before prior revision locks, like source deletion", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const prior = first.done.claims[0];
    const started = await post("/api/core/explorations", "order-start", {
      event: "SCENE_SUPPORT 评审会我又先听完了。",
    });
    const ctx = await resolvePersonalContext(db, {
      provider: "findme-runtime",
      principalId: "owner",
    });
    const input = {
      exploration_id: started.exploration.id,
      expected_version: started.exploration.version,
      force_deeper: false,
    };
    const op = await beginCoreOperation(db, ctx, {
      idempotencyKey: "order-op",
      operationType: "exploration_continue",
      request: input,
      explorationId: started.exploration.id,
      basisVersion: started.exploration.version,
    });
    if (op.kind !== "execute") throw new Error("expected execute");
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Stand-in for a deletion that has already locked this operation row.
    const holder = sql.begin(async (tx) => {
      await tx`select id from core_operations where id = ${op.operationId} for update`;
      locked();
      await released;
    });
    await lockTaken;
    const running = continueExplorationWith(
      directCoreStore(db),
      scenarioGateway([]),
      ctx,
      input,
      op.operationId,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    // While waiting for the operation row, the commit must not hold the prior
    // revisions, or a deletion holding the row would deadlock with it.
    const probe = await sql.begin(async (tx) => {
      const rows = await tx`
        select id from claim_revisions where claim_id = ${prior.claim_id} for update nowait`;
      return rows.length;
    });
    expect(probe).toBeGreaterThan(0);
    release();
    await holder;
    const done = await running;
    expect((done.processing as { result: string }).result).toBe("supported");
  });

  it("rejects a correction whose target is revised by another exploration mid-commit", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const prior = first.done.claims[0];
    const ctx = await resolvePersonalContext(db, {
      provider: "findme-runtime",
      principalId: "owner",
    });
    const base = directCoreStore(db);
    // Stand-in for B's commit: locks A's current revision, then supersedes it.
    const racing = {
      read: base.read,
      write: async <T>(work: (handle: typeof db) => Promise<T>) => {
        let locked!: () => void;
        const lockTaken = new Promise<void>((resolve) => {
          locked = resolve;
        });
        let proceed!: () => void;
        const go = new Promise<void>((resolve) => {
          proceed = resolve;
        });
        const other = sql.begin(async (tx) => {
          await tx`select id from claim_revisions where id = ${prior.claim_revision_id} for update`;
          locked();
          await go;
          await tx`update claim_revisions set status = 'superseded' where id = ${prior.claim_revision_id}`;
          await tx`
            insert into claim_revisions
              (claim_id, version, mode, text, scope, status, confidence_level, confidence_basis, supersedes_revision_id)
            values (${prior.claim_id}, 2, 'observation', '另一处的更新', '另一处的范围', 'current', 'medium', '合成', ${prior.claim_revision_id})`;
        });
        await lockTaken;
        const commit = base.write(work);
        await new Promise((resolve) => setTimeout(resolve, 300));
        proceed();
        await other;
        return commit;
      },
    };
    await expect(
      correctUnderstandingWith(racing, scenarioGateway([]), ctx, {
        exploration_id: first.started.exploration.id,
        expected_version: first.done.version,
        claim_revision_ids: [prior.claim_revision_id],
        correction: { type: "missing_context", note: "补充背景。" },
      }),
    ).rejects.toMatchObject({ code: "STALE_CLAIM_REVISION" });
    const current = await db
      .select()
      .from(coreSchema.claimRevisions)
      .where(
        and(
          eq(coreSchema.claimRevisions.claimId, prior.claim_id),
          eq(coreSchema.claimRevisions.status, "current"),
        ),
      );
    expect(current.map((row) => row.text)).toEqual(["另一处的更新"]);
  });

  it("rejects continuation output when another exploration revised a local claim mid-commit", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const prior = first.done.claims[0];
    const ctx = await resolvePersonalContext(db, {
      provider: "findme-runtime",
      principalId: "owner",
    });
    const base = directCoreStore(db);
    const racing = {
      read: base.read,
      write: async <T>(work: (handle: typeof db) => Promise<T>) => {
        let locked!: () => void;
        const lockTaken = new Promise<void>((resolve) => {
          locked = resolve;
        });
        let proceed!: () => void;
        const go = new Promise<void>((resolve) => {
          proceed = resolve;
        });
        // Stand-in for B's commit narrowing A's claim.
        const other = sql.begin(async (tx) => {
          await tx`select id from claim_revisions where id = ${prior.claim_revision_id} for update`;
          locked();
          await go;
          await tx`update claim_revisions set status = 'superseded' where id = ${prior.claim_revision_id}`;
          await tx`
            insert into claim_revisions
              (claim_id, version, mode, text, scope, status, confidence_level, confidence_basis, supersedes_revision_id)
            values (${prior.claim_id}, 2, 'observation', '另一处的收窄', '另一处的范围', 'current', 'medium', '合成', ${prior.claim_revision_id})`;
        });
        await lockTaken;
        const commit = base.write(work);
        await new Promise((resolve) => setTimeout(resolve, 300));
        proceed();
        await other;
        return commit;
      },
    };
    await expect(
      continueExplorationWith(racing, scenarioGateway([]), ctx, {
        exploration_id: first.started.exploration.id,
        expected_version: first.done.version,
      }),
    ).rejects.toMatchObject({ code: "STALE_CLAIM_REVISION" });
    const current = await db
      .select()
      .from(coreSchema.claimRevisions)
      .where(
        and(
          eq(coreSchema.claimRevisions.claimId, prior.claim_id),
          eq(coreSchema.claimRevisions.status, "current"),
        ),
      );
    expect(current.map((row) => row.text)).toEqual(["另一处的收窄"]);
  });

  it("keeps another experience's evidence when continuing the owning exploration", async () => {
    const first = await explore("a", "SCENE_A 评审会上我等别人说完才发言。");
    const prior = first.done.claims[0];
    const second = await explore("narrow", "SCENE_NARROW 熟人讨论我会直接说，上级在场才先听完。");
    expect(second.done.processing.prior_effects[0].effect).toBe("narrows");
    const view = await (
      await app.request(`/api/core/explorations/${first.started.exploration.id}`, { headers })
    ).json();
    const again = await post(
      `/api/core/explorations/${first.started.exploration.id}/continue`,
      "continue-a-again",
      { expected_version: view.version },
    );
    const kept = again.claims.find((c: { claim_id: string }) => c.claim_id === prior.claim_id);
    const uses = await db
      .select()
      .from(coreSchema.claimEvidence)
      .where(eq(coreSchema.claimEvidence.claimRevisionId, kept.claim_revision_id));
    expect(uses.map((u) => u.independenceGroup)).toContain(
      `experience:${second.started.experience.id}`,
    );
  });
});
