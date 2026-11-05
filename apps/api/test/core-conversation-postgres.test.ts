import { coreSchema, createDb } from "@findme/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { coreTestApp } from "./helper.js";

// AG-07a on the existing chain: owner input is saved before model work, an
// explicit "stop using" needs no model, and a matter can be continued after the
// explorer stops asking. Synthetic model only; real answer quality is not tested.
const testUrl = process.env.DATABASE_URL_TEST;
const dbDescribe = testUrl ? describe : describe.skip;

type Extract = (input: { system?: string; text?: string }) => Promise<Record<string, unknown>>;

const CLAIM = {
  key: "wait_for_information",
  kind: "pattern",
  mode: "observation",
  text: "在这次信息尚不完整的情境里，你选择先等待，再补充表达。",
  scope: "仅限这次信息未准备完整的讨论情境。",
  confidence_level: "medium",
  confidence_basis: "来自单次事件，仍需要其他情境验证。",
  evidence: [
    {
      evidence_key: "E1",
      relation: "supports",
      directness: "direct",
      contribution: "medium",
      scope_match: "同一事件",
      rationale: "直接描述了事件。",
    },
  ],
};

const baseExtract: Extract = async (input) => {
  const system = input.system ?? "";
  const text = input.text ?? "";
  if (system.includes("目标不是延长对话"))
    return {
      current_reading: "材料已足以形成有限认识。",
      key_uncertainty: "信息充分时是否也会等待？",
      decision: "stop",
      question: null,
      intent: "继续追问只会增加细节。",
      quick_options: [],
      stop_reason: "当前材料足以形成有限认识。",
    };
  if (system.includes("对话回应者")) {
    const progress = text.includes("USER_MESSAGE (respond to this):\n后来");
    return {
      reply: progress ? "听起来事情有了进展，我们接着看。" : "换个说法：当时你在等信息确认。",
      used_claim_keys: text.includes(CLAIM.key) ? [CLAIM.key] : [],
      new_information: progress,
      new_information_note: progress ? "补充了后续进展。" : null,
    };
  }
  if (system.includes("认识修订器"))
    return {
      claims: [{ ...CLAIM, scope: "仅限信息未准备完整、且上级在场的讨论。" }],
      gaps: [],
      next_question: null,
      change_summary: "收窄了适用范围。",
      revision_reason: "用户补充了背景。",
      withdrawn_claim_keys: [],
    };
  return { claims: [CLAIM], gaps: [], next_question: null };
};

function gatewayOf(extract: Extract) {
  return {
    extract,
    chat: async () => ({ text: "" }),
    describe: (route: string) => ({ route, model: "test-observation-model" }),
  } as unknown as NonNullable<Parameters<typeof coreTestApp>[0]["gateway"]>;
}

dbDescribe("Core conversation continuity (AG-07a)", () => {
  const { db, sql } = createDb(testUrl ?? "");
  let failModel = false;
  const app = coreTestApp({
    db,
    gateway: gatewayOf(async (input) => {
      if (failModel) throw new Error("synthetic_provider_failure");
      return baseExtract(input);
    }),
  });
  const noModel = coreTestApp({ db });
  const headers = { "content-type": "application/json" };
  let n = 0;

  beforeEach(async () => {
    failModel = false;
    await sql.unsafe("TRUNCATE TABLE tenants RESTART IDENTITY CASCADE");
  });
  afterAll(async () => {
    await sql.end();
  });

  async function post(target: ReturnType<typeof coreTestApp>, path: string, body: unknown) {
    n += 1;
    return target.request(path, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": `k-${n}` },
      body: JSON.stringify(body),
    });
  }
  async function ok(path: string, body: unknown, target = app) {
    const response = await post(target, path, body);
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return response.json();
  }
  async function view(id: string) {
    return (await app.request(`/api/core/explorations/${id}`, { headers })).json();
  }
  async function understood() {
    const started = await ok("/api/core/explorations", {
      event: "评审临时提前，关键数据还没核完，所以我先听讨论。",
    });
    const done = await ok(`/api/core/explorations/${started.exploration.id}/continue`, {
      expected_version: started.exploration.version,
    });
    expect(done.claims).toHaveLength(1);
    return { id: started.exploration.id as string, done };
  }

  it("saves a correction without the model and processes it later", async () => {
    const { id, done } = await understood();
    const saved = await ok(
      `/api/core/explorations/${id}/corrections`,
      {
        expected_version: done.version,
        claim_revision_ids: [done.claims[0].claim_revision_id],
        correction: { type: "missing_context", note: "当时上级也在场。" },
      },
      noModel,
    );
    expect(saved.status).toBe("pending");
    let pending = (await view(id)).pending;
    expect(pending.corrections.map((c: { note: string }) => c.note)).toEqual(["当时上级也在场。"]);

    // A failed model call leaves it saved and pending.
    failModel = true;
    const failed = await post(app, `/api/core/explorations/${id}/correct`, {
      expected_version: saved.version,
      correction_source_id: saved.correction_source_id,
    });
    expect(failed.status).toBe(500);
    pending = (await view(id)).pending;
    expect(pending.corrections).toHaveLength(1);

    failModel = false;
    const revised = await ok(`/api/core/explorations/${id}/correct`, {
      expected_version: saved.version,
      correction_source_id: saved.correction_source_id,
    });
    expect(revised.claims[0].scope).toContain("上级在场");
    expect((await view(id)).pending.corrections).toEqual([]);
    const again = await post(app, `/api/core/explorations/${id}/correct`, {
      expected_version: revised.version,
      correction_source_id: saved.correction_source_id,
    });
    expect(again.status).toBe(409);
  });

  it("legacy correction body still saves first when the model fails", async () => {
    const { id, done } = await understood();
    failModel = true;
    const failed = await post(app, `/api/core/explorations/${id}/correct`, {
      expected_version: done.version,
      claim_revision_ids: [done.claims[0].claim_revision_id],
      correction: { type: "wrong_fact", note: "LEGACY_SAVED 这不是事实。" },
    });
    expect(failed.status).toBe(500);
    const sources = await db.select().from(coreSchema.sourceItems);
    expect(sources.some((s) => s.content.includes("LEGACY_SAVED"))).toBe(true);
    expect((await view(id)).pending.corrections).toHaveLength(1);
  });

  it("stops using a claim immediately and without a model", async () => {
    const { id, done } = await understood();
    const withdrawn = await ok(
      `/api/core/claim-revisions/${done.claims[0].claim_revision_id}/withdraw`,
      { note: "以后别再用这条。" },
      noModel,
    );
    expect(withdrawn.status).toBe("withdrawn");
    const current = await (await app.request("/api/core/understanding", { headers })).json();
    expect(current.claims).toEqual([]);
    expect((await view(id)).understanding.claims).toEqual([]);
    const changes = await (
      await app.request("/api/core/understanding/changes", { headers })
    ).json();
    expect(changes.items[0]).toMatchObject({ change: "withdrawn" });
    const twice = await post(
      noModel,
      `/api/core/claim-revisions/${done.claims[0].claim_revision_id}/withdraw`,
      {},
    );
    expect(twice.status).toBe(409);
  });

  it("continues a finished matter with a saved message and a direct reply", async () => {
    const { id, done } = await understood();
    const completed = await ok(`/api/core/explorations/${id}/complete`, {
      expected_version: done.version,
    });
    const saved = await ok(
      `/api/core/explorations/${id}/messages`,
      { expected_version: completed.version, message: "刚才那个原因我没听明白。" },
      noModel,
    );
    let current = await view(id);
    expect(current.status).toBe("active");
    expect(current.pending.messages).toHaveLength(1);

    const reply = await ok(`/api/core/explorations/${id}/reply`, {
      expected_version: saved.version,
      message_source_id: saved.message_source_id,
    });
    expect(reply.reply).toContain("换个说法");
    expect(reply.new_information).toBe(false);
    expect(reply.used.map((u: { key: string }) => u.key)).toEqual([CLAIM.key]);
    current = await view(id);
    expect(current.pending.messages).toEqual([]);
    expect(
      current.turns.map((t: { role: string; turnKind: string }) => `${t.role}:${t.turnKind}`),
    ).toEqual(expect.arrayContaining(["user:message", "assistant:reply"]));

    // Progress is new information and can be processed into the understanding.
    const progress = await ok(`/api/core/explorations/${id}/messages`, {
      expected_version: reply.version,
      message: "后来数据核完了，我在下一次会上直接提了意见。",
    });
    const progressReply = await ok(`/api/core/explorations/${id}/reply`, {
      expected_version: progress.version,
      message_source_id: progress.message_source_id,
    });
    expect(progressReply.new_information).toBe(true);
    const processed = await ok(`/api/core/explorations/${id}/continue`, {
      expected_version: progressReply.version,
    });
    expect(processed.claims.length).toBeGreaterThan(0);
  });

  it("keeps a message saved when the reply fails, and parks a matter", async () => {
    const { id, done } = await understood();
    const saved = await ok(`/api/core/explorations/${id}/messages`, {
      expected_version: done.version,
      message: "帮我比较一下两个选择。",
    });
    failModel = true;
    const failed = await post(app, `/api/core/explorations/${id}/reply`, {
      expected_version: saved.version,
      message_source_id: saved.message_source_id,
    });
    expect(failed.status).toBe(500);
    expect((await view(id)).pending.messages).toHaveLength(1);
    const noGateway = await post(noModel, `/api/core/explorations/${id}/reply`, {
      expected_version: saved.version,
      message_source_id: saved.message_source_id,
    });
    expect(noGateway.status).toBe(503);

    const parked = await ok(`/api/core/explorations/${id}/park`, {
      expected_version: saved.version,
      parked: true,
    });
    expect(parked.parked).toBe(true);
    const list = await (
      await app.request("/api/core/explorations?status=active", { headers })
    ).json();
    expect(list.items[0]).toMatchObject({ id, parked: true });
    expect(list.items[0].key_uncertainty).toBe("信息充分时是否也会等待？");
  });
});
