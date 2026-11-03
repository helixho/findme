import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDb } from "@findme/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createAccountAuth } from "../src/auth/server.js";
import { createCloudServices } from "../src/cloud-diagnostic/runtime.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";

// Account-mode automatic conversation processing on the isolated RLS database:
// model calls run between short Profile transactions, a rolling operation limit
// stops further calls without losing saved input, and Profiles stay apart.
const configFile = process.env.FINDME_ACCOUNT_VERIFY_CONFIG;
const adminUrl = process.env.DATABASE_URL_TEST;
const base = "http://127.0.0.1:8811";
const suite = configFile && adminUrl ? describe : describe.skip;

suite("account Core model routes / isolated Postgres / synthetic model", () => {
  let runtime: ReturnType<typeof createDb>;
  let identity: ReturnType<typeof createDb>;
  let account: ReturnType<typeof createAccountAuth>;
  let app: ReturnType<typeof createApp>;
  let disabled: ReturnType<typeof createApp>;
  let admin: ReturnType<typeof createDb>["sql"];
  let replayOf: { id: string; version: number; key: string; body: unknown } | null = null;
  let a = "";
  let b = "";
  let aProfile = "";
  let bProfile = "";
  const mails: { to: string; text: string }[] = [];
  const stamp = randomUUID().slice(0, 8);
  const password = "Synthetic-Verification-Only-2026!";
  const inTransactionDuringModel: number[] = [];
  const modelTexts: string[] = [];
  const retryControls: unknown[] = [];

  const gateway = {
    extract: async (input: { system?: string; text?: string; controls?: { retries?: number } }) => {
      retryControls.push(input.controls?.retries);
      const system = input.system ?? "";
      const text = input.text ?? "";
      modelTexts.push(text);
      // Any connection of the runtime login holding a transaction open while the
      // model is being called would show up here.
      const rows = await admin`
        select count(*)::int as n from pg_stat_activity
        where usename like 'test_runtime%' and state like 'idle in transaction%'`;
      inTransactionDuringModel.push(rows[0]?.n ?? -1);
      if (text.includes("FAIL_ALWAYS")) throw new Error("synthetic_provider_failure");
      if (system.includes("目标不是延长对话")) {
        const asked = Number(text.match(/"asked":(\d+)/)?.[1] ?? "0");
        return asked === 0 && text.includes("ASK_FIRST")
          ? {
              current_reading: "这次先等待与信息尚未确认有关。",
              key_uncertainty: "影响选择的是信息还是其他约束？",
              decision: "ask",
              question: "当时最影响你决定的是什么？",
              intent: "不同答案会改变适用范围。",
              quick_options: ["信息不完整", "时机不合适"],
              stop_reason: null,
            }
          : {
              current_reading: "材料已足以形成有限认识。",
              key_uncertainty: "其他情境留给后续经历。",
              decision: "stop",
              question: null,
              intent: "继续追问只会增加细节。",
              quick_options: [],
              stop_reason: "当前材料足以形成有限认识。",
            };
      }
      const priorLine = text.split("PRIOR_UNDERSTANDING (")[1]?.split("\n")[1];
      const prior = priorLine ? (JSON.parse(priorLine) as Array<{ key: string }>) : [];
      return {
        claims: [
          {
            key: "wait_for_information",
            kind: "pattern",
            mode: "observation",
            text: "在这次信息尚不完整的评审里，你先等待再补充表达。",
            scope: "这次信息未准备完整的评审。",
            confidence_level: "medium",
            confidence_basis: "来自单次合成经历。",
            evidence: [
              {
                evidence_key: "E1",
                relation: "supports",
                directness: "direct",
                contribution: "high",
                scope_match: "同一事件",
                rationale: "直接描述了事件。",
              },
            ],
          },
        ],
        gaps: [],
        next_question: null,
        prior_updates: prior.slice(0, 1).map((item) => ({
          prior_key: item.key,
          effect: "supports",
          revised_text: null,
          revised_scope: null,
          rationale: "又一次独立经历出现了相同的先等待。",
          evidence: [
            {
              evidence_key: "E1",
              relation: "supports",
              directness: "direct",
              contribution: "medium",
              scope_match: "相似评审情境",
              rationale: "新的独立经历。",
            },
          ],
        })),
      };
    },
    chat: async () => ({ text: "" }),
    describe: (route: string) => ({ route, model: "test-observation-model" }),
  } as unknown as NonNullable<Parameters<typeof createApp>[0]["gateway"]>;

  async function request(
    target: ReturnType<typeof createApp>,
    cookie: string,
    path: string,
    options: { method?: string; body?: unknown; profile?: string; key?: string } = {},
  ) {
    return target.request(base + path, {
      method: options.method ?? "GET",
      headers: {
        Origin: base,
        Cookie: cookie,
        "content-type": "application/json",
        ...(options.profile ? { "X-FindMe-Profile": options.profile } : {}),
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }
  async function json(response: Response, status = 200): Promise<any> {
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(status);
    return value;
  }

  beforeAll(async () => {
    const cfg = JSON.parse(await readFile(configFile!, "utf8"));
    if (cfg.database !== "findme_test" || !["127.0.0.1", "localhost"].includes(cfg.host))
      throw new Error("EXPLICIT_ISOLATED_TEST_CONFIG_REQUIRED");
    admin = createDb(adminUrl!, { max: 1 }).sql;
    runtime = createDb(cfg.runtime_url, { max: 2 });
    identity = createDb(cfg.identity_url, { max: 2 });
    account = createAccountAuth({
      databaseUrl: cfg.auth_url,
      secret: cfg.secret,
      baseUrl: base,
      trustedOrigins: [base],
      registrationEnabled: true,
      sendMail: async (mail) => {
        mails.push(mail);
      },
    });
    const cloud = createCloudServices({
      db: runtime.db,
      identityDb: identity.db,
      processing: {
        enabled: false,
        profileCallLimit: 0,
        maxCallsPerJob: 4,
        maxOutputTokens: 1000,
        timeoutMs: 10000,
      },
    });
    const auth = {
      mode: "account" as const,
      sessions: account.sessions,
      trustedOrigins: [base],
      handler: (req: Request) => account.auth.handler(req),
    };
    app = createApp({
      db: runtime.db,
      cloud,
      gateway,
      coreModel: { dailyOperationLimit: 3 },
      auth,
    });
    disabled = createApp({ db: runtime.db, cloud, gateway, auth });
    const cookieOf = (response: Response) =>
      response.headers
        .getSetCookie()
        .map((s) => s.split(";")[0])
        .join("; ");
    for (const who of ["a", "b"]) {
      const email = `core-model-${stamp}-${who}@validation.invalid`;
      await json(
        await request(app, "", "/api/auth/sign-up/email", {
          method: "POST",
          body: { email, password, name: `Synthetic ${who}` },
        }),
      );
      const link = mails.find((m) => m.to === email)?.text.match(/https?:\/\/\S+/)?.[0];
      expect(link).toBeTruthy();
      expect((await app.request(link!, { headers: { Origin: base } })).status).toBeLessThan(400);
      const signed = await request(app, "", "/api/auth/sign-in/email", {
        method: "POST",
        body: { email, password },
      });
      await json(signed);
      if (who === "a") a = cookieOf(signed);
      else b = cookieOf(signed);
    }
    aProfile = (await json(await request(app, a, "/api/profiles")))[0].id;
    bProfile = (await json(await request(app, b, "/api/profiles")))[0].id;
  }, 180000);

  afterAll(async () => {
    await Promise.all([runtime?.sql.end(), identity?.sql.end(), account?.close(), admin?.end()]);
  });

  const start = async (event: string, key: string) =>
    json(
      await request(app, a, "/api/core/explorations", {
        method: "POST",
        profile: aProfile,
        key,
        body: { event },
      }),
      201,
    );
  const proceed = (id: string, version: number, key: string, target = app, cookie = a) =>
    request(target, cookie, `/api/core/explorations/${id}/continue`, {
      method: "POST",
      profile: cookie === a ? aProfile : bProfile,
      key,
      body: { expected_version: version },
    });

  it("stays off unless the owner configured a limit", async () => {
    const status = await json(
      await request(disabled, a, "/api/core/model-status", { profile: aProfile }),
    );
    expect(status).toMatchObject({ enabled: false, operation_limit: 0 });
    const started = await start("ASK_FIRST 评审提前，数据没核完，我先听讨论。", `off-${stamp}`);
    const response = await proceed(
      started.exploration.id,
      started.exploration.version,
      `off-c-${stamp}`,
      disabled,
    );
    expect(response.status).toBe(503);
    expect(modelTexts).toHaveLength(0);
  });

  it("plans, saves and synthesizes under RLS with no transaction open during model calls", async () => {
    const status = await json(
      await request(app, a, "/api/core/model-status", { profile: aProfile }),
    );
    expect(status).toMatchObject({ enabled: true, operation_limit: 3, operations_used: 0 });
    const started = await start("ASK_FIRST 评审提前，数据没核完，我先听讨论。", `s1-${stamp}`);
    const asked = await json(
      await proceed(started.exploration.id, started.exploration.version, `c1-${stamp}`),
      201,
    );
    expect(asked.phase).toBe("awaiting_answer");
    const answered = await json(
      await request(app, a, `/api/core/explorations/${started.exploration.id}/respond`, {
        method: "POST",
        profile: aProfile,
        key: `r1-${stamp}`,
        body: {
          expected_version: asked.version,
          question_id: asked.question.id,
          answer: "主要是数据还没确认。",
        },
      }),
      201,
    );
    const done = await json(
      await proceed(started.exploration.id, answered.version, `c2-${stamp}`),
      201,
    );
    expect(done.processing.result).toBe("added");
    expect(done.prior_understanding.used).toEqual([]);

    // The second exploration receives the first one's current claim through RLS.
    const next = await start("又一次评审数据没准备好，我也先等了。", `s2-${stamp}`);
    const second = await json(
      await proceed(next.exploration.id, next.exploration.version, `c3-${stamp}`),
      201,
    );
    expect(second.prior_understanding.used).toEqual([
      expect.objectContaining({ claim_revision_id: done.claims[0].claim_revision_id }),
    ]);
    expect(second.processing).toMatchObject({ result: "added" });
    replayOf = {
      id: next.exploration.id,
      version: next.exploration.version,
      key: `c3-${stamp}`,
      body: second,
    };
    expect(second.processing.prior_effects[0]).toMatchObject({ effect: "supports" });
    expect(inTransactionDuringModel.length).toBeGreaterThan(0);
    expect(inTransactionDuringModel.every((n) => n === 0)).toBe(true);
    // The gateway's own retry is disabled so each extraction is one provider request.
    expect(retryControls.length).toBeGreaterThan(0);
    expect(retryControls.every((value) => value === 0)).toBe(true);
    // Control: the same probe does see a Profile transaction that is held open.
    const scope = await admin`
      select tenant_id::text as "tenantId", subject_id::text as "subjectId"
      from profile_memberships where id = ${aProfile}`;
    const held = await withProfileTransaction(runtime.db, scope[0] as never, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const rows = await admin`
        select count(*)::int as n from pg_stat_activity
        where usename like 'test_runtime%' and state like 'idle in transaction%'`;
      return rows[0]?.n ?? 0;
    });
    expect(held).toBeGreaterThan(0);

    const current = await json(
      await request(app, a, "/api/core/understanding", { profile: aProfile }),
    );
    expect(
      current.claims.find((c: { claim_id: string }) => c.claim_id === done.claims[0].claim_id),
    ).toMatchObject({ version: 2 });

    // Profile B sees neither the exploration nor the understanding.
    const foreign = await proceed(next.exploration.id, second.version, `b-${stamp}`, app, b);
    expect(foreign.status).toBe(404);
    const other = await json(
      await request(app, b, "/api/core/understanding", { profile: bProfile }),
    );
    expect(other.claims).toEqual([]);
  });

  it("stops at the rolling limit without calling the model, while replays and saving still work", async () => {
    const calls = modelTexts.length;
    const started = await start("第三次评审我还是先听了讨论。", `s3-${stamp}`);
    expect(started.saved).toBe(true);
    const blocked = await proceed(
      started.exploration.id,
      started.exploration.version,
      `c4-${stamp}`,
    );
    expect(blocked.status).toBe(503);
    expect((await blocked.json()).error.code).toBe("CORE_MODEL_LIMIT_REACHED");
    expect(modelTexts.length).toBe(calls);
    const view = await json(
      await request(app, a, `/api/core/explorations/${started.exploration.id}`, {
        profile: aProfile,
      }),
    );
    expect(view.version).toBe(started.exploration.version);
    const status = await json(
      await request(app, a, "/api/core/model-status", { profile: aProfile }),
    );
    expect(status.operations_used).toBe(3);
    // An already completed operation replays even when the limit is reached.
    const replay = await json(await proceed(replayOf!.id, replayOf!.version, replayOf!.key), 201);
    expect(replay).toEqual(replayOf!.body);
  });

  it("charges each re-execution of a failed operation against the limit", async () => {
    const roomy = createApp({
      db: runtime.db,
      cloud: createCloudServices({
        db: runtime.db,
        identityDb: identity.db,
        processing: {
          enabled: false,
          profileCallLimit: 0,
          maxCallsPerJob: 4,
          maxOutputTokens: 1000,
          timeoutMs: 10000,
        },
      }),
      gateway,
      coreModel: { dailyOperationLimit: 100 },
      auth: {
        mode: "account",
        sessions: account.sessions,
        trustedOrigins: [base],
        handler: (req: Request) => account.auth.handler(req),
      },
    });
    const used = async () =>
      (await json(await request(roomy, a, "/api/core/model-status", { profile: aProfile })))
        .operations_used as number;
    const before = await used();
    const started = await start("FAIL_ALWAYS 合成失败经历。", `fail-${stamp}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await proceed(
        started.exploration.id,
        started.exploration.version,
        `fail-c-${stamp}`,
        roomy,
      );
      expect(failed.status).toBe(500);
    }
    // One reservation plus one charged re-execution.
    expect(await used()).toBe(before + 2);
  });

  it("serialises reservations per Profile on one lock before counting", async () => {
    const scope = await admin`
      select tenant_id::text as t, subject_id::text as s
      from profile_memberships where id = ${aProfile}`;
    const lockKey = `core-model:${scope[0]?.t}:${scope[0]?.s}`;
    const started = await start("并发合成经历。", `lock-${stamp}`);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Another reservation holds the Profile lock in an open transaction.
    const holder = admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      locked();
      await released;
    });
    await lockTaken;
    let settled = false;
    const pending = proceed(
      started.exploration.id,
      started.exploration.version,
      `lk-${stamp}`,
    ).then((response) => {
      settled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false);
    release();
    await holder;
    // Limit already reached by earlier tests: the serialised count rejects it.
    const response = await pending;
    expect(response.status).toBe(503);
  });

  it("does not count an original reservation that has left the window", async () => {
    // Age every earlier operation of this Profile beyond the rolling window.
    await admin`
      update core_operations set created_at = now() - interval '25 hours'
      where subject_id = (select subject_id from profile_memberships where id = ${aProfile})`;
    const one = createApp({
      db: runtime.db,
      cloud: createCloudServices({
        db: runtime.db,
        identityDb: identity.db,
        processing: {
          enabled: false,
          profileCallLimit: 0,
          maxCallsPerJob: 4,
          maxOutputTokens: 1000,
          timeoutMs: 10000,
        },
      }),
      gateway,
      coreModel: { dailyOperationLimit: 1 },
      auth: {
        mode: "account",
        sessions: account.sessions,
        trustedOrigins: [base],
        handler: (req: Request) => account.auth.handler(req),
      },
    });
    const views = await json(
      await request(one, a, "/api/core/explorations?limit=50", { profile: aProfile }),
    );
    const failed = views.items.find((item: { summary: string }) =>
      item.summary.includes("FAIL_ALWAYS"),
    );
    const retried = await proceed(failed.id, failed.version, `fail-c-${stamp}`, one);
    // Executed (the synthetic provider fails) rather than rejected by the limit.
    expect(retried.status).toBe(500);
    const status = await json(
      await request(one, a, "/api/core/model-status", { profile: aProfile }),
    );
    expect(status.operations_used).toBe(1);
  });
});
