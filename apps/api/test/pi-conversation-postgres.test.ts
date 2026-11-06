import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type FauxResponseFactory,
  type FauxResponseStep,
  InMemoryCredentialStore,
  type TranscriptContext,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { coreSchema as c, createDb } from "@findme/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { ProfileService } from "../src/auth/profiles.js";
import { invalidateCloudSources } from "../src/cloud-diagnostic/effects.js";
import { lockPiProfileState, withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import { withdrawClaimByOwner } from "../src/core/conversation.js";
import type { PersonalContext } from "../src/core/exploration-types.js";
import type { CoreGateway } from "../src/core/llm.js";
import { onError } from "../src/middleware/error.js";
import {
  PiArchiveRepository,
  SqlPiArchiveDatabase,
  piArchiveFingerprint,
} from "../src/personal-understanding/pi-archive.js";
import {
  PI_REPLY_LIMITS,
  createPiReplyHandler,
  decodePiReview,
} from "../src/personal-understanding/pi-conversation.js";
import type { PiSessionArchive } from "../src/personal-understanding/pi-runtime.js";
import { reviewSegments } from "../src/personal-understanding/review-edits.js";
import { accountCoreModelRoutes } from "../src/routes/account-core-model.js";

const final = (reply: string) =>
  fauxAssistantMessage(
    JSON.stringify({
      reply,
      used_claim_keys: [],
      new_information: false,
      new_information_note: null,
    }),
  );

function reviewPayload(context: TranscriptContext): { candidate_reply: string } | undefined {
  const message = context.messages.filter((message) => message.role === "user").at(-1);
  if (!message) return undefined;
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  try {
    const parsed = JSON.parse(text);
    return typeof parsed.candidate_reply === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function responses(
  f: Awaited<ReturnType<typeof fixture>>,
  steps: FauxResponseStep[],
  review?: (candidate: string) => string,
) {
  const remaining = [...steps];
  const dispatch: FauxResponseFactory = async (context, controls, state, model) => {
    const payload = reviewPayload(context);
    if (payload) {
      const reply = review ? review(payload.candidate_reply) : payload.candidate_reply;
      const segments = reviewSegments(payload.candidate_reply);
      return fauxAssistantMessage(
        JSON.stringify({
          edits:
            reply === payload.candidate_reply
              ? []
              : segments.map((segment, index) => ({
                  target_id: segment.id,
                  operation: index === 0 ? "replace" : "delete",
                  ...(index === 0 ? { replacement: reply } : {}),
                  reason: "仅保留本人原话支持的范围。",
                  basis: { kind: "evidence" },
                })),
        }),
      );
    }
    const step = remaining.shift();
    if (!step) throw new Error("unscripted primary response");
    return typeof step === "function" ? step(context, controls, state, model) : step;
  };
  // One bounded review follows each primary final; tool rounds consume the same queue.
  f.provider.setResponses(Array.from({ length: steps.length * 2 + 2 }, () => dispatch));
}

async function fixture(limit = 3, piSynchronousWaitMs?: number) {
  const config = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const runtimeDb = createDb(config.runtime_url);
  const identity = createDb(config.identity_url);
  const ctx = await new ProfileService(identity.db).resolve({
    provider: "pi-chain-test",
    principalId: randomUUID(),
  });
  const provider = fauxProvider({
    provider: `faux-${randomUUID()}`,
    models: [{ id: "test", contextWindow: 200000, maxTokens: 2000 }],
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const handler = createPiReplyHandler({
    db: runtimeDb.db,
    methodsRoot: path.resolve("resources/personal-understanding"),
    provider: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "synthetic",
      model: "synthetic",
      limits: PI_REPLY_LIMITS,
    },
    createProvider: async () => ({
      modelRuntime,
      model: provider.getModel(),
      usage: () => ({ requests: provider.state.callCount, reservedUsd: 0 }),
      assertHealthy: () => {},
    }),
  });
  const gateway = {
    describe: () => ({ route: "observation_model", model: "synthetic" }),
    extract: async () => {
      throw new Error("legacy gateway must not run");
    },
  } as unknown as CoreGateway;
  let requestCtx = ctx;
  const app = new Hono();
  app.onError(onError);
  app.route(
    "/api/core",
    accountCoreModelRoutes({
      db: runtimeDb.db,
      gateway,
      contextFor: async () => requestCtx,
      dailyOperationLimit: limit,
      piReply: handler,
      piSynchronousWaitMs,
    }),
  );
  return {
    ctx,
    db: runtimeDb.db,
    provider,
    app,
    setContext: (next: PersonalContext) => {
      requestCtx = next;
    },
    otherProfile: () =>
      new ProfileService(identity.db).resolve({
        provider: "pi-chain-test",
        principalId: randomUUID(),
      }),
    close: async () => {
      await Promise.all([runtimeDb.sql.end(), identity.sql.end()]);
    },
  };
}

async function conversation(
  db: ReturnType<typeof createDb>["db"],
  ctx: PersonalContext,
  content: string,
) {
  return withProfileTransaction(db, ctx, async (tx) => {
    const [experience] = await tx
      .insert(c.experiences)
      .values({ ...ctx, summary: content })
      .returning();
    if (!experience) throw new Error("fixture experience missing");
    const [thread] = await tx
      .insert(c.explorations)
      .values({ ...ctx, experienceId: experience.id })
      .returning();
    if (!thread) throw new Error("fixture thread missing");
    const source = await insertMessage(tx, ctx, thread.id, content, "event");
    return { id: thread.id, version: 1, sourceId: source.id };
  });
}
type Tx = Parameters<Parameters<typeof withProfileTransaction>[2]>[0];
async function insertMessage(
  tx: Tx,
  ctx: PersonalContext,
  id: string,
  content: string,
  kind = "message",
) {
  const [source] = await tx
    .insert(c.sourceItems)
    .values({
      ...ctx,
      sourceKind: "native_event",
      authorKind: "subject",
      content,
      sourceMeta: { exploration_id: id, reply_status: "pending" },
    })
    .returning();
  if (!source) throw new Error("fixture source missing");
  await tx.insert(c.sourceAssessments).values({
    sourceItemId: source.id,
    version: 1,
    attributionStatus: "confirmed_subject",
    contextCompleteness: "sufficient",
    temporalPrecision: "unknown",
    eligibility: "eligible",
    rationale: "synthetic",
  });
  await tx
    .insert(c.explorationTurns)
    .values({ explorationId: id, sourceItemId: source.id, role: "user", turnKind: kind, content });
  return source;
}
async function nextMessage(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  version: number,
  content: string,
) {
  return withProfileTransaction(f.db, f.ctx, async (tx) => {
    const source = await insertMessage(tx, f.ctx, id, content);
    await tx
      .update(c.explorations)
      .set({ version: version + 1 })
      .where(eq(c.explorations.id, id));
    return { id, version: version + 1, sourceId: source.id };
  });
}
const request = (
  f: Awaited<ReturnType<typeof fixture>>,
  thread: { id: string; version: number; sourceId: string },
  key = randomUUID(),
) =>
  f.app.request(`/api/core/explorations/${thread.id}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ expected_version: thread.version, message_source_id: thread.sourceId }),
  });

it("runs real pi tools, persists traces, resumes the same session, replays idempotently and rebuilds after exclusion", async () => {
  const f = await fixture();
  try {
    const historical = await conversation(f.db, f.ctx, "合成历史：我选周六活动，因为周日要休息。");
    const thread = await conversation(f.db, f.ctx, "请查合成历史，看看我以前为什么选周六活动。");
    let firstToolContext = "";
    responses(f, [
      fauxAssistantMessage(
        fauxToolCall("search_history", { query: "合成历史" }, { id: "history-search" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        firstToolContext = JSON.stringify(context);
        return final("查到原话：周日要休息。");
      },
    ]);
    const key = randomUUID();
    const first = await request(f, thread, key);
    expect(first.status).toBe(201);
    const result = await first.json();
    expect(result.engine).toBe("pi");
    expect(result.version).toBe(2);
    expect(firstToolContext).toContain("周日要休息");
    expect(firstToolContext).toContain("toolResult");
    expect(firstToolContext).not.toContain(thread.sourceId);
    expect(firstToolContext).toContain("区分本人直接表达、本人转述、粘贴原文");
    expect(firstToolContext).toContain("## 步骤");
    const rows = await withProfileTransaction(f.db, f.ctx, (tx) =>
      tx
        .select()
        .from(c.piSessionArchives)
        .where(eq(c.piSessionArchives.conversationId, thread.id)),
    );
    const latest = rows.sort((a, b) => b.revision - a.revision)[0];
    expect(latest?.archive?.complete).toBe(true);
    expect(latest?.archive?.records).toBeUndefined();
    const loadedMethods = latest?.archive?.loadedMethods as Array<{
      name: string;
      version: string;
      referenceVersion: string;
    }>;
    expect(loadedMethods.length).toBeGreaterThanOrEqual(2);
    expect(loadedMethods.some((method) => method.name === "understanding-review")).toBe(true);
    expect(
      loadedMethods.some(
        (method) =>
          method.name === "experience-and-evidence" &&
          /^[a-f0-9]{64}$/.test(method.version) &&
          /^[a-f0-9]{64}$/.test(method.referenceVersion),
      ),
    ).toBe(true);
    const traces = await withProfileTransaction(f.db, f.ctx, (tx) =>
      tx.select().from(c.piRequestRecords).where(eq(c.piRequestRecords.conversationId, thread.id)),
    );
    expect(traces).toHaveLength(3);
    expect(
      traces.every(
        (trace) => trace.status === "completed" && trace.piInput !== null && trace.output !== null,
      ),
    ).toBe(true);
    expect(JSON.stringify(traces[0]?.piInput)).toContain("区分本人直接表达、本人转述、粘贴原文");
    expect(latest?.dependencies.some((d) => d.sourceId === historical.sourceId)).toBe(true);
    expect(latest?.dependencies.some((d) => d.sourceId === thread.sourceId)).toBe(true);
    const calls = f.provider.state.callCount;
    expect((await request(f, thread, key)).status).toBe(201);
    expect(f.provider.state.callCount).toBe(calls);
    const secondThread = await nextMessage(f, thread.id, 2, "刚才为什么这么说？");
    let resumed = "";
    responses(f, [
      (context) => {
        resumed = JSON.stringify(context);
        return final("因为你之前提到周日要休息。");
      },
    ]);
    const second = await request(f, secondThread);
    expect(second.status).toBe(201);
    expect(resumed).toContain("查到原话");
    await withProfileTransaction(f.db, f.ctx, async (tx) => {
      await lockPiProfileState(tx, f.ctx);
      await tx
        .update(c.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(c.sourceItems.id, historical.sourceId));
      await invalidateCloudSources(tx, f.ctx, [historical.sourceId]);
    });
    const currentVersion = await withProfileTransaction(
      f.db,
      f.ctx,
      async (tx) =>
        (await tx.select().from(c.explorations).where(eq(c.explorations.id, thread.id)))[0]
          ?.version ?? 0,
    );
    const thirdThread = await nextMessage(
      f,
      thread.id,
      currentVersion,
      "现在只按这个会话里能用的材料回答。",
    );
    let rebuilt = "";
    responses(f, [
      (context) => {
        rebuilt = JSON.stringify(context);
        return final("当前材料不足以确认旧活动原因。");
      },
    ]);
    const third = await request(f, thirdThread);
    expect(third.status).toBe(201);
    const thirdResult = await third.json();
    expect(rebuilt).not.toContain("合成历史：");
    expect(rebuilt).not.toContain("查到原话");
    expect(rebuilt).not.toContain("因为你之前提到");
    expect(rebuilt).not.toContain('"role":"toolResult"');
    const fourthThread = await nextMessage(f, thread.id, thirdResult.version, "还有一个问题");
    const beforeQuota = f.provider.state.callCount;
    const denied = await request(f, fourthThread);
    expect(denied.status).toBe(503);
    expect((await denied.json()).error.code).toBe("CORE_MODEL_LIMIT_REACHED");
    expect(f.provider.state.callCount).toBe(beforeQuota);
  } finally {
    await f.close();
  }
});

it("rejects excluded current input before sending any model request", async () => {
  const f = await fixture();
  try {
    const thread = await conversation(f.db, f.ctx, "EXCLUDED_CURRENT_INPUT");
    await withProfileTransaction(f.db, f.ctx, (tx) =>
      tx
        .update(c.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(c.sourceItems.id, thread.sourceId)),
    );
    const response = await request(f, thread);
    expect(response.status).toBe(409);
    expect(f.provider.state.callCount).toBe(0);
  } finally {
    await f.close();
  }
});

it("propagates A source exclusion through B conversation reads into C archives and replay caches", async () => {
  const f = await fixture(6);
  try {
    const a = await conversation(f.db, f.ctx, "A_PRIVATE_REASON：周日休息");
    const b = await conversation(f.db, f.ctx, "查看A的历史原因");
    const bKey = randomUUID();
    responses(f, [
      fauxAssistantMessage(
        fauxToolCall(
          "read_source",
          { id: a.sourceId, intended_use: "fact_context", relation: "核对所问历史原因的原话" },
          { id: "read-a" },
        ),
        {
          stopReason: "toolUse",
        },
      ),
      final("B_PRIVATE_DERIVATION：周日休息"),
    ]);
    expect((await request(f, b, bKey)).status).toBe(201);
    const cThread = await conversation(f.db, f.ctx, "查看B会话的说明");
    const cKey = randomUUID();
    let expanded = "";
    let defaultExpanded = "";
    responses(f, [
      fauxAssistantMessage(
        fauxToolCall(
          "read_conversation",
          { id: b.id, intended_use: "fact_context", relation: "查看所问B会话的原始背景" },
          { id: "read-b-default" },
        ),
        {
          stopReason: "toolUse",
        },
      ),
      (context) => {
        defaultExpanded = JSON.stringify(context);
        return fauxAssistantMessage(
          fauxToolCall(
            "read_conversation",
            {
              id: b.id,
              include_analysis: true,
              intended_use: "counterexample",
              relation: "核对B曾作的判断，不把它当本人事实",
            },
            { id: "read-b-analysis" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        expanded = JSON.stringify(context);
        return final("C_PRIVATE_DERIVATION：周日休息");
      },
    ]);
    expect((await request(f, cThread, cKey)).status).toBe(201);
    expect(defaultExpanded).not.toContain("B_PRIVATE_DERIVATION");
    expect(expanded).toContain("B_PRIVATE_DERIVATION");
    const unrelated = await conversation(f.db, f.ctx, "独立讨论：今天选择散步");
    responses(f, [final("UNRELATED_REPLY_STAYS")]);
    expect((await request(f, unrelated)).status).toBe(201);
    const before = await withProfileTransaction(f.db, f.ctx, (tx) =>
      tx.select().from(c.piSessionArchives),
    );
    expect(
      before.some(
        (row) =>
          row.conversationId === cThread.id &&
          row.dependencies.some((d) => d.sourceId === a.sourceId),
      ),
    ).toBe(true);
    await withProfileTransaction(f.db, f.ctx, async (tx) => {
      await lockPiProfileState(tx, f.ctx);
      await tx
        .update(c.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(c.sourceItems.id, a.sourceId));
      await invalidateCloudSources(tx, f.ctx, [a.sourceId]);
    });
    await withProfileTransaction(f.db, f.ctx, async (tx) => {
      const archives = await tx.select().from(c.piSessionArchives);
      const derived = archives.filter((row) => [b.id, cThread.id].includes(row.conversationId));
      const affected = derived.filter((row) =>
        row.dependencies.some((d) => d.sourceId === a.sourceId),
      );
      expect(affected.length).toBeGreaterThan(0);
      expect(affected.every((row) => row.archive === null)).toBe(true);
      for (const row of derived.filter((row) => row.archive !== null)) {
        const retained = JSON.stringify(row.archive);
        expect(retained).not.toContain("A_PRIVATE_REASON");
        expect(retained).not.toContain("B_PRIVATE_DERIVATION");
        expect(retained).not.toContain("C_PRIVATE_DERIVATION");
        expect(row.archive?.complete).not.toBe(true);
      }
      const turns = await tx.select().from(c.explorationTurns);
      expect(
        turns.some(
          (row) => row.explorationId === unrelated.id && row.content === "UNRELATED_REPLY_STAYS",
        ),
      ).toBe(true);
      const replySource = (
        await tx.select().from(c.sourceItems).where(eq(c.sourceItems.id, cThread.sourceId))
      )[0];
      expect(replySource?.sourceMeta?.reply_status).toBe("pending");
      const traces = await tx.select().from(c.piRequestRecords);
      expect(
        traces
          .filter((row) => row.dependencies.some((d) => d.sourceId === a.sourceId))
          .every(
            (row) => row.piInput === null && row.providerPayload === null && row.output === null,
          ),
      ).toBe(true);
      expect(
        turns
          .filter(
            (row) => [b.id, cThread.id].includes(row.explorationId) && row.role === "assistant",
          )
          .every((row) => row.content === ""),
      ).toBe(true);
      const operations = await tx.select().from(c.coreOperations);
      expect(
        operations
          .filter((row) => [b.id, cThread.id].includes(row.explorationId ?? ""))
          .every((row) => row.responseBody === null),
      ).toBe(true);
    });
    const beforeReplay = f.provider.state.callCount;
    const replay = await request(f, cThread, cKey);
    expect(replay.status).toBe(409);
    expect(JSON.stringify(await replay.json())).not.toContain("C_PRIVATE_DERIVATION");
    expect(f.provider.state.callCount).toBe(beforeReplay);
    const repairedVersion = await withProfileTransaction(
      f.db,
      f.ctx,
      async (tx) =>
        (await tx.select().from(c.explorations).where(eq(c.explorations.id, cThread.id)))[0]
          ?.version ?? 0,
    );
    responses(f, [final("重新核对后，只能承接仍有效的本人表达。")]);
    const reanswered = await request(f, { ...cThread, version: repairedVersion });
    expect(reanswered.status).toBe(201);
    expect((await reanswered.json()).reply).toContain("仍有效");
    expect(f.provider.state.callCount).toBe(beforeReplay + 2);
  } finally {
    await f.close();
  }
});

function barrier() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("does not deadlock or publish old evidence when exclusion overlaps a pi final response", async () => {
  const f = await fixture();
  const atFinal = barrier();
  const returnFinal = barrier();
  const returnedFinal = barrier();
  const exclusionLocked = barrier();
  const releaseExclusion = barrier();
  let pending: Promise<Response> | undefined;
  let exclusion: Promise<unknown> | undefined;
  try {
    const a = await conversation(f.db, f.ctx, "INTERLEAVED_PRIVATE_REASON");
    const b = await conversation(f.db, f.ctx, "查历史再回答");
    responses(f, [
      fauxAssistantMessage(
        fauxToolCall(
          "read_source",
          { id: a.sourceId, intended_use: "fact_context", relation: "核对所问历史原因的原话" },
          { id: "read-race" },
        ),
        {
          stopReason: "toolUse",
        },
      ),
      async () => {
        atFinal.resolve();
        await returnFinal.promise;
        returnedFinal.resolve();
        return final("OLD_RESULT_MUST_NOT_PUBLISH");
      },
    ]);
    pending = request(f, b);
    await Promise.race([
      atFinal.promise,
      pending.then(() => {
        throw new Error("request finished before final barrier");
      }),
    ]);
    exclusion = withProfileTransaction(f.db, f.ctx, async (tx) => {
      await lockPiProfileState(tx, f.ctx);
      await tx
        .update(c.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(c.sourceItems.id, a.sourceId));
      await invalidateCloudSources(tx, f.ctx, [a.sourceId]);
      exclusionLocked.resolve();
      await releaseExclusion.promise;
    });
    await Promise.race([
      exclusionLocked.promise,
      exclusion.then(() => {
        throw new Error("exclusion did not reach barrier");
      }),
    ]);
    returnFinal.resolve();
    await returnedFinal.promise;
    releaseExclusion.resolve();
    await exclusion;
    const response = await pending;
    expect(response.status).toBe(409);
    await withProfileTransaction(f.db, f.ctx, async (tx) => {
      const turns = await tx
        .select()
        .from(c.explorationTurns)
        .where(eq(c.explorationTurns.explorationId, b.id));
      expect(turns.some((t) => t.content.includes("OLD_RESULT_MUST_NOT_PUBLISH"))).toBe(false);
      const rows = await tx
        .select()
        .from(c.piSessionArchives)
        .where(eq(c.piSessionArchives.conversationId, b.id));
      expect(rows.some((row) => row.archive?.complete === true)).toBe(false);
    });
  } finally {
    returnFinal.resolve();
    releaseExclusion.resolve();
    await Promise.allSettled([pending, exclusion].filter(Boolean));
    await f.close();
  }
});

it("returns 202 while pi continues, replays processing without charging again, and exposes the final result only to its Profile", async () => {
  const f = await fixture(3, 0);
  const reachedModel = barrier();
  const allowModel = barrier();
  let operationId = "";
  try {
    const thread = await conversation(f.db, f.ctx, "合成后台处理输入");
    responses(f, [
      async () => {
        reachedModel.resolve();
        await allowModel.promise;
        return final("合成后台回应已完成");
      },
    ]);
    const key = randomUUID();
    const first = await request(f, thread, key);
    expect(first.status).toBe(202);
    operationId = (await first.json()).operation_id;
    expect(operationId).toBeTruthy();
    await reachedModel.promise;
    const url = `/api/core/model-operations/${operationId}`;
    const processing = await f.app.request(url);
    expect(processing.status).toBe(200);
    expect((await processing.json()).status).toBe("processing");
    const before = f.provider.state.callCount;
    const replay = await request(f, thread, key);
    expect(replay.status).toBe(202);
    expect((await replay.json()).operation_id).toBe(operationId);
    expect(f.provider.state.callCount).toBe(before);
    const quota = await f.app.request("/api/core/model-status");
    expect((await quota.json()).operations_used).toBe(1);
    f.setContext(await f.otherProfile());
    expect((await f.app.request(url)).status).toBe(404);
    f.setContext(f.ctx);
    allowModel.resolve();
    await expect
      .poll(async () => await (await f.app.request(url)).json(), { timeout: 10000, interval: 10 })
      .toMatchObject({
        status: "completed",
        response: { engine: "pi", reply: "合成后台回应已完成" },
      });
    expect(f.provider.state.callCount).toBe(before + 1);
    expect((await (await f.app.request("/api/core/model-status")).json()).operations_used).toBe(1);
  } finally {
    f.setContext(f.ctx);
    allowModel.resolve();
    if (operationId)
      await expect
        .poll(
          async () =>
            (await (await f.app.request(`/api/core/model-operations/${operationId}`)).json())
              .status,
          { timeout: 10000, interval: 10 },
        )
        .not.toBe("processing");
    await f.close();
  }
});

it("delivers the evidence-reviewed wording and resumes without the unsupported payment draft", async () => {
  const f = await fixture();
  try {
    const thread = await conversation(f.db, f.ctx, "我只是报了名，还没有付款。");
    responses(f, [fauxAssistantMessage("你已经付费，说明你已投入实际成本。")], (candidate) => {
      expect(candidate).toContain("已经付费");
      return "你目前只是报名，还没有付款，不能据此认定已经投入金钱成本。";
    });
    const first = await request(f, thread);
    expect(first.status).toBe(201);
    const accepted = await first.json();
    expect(accepted.reply).toContain("只是报名");
    expect(accepted.reply).not.toContain("已经付费");
    expect(accepted).not.toHaveProperty("edits");
    expect(accepted).not.toHaveProperty("review_application");
    const traces = await withProfileTransaction(f.db, f.ctx, (tx) =>
      tx.select().from(c.piRequestRecords).where(eq(c.piRequestRecords.conversationId, thread.id)),
    );
    const audit = traces
      .map((trace) => JSON.stringify(trace.output))
      .find((text) => text.includes("review_application"));
    expect(audit).toContain("仅保留本人原话支持的范围");
    expect(audit).toContain("replace");
    expect(audit).toContain("applied_edits");
    expect(audit).toContain("你已经付费，说明你已投入实际成本。");
    expect(audit).toContain(accepted.reply);
    const next = await nextMessage(f, thread.id, accepted.version, "那接着聊吧。");
    let restoredContext = "";
    responses(f, [
      (context) => {
        restoredContext = JSON.stringify(
          context.messages.filter((message) => message.role !== "system"),
        );
        return final("我们接着讨论报名这件事。");
      },
    ]);
    expect((await request(f, next)).status).toBe(201);
    expect(restoredContext).toContain("只是报名");
    expect(restoredContext).not.toContain("你已经付费");
    expect(restoredContext).not.toContain("说明你已投入实际成本");
    expect(restoredContext).not.toContain("review_application");
    expect(restoredContext).not.toContain("applied_edits");
    expect(restoredContext).not.toContain("仅保留本人原话支持的范围");
  } finally {
    await f.close();
  }
});

it("rebuilds a pending earlier reply without later messages and reads replies beside their input", async () => {
  const f = await fixture(5);
  try {
    const first = await conversation(f.db, f.ctx, "EARLY_INPUT_ONLY");
    const later = await nextMessage(f, first.id, first.version, "LATER_INPUT_MUST_NOT_LEAK");
    let earlyContext = "";
    responses(f, [
      (context) => {
        earlyContext = JSON.stringify(context);
        return final("EARLY_ANSWER");
      },
    ]);
    const earlyResult = await request(f, { ...first, version: later.version });
    expect(earlyResult.status).toBe(201);
    expect(earlyContext).toContain("EARLY_INPUT_ONLY");
    expect(earlyContext).not.toContain("LATER_INPUT_MUST_NOT_LEAK");
    const { version } = await earlyResult.json();
    const { getExplorationView } = await import("../src/core/exploration-views.js");
    const view = await withProfileTransaction(f.db, f.ctx, (tx) =>
      getExplorationView(tx as never, f.ctx, first.id),
    );
    expect(view.turns.map((turn) => turn.content)).toEqual([
      "EARLY_INPUT_ONLY",
      "EARLY_ANSWER",
      "LATER_INPUT_MUST_NOT_LEAK",
    ]);
    const { NativeConversationReader } = await import(
      "../src/personal-understanding/native-conversations.js"
    );
    const read = await new NativeConversationReader(f.db).read(f.ctx, {
      conversationId: first.id,
      includeAnalysis: true,
      cursor: 1,
      limit: 1,
    });
    expect(read.turns[0]?.content).toBe("EARLY_ANSWER");
    let laterContext = "";
    responses(f, [
      (context) => {
        laterContext = JSON.stringify(context);
        return final("LATER_ANSWER");
      },
    ]);
    expect((await request(f, { ...later, version })).status).toBe(201);
    expect(laterContext.indexOf("EARLY_ANSWER")).toBeLessThan(
      laterContext.indexOf("LATER_INPUT_MUST_NOT_LEAK"),
    );
  } finally {
    await f.close();
  }
});

it("unwraps stored pi reply envelopes on rebuild without rewriting the stored turn or user JSON", async () => {
  const f = await fixture();
  try {
    const thread = await conversation(f.db, f.ctx, "OLD_USER_INPUT");
    const envelope = JSON.stringify({
      reply: "LEGACY_DB_ANSWER",
      used_claim_keys: [],
      new_information: false,
      new_information_note: null,
    });
    await withProfileTransaction(f.db, f.ctx, async (tx) => {
      const [reply] = await tx
        .insert(c.explorationTurns)
        .values({
          explorationId: thread.id,
          role: "assistant",
          turnKind: "pi_reply",
          content: envelope,
        })
        .returning();
      await tx
        .update(c.sourceItems)
        .set({
          sourceMeta: {
            exploration_id: thread.id,
            reply_status: "replied",
            reply: { engine: "pi", turn_id: reply?.id, source_ids: [thread.sourceId] },
          },
        })
        .where(eq(c.sourceItems.id, thread.sourceId));
    });
    const next = await nextMessage(f, thread.id, thread.version, envelope);
    let history: Array<{ role: string; content: string }> = [];
    responses(f, [
      (context) => {
        const texts = context.messages
          .flatMap((m) =>
            typeof m.content === "string"
              ? [m.content]
              : m.content.filter((p) => p.type === "text").map((p) => p.text),
          )
          .filter((t) => t.startsWith("以下是本会话有效历史资料"));
        history = texts.flatMap((text) => JSON.parse(text.slice(text.indexOf("\n") + 1)));
        return final("new answer");
      },
    ]);
    expect((await request(f, next)).status).toBe(201);
    expect(history.find((t) => t.role === "assistant")?.content).toBe("LEGACY_DB_ANSWER");
    const stored = await withProfileTransaction(f.db, f.ctx, (tx) =>
      tx.select().from(c.explorationTurns).where(eq(c.explorationTurns.explorationId, thread.id)),
    );
    expect(stored.some((t) => t.role === "assistant" && t.content === envelope)).toBe(true);
    expect(stored.some((t) => t.role === "user" && t.content === envelope)).toBe(true);
  } finally {
    await f.close();
  }
});

it("applies only identified edits and records the actual before/after without normalizing untouched text", () => {
  const candidate = "## 标题\r\n\r\n原观察。 另一句仍保留。\n- 原选项\n";
  const target = reviewSegments(candidate).find((segment) => segment.text === "原观察。");
  expect(target).toBeTruthy();
  expect(decodePiReview('{"edits":[]}', candidate).reply).toBe(candidate);
  const result = decodePiReview(
    JSON.stringify({
      edits: [
        {
          target_id: target?.id,
          operation: "replace",
          replacement: "有限观察。",
          reason: "原话只支持此范围。",
          basis: { kind: "evidence" },
        },
      ],
    }),
    candidate,
  );
  expect(result.reply).toBe(candidate.replace("原观察。", "有限观察。"));
  expect(result.audit.applied_edits[0]).toMatchObject({
    before: "原观察。",
    after: "有限观察。",
    operation: "replace",
  });
  expect(result.audit.candidate_sha256).not.toBe(result.audit.result_sha256);
  const deletion = decodePiReview(
    JSON.stringify({
      edits: [
        {
          target_id: target?.id,
          operation: "delete",
          reason: "无据判断。",
          basis: { kind: "evidence" },
        },
      ],
    }),
    candidate,
  );
  expect(deletion.reply).toBe(candidate.replace("原观察。", ""));
  expect(deletion.audit.applied_edits[0]?.operation).toBe("delete");
});

it("rejects conflicting, ineffective, ungrounded constraint and whole-reply review edits", () => {
  const edit = {
    target_id: "b1",
    operation: "replace",
    replacement: "修正。",
    reason: "范围过宽。",
    basis: { kind: "evidence" },
  };
  for (const value of [
    { reply: "偷偷重写", edits: [] },
    { edits: [{ ...edit, target_id: "b99" }] },
    { edits: [edit, edit] },
    { edits: [{ ...edit, replacement: "原观察。" }] },
    { edits: [{ ...edit, replacement: "  " }] },
    {
      edits: [
        { target_id: "b1", operation: "delete", reason: "全删", basis: { kind: "evidence" } },
      ],
    },
    { edits: [{ ...edit, operation: "delete" }] },
    {
      edits: [
        { ...edit, basis: { kind: "user_constraint", quote: "不要再提问", scope: "current_turn" } },
      ],
    },
  ])
    expect(() =>
      decodePiReview(JSON.stringify(value), "原观察。", { current: "先问一道两选题", history: [] }),
    ).toThrow("PI_REPLY_FORMAT_INVALID");
  const constraint = {
    ...edit,
    basis: { kind: "user_constraint", quote: "先问一道两选题", scope: "current_turn" },
  };
  expect(
    decodePiReview(JSON.stringify({ edits: [constraint] }), "原观察。", {
      current: "先问一道两选题",
      history: [],
    }).audit.applied_edits[0]?.basis.kind,
  ).toBe("user_constraint");
  expect(() =>
    decodePiReview(JSON.stringify({ edits: [constraint] }), "原观察。", {
      current: "B",
      history: ["先问一道两选题"],
    }),
  ).toThrow("PI_REPLY_FORMAT_INVALID");
});

it("does not publish an unauditable review and leaves the saved input pending", async () => {
  const f = await fixture();
  try {
    const thread = await conversation(f.db, f.ctx, "合成事件：请比较几种解释。");
    const steps: FauxResponseFactory = (context) =>
      reviewPayload(context)
        ? fauxAssistantMessage(JSON.stringify({ reply: "擅自改写但没有理由", decisions: [] }))
        : fauxAssistantMessage("有边界的候选观察。");
    f.provider.setResponses([steps, steps]);
    const response = await request(f, thread);
    expect(response.status).toBe(502);
    const { getExplorationView } = await import("../src/core/exploration-views.js");
    const view = await withProfileTransaction(f.db, f.ctx, (tx) =>
      getExplorationView(tx as never, f.ctx, thread.id),
    );
    expect(view.turns.filter((turn) => turn.role === "assistant")).toHaveLength(0);
    expect(view.pending.messages.some((message) => message.source_id === thread.sourceId)).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});

it("rebuilds a valid old-policy archive instead of replaying its unqualified tool context", async () => {
  const f = await fixture();
  try {
    await conversation(f.db, f.ctx, "合成旧工具资料：范围只适用于某次任务。");
    const thread = await conversation(f.db, f.ctx, "请查合成旧工具资料。");
    responses(f, [
      fauxAssistantMessage(
        fauxToolCall("search_history", { query: "合成旧工具资料" }, { id: "old-policy-search" }),
        { stopReason: "toolUse" },
      ),
      final("已按原话说明范围。"),
    ]);
    const first = await request(f, thread);
    expect(first.status).toBe(201);
    const accepted = await first.json();
    await withProfileTransaction(f.db, f.ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(c.piSessionArchives)
        .where(eq(c.piSessionArchives.conversationId, thread.id));
      const row = rows.sort((a, b) => b.revision - a.revision)[0];
      if (!row?.archive) throw new Error("expected archived conversation");
      const archive = structuredClone(row.archive) as PiSessionArchive & { contextPolicy?: string };
      delete archive.contextPolicy;
      const toolEntry = archive.entries.find(
        (entry) => entry.type === "message" && entry.message.role === "toolResult",
      );
      if (!toolEntry || toolEntry.type !== "message" || toolEntry.message.role !== "toolResult")
        throw new Error("expected tool context");
      toolEntry.message.content.push({ type: "text", text: "OLD_POLICY_ARCHIVE_ONLY_MARKER" });
      await tx
        .update(c.piSessionArchives)
        .set({ archive, fingerprint: piArchiveFingerprint(archive, row.dependencies) })
        .where(eq(c.piSessionArchives.id, row.id));
      const restored = await new PiArchiveRepository(
        SqlPiArchiveDatabase.forTransaction(tx, f.ctx),
      ).restore(f.ctx, thread.id, archive.sessionId);
      expect(restored?.status).toBe("available");
    });
    const next = await nextMessage(f, thread.id, accepted.version, "继续说这件事。");
    let actualInput = "";
    responses(f, [
      (context) => {
        actualInput = JSON.stringify(context);
        return final("继续按已交付记录讨论。");
      },
    ]);
    expect((await request(f, next)).status).toBe(201);
    expect(actualInput).toContain("已按原话说明范围");
    expect(actualInput).not.toContain("OLD_POLICY_ARCHIVE_ONLY_MARKER");
  } finally {
    await f.close();
  }
});

it("applies the target-message time boundary to tool reads from another conversation", async () => {
  const f = await fixture();
  try {
    const thread = await conversation(f.db, f.ctx, "请按当时已有材料回答。");
    const future = await conversation(
      f.db,
      f.ctx,
      "CROSS_CONVERSATION_FUTURE_CONTENT_MUST_NOT_LEAK",
    );
    await withProfileTransaction(f.db, f.ctx, async (tx) => {
      const [target] = await tx
        .select()
        .from(c.sourceItems)
        .where(eq(c.sourceItems.id, thread.sourceId));
      if (!target) throw new Error("missing target");
      await tx
        .update(c.sourceItems)
        .set({ capturedAt: new Date(target.capturedAt.getTime() + 60_000) })
        .where(eq(c.sourceItems.id, future.sourceId));
    });
    let actualInput = "";
    responses(f, [
      fauxAssistantMessage(
        fauxToolCall(
          "read_source",
          {
            id: future.sourceId,
            intended_use: "fact_context",
            relation: "检查指定记录是否在当时已存在。",
          },
          { id: "future-source" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        actualInput = JSON.stringify(context);
        return final("当时没有可使用的相关材料。");
      },
    ]);
    expect((await request(f, thread)).status).toBe(201);
    expect(actualInput).not.toContain("CROSS_CONVERSATION_FUTURE_CONTENT_MUST_NOT_LEAK");
    expect(actualInput).toContain("SOURCE_NOT_AVAILABLE");
  } finally {
    await f.close();
  }
});

async function seedExplicitDefaultPreference(f: Awaited<ReturnType<typeof fixture>>) {
  const text = "以后所有对话请先说明参考材料的适用范围。";
  const owner = await conversation(f.db, f.ctx, text);
  const revisionId = await withProfileTransaction(f.db, f.ctx, async (tx) => {
    const [span] = await tx
      .insert(c.evidenceSpans)
      .values({
        sourceItemId: owner.sourceId,
        quote: text,
        locator: { start: 0, end: text.length },
        authorKind: "subject",
        aboutSubject: true,
      })
      .returning();
    const [claim] = await tx
      .insert(c.claims)
      .values({
        ...f.ctx,
        claimKey: `${owner.id}/explicit-preference`,
        claimKind: "value",
      })
      .returning();
    const [revision] = await tx
      .insert(c.claimRevisions)
      .values({
        claimId: claim!.id,
        version: 1,
        mode: "self_report",
        status: "current",
        evidenceStatus: "valid",
        text: "参考材料应先说明适用范围（SCOPED_PREFERENCE_INDEX_MARKER）",
        scope: "本人明确要求的长期对话呈现方式",
        confidenceLevel: "high",
        confidenceBasis: "本人明确自述；非人格判断",
        details: {
          interaction_preference: {
            explicit: true,
            source_id: owner.sourceId,
            source_assessment_version: 1,
            original_text: text,
            scope: { kind: "default", explicitlyLongTerm: true },
            scope_quote: text,
          },
        },
      })
      .returning();
    await tx.insert(c.claimEvidence).values({
      claimRevisionId: revision!.id,
      evidenceSpanId: span!.id,
      relation: "supports",
      directness: "direct",
      contribution: "high",
      independenceGroup: owner.sourceId,
      scopeMatch: "exact",
      rationale: "明确本人原话",
    });
    return revision!.id;
  });
  return { owner, revisionId, text };
}

it("assembles an eligible explicit default preference and related knowledge before the first pi request", async () => {
  const f = await fixture();
  try {
    const preference = await seedExplicitDefaultPreference(f);
    const thread = await conversation(f.db, f.ctx, "请谈参考材料的适用范围。");
    let modelInput = "";
    let systemInput = "";
    responses(f, [
      (context) => {
        modelInput = JSON.stringify(context);
        systemInput = JSON.stringify(
          context.messages.filter((message) => message.role === "system"),
        );
        return final("先确认这段参考材料适用于什么范围。");
      },
    ]);
    const response = await request(f, thread);
    expect(response.status).toBe(201);
    expect(modelInput).toContain(preference.text);
    expect(systemInput).not.toContain(preference.text);
    expect(systemInput).not.toContain("SCOPED_PREFERENCE_INDEX_MARKER");
    expect(modelInput).toContain("SCOPED_PREFERENCE_INDEX_MARKER");
    expect(modelInput).toContain(preference.revisionId);
    await withProfileTransaction(f.db, f.ctx, async (tx) => {
      const [source] = await tx
        .select()
        .from(c.sourceItems)
        .where(eq(c.sourceItems.id, thread.sourceId));
      const reply = source?.sourceMeta?.reply as {
        source_ids?: string[];
        revision_dependencies?: Array<{ revisionId: string; fingerprint: string }>;
        context_fingerprint?: string;
      };
      expect(reply.source_ids).toContain(preference.owner.sourceId);
      expect(reply.revision_dependencies).toContainEqual(
        expect.objectContaining({ revisionId: preference.revisionId }),
      );
      expect(reply.context_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      const rows = await tx
        .select()
        .from(c.piSessionArchives)
        .where(eq(c.piSessionArchives.conversationId, thread.id));
      const archive = rows.sort((a, b) => b.revision - a.revision)[0]?.archive;
      expect(archive?.complete).toBe(true);
      expect(archive?.revision_dependencies).toContainEqual(
        expect.objectContaining({ revisionId: preference.revisionId }),
      );
      expect(archive?.contextFingerprint).toBe(reply.context_fingerprint);
    });
  } finally {
    await f.close();
  }
});

it("rebuilds a source-valid conversation after actual withdrawal and omits its prior preference and derived reply", async () => {
  const f = await fixture();
  try {
    const preference = await seedExplicitDefaultPreference(f);
    const thread = await conversation(f.db, f.ctx, "请谈参考材料的适用范围。");
    responses(f, [final("REPLY_DERIVED_FROM_SCOPED_PREFERENCE")]);
    const first = await request(f, thread);
    expect(first.status).toBe(201);
    const accepted = await first.json();
    await withProfileTransaction(f.db, f.ctx, async (tx) => {
      await lockPiProfileState(tx, f.ctx);
      const result = await withdrawClaimByOwner(tx as unknown as typeof f.db, f.ctx, {
        claim_revision_id: preference.revisionId,
      });
      expect(result.status).toBe("withdrawn");
      const [source] = await tx
        .select()
        .from(c.sourceItems)
        .where(eq(c.sourceItems.id, preference.owner.sourceId));
      expect(source?.usageStatus).toBe("active");
      const [revision] = await tx
        .select()
        .from(c.claimRevisions)
        .where(eq(c.claimRevisions.id, preference.revisionId));
      expect(revision?.status).toBe("superseded");
    });
    const next = await nextMessage(f, thread.id, accepted.version, "继续这段讨论。");
    let modelInput = "";
    responses(f, [
      (context) => {
        modelInput = JSON.stringify(context);
        return final("仅根据当前可用内容继续。");
      },
    ]);
    const response = await request(f, next);
    expect(response.status).toBe(201);
    expect(modelInput).not.toContain(preference.text);
    expect(modelInput).not.toContain("SCOPED_PREFERENCE_INDEX_MARKER");
    expect(modelInput).not.toContain("REPLY_DERIVED_FROM_SCOPED_PREFERENCE");
    expect(modelInput).not.toContain(preference.revisionId);
    expect(modelInput).toContain("继续这段讨论");
    await withProfileTransaction(f.db, f.ctx, async (tx) => {
      const [source] = await tx
        .select()
        .from(c.sourceItems)
        .where(eq(c.sourceItems.id, next.sourceId));
      const reply = source?.sourceMeta?.reply as {
        revision_dependencies?: Array<{ revisionId: string }>;
      };
      expect(reply.revision_dependencies?.some((d) => d.revisionId === preference.revisionId)).toBe(
        false,
      );
    });
  } finally {
    await f.close();
  }
});

it("resumes a prepared compaction checkpoint after a primary failure without summarizing again", async () => {
  const f = await fixture();
  try {
    let thread = await conversation(
      f.db,
      f.ctx,
      `HISTORY_0_BEGIN${"合".repeat(3900)}HISTORY_0_END`,
    );
    for (let i = 1; i < 6; i++)
      thread = await nextMessage(
        f,
        thread.id,
        thread.version,
        `HISTORY_${i}_BEGIN${"合".repeat(3900)}HISTORY_${i}_END`,
      );
    const target = await nextMessage(f, thread.id, thread.version, "当前短消息：接着聊这一件事。");
    let summaries = 0;
    responses(f, [
      (context) => {
        summaries++;
        expect(JSON.stringify(context)).toContain("historical_conversation_material");
        return fauxAssistantMessage("SUMMARY_OF_OLDER_TURNS：仅整理先前记录，未作个人推断。");
      },
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "synthetic primary request failure",
      }),
    ]);
    expect((await request(f, target)).status).toBe(502);
    await withProfileTransaction(f.db, f.ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(c.piSessionArchives)
        .where(eq(c.piSessionArchives.conversationId, thread.id));
      const prepared = rows.sort((a, b) => b.revision - a.revision)[0]?.archive;
      expect(prepared?.phase).toBe("prepared");
      expect(prepared?.complete).toBe(false);
      expect(prepared?.contextVersion).toBe(target.version);
      expect(prepared?.pendingMessageId).toBe(target.sourceId);
      const [source] = await tx
        .select()
        .from(c.sourceItems)
        .where(eq(c.sourceItems.id, target.sourceId));
      expect(source?.sourceMeta?.reply_status).toBe("pending");
    });
    let resumedInput = "";
    let primaryRequests = 0;
    responses(f, [
      (context) => {
        primaryRequests++;
        resumedInput = JSON.stringify(context);
        expect(resumedInput).toContain("当前短消息");
        return final("已从有效压缩检查点接着交流。");
      },
    ]);
    const response = await request(f, target, randomUUID());
    expect(response.status).toBe(201);
    expect(summaries).toBe(1);
    expect(primaryRequests).toBe(1);
    expect(resumedInput).toContain("SUMMARY_OF_OLDER_TURNS");
    expect(resumedInput).toContain("HISTORY_4_BEGIN");
    expect(resumedInput).toContain("HISTORY_5_BEGIN");
    expect(resumedInput).not.toContain("HISTORY_0_BEGIN");
    await withProfileTransaction(f.db, f.ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(c.piSessionArchives)
        .where(eq(c.piSessionArchives.conversationId, thread.id));
      expect(rows.sort((a, b) => b.revision - a.revision)[0]?.archive?.complete).toBe(true);
      const traces = await tx
        .select()
        .from(c.piRequestRecords)
        .where(eq(c.piRequestRecords.conversationId, thread.id));
      expect(traces).toHaveLength(4); // summary + failed primary, then primary + reviewer
    });
  } finally {
    await f.close();
  }
});

it("does not report cancelling adjacent edits as changes to the delivered text", () => {
  const candidate = "第一句话。第二句话。";
  const result = decodePiReview(
    JSON.stringify({
      edits: [
        {
          target_id: "b1",
          operation: "replace",
          replacement: candidate,
          reason: "合并",
          basis: { kind: "evidence" },
        },
        { target_id: "b2", operation: "delete", reason: "已合并", basis: { kind: "evidence" } },
      ],
    }),
    candidate,
  );
  expect(result.reply).toBe(candidate);
  expect(result.audit.applied_edits).toEqual([]);
  expect(result.audit.discarded_no_effect_targets).toEqual(["b1", "b2"]);
  expect(result.audit.candidate_sha256).toBe(result.audit.result_sha256);
});

it("does not revive a legacy reply's withdrawn knowledge in the pi conversation", async () => {
  const f = await fixture();
  try {
    const preference = await seedExplicitDefaultPreference(f);
    const legacy = await conversation(f.db, f.ctx, "较早的普通对话");
    await withProfileTransaction(f.db, f.ctx, async (tx) => {
      const [turn] = await tx
        .insert(c.explorationTurns)
        .values({
          explorationId: legacy.id,
          role: "assistant",
          turnKind: "reply",
          content: "LEGACY_REPLY_FROM_WITHDRAWABLE_KNOWLEDGE",
        })
        .returning();
      if (!turn) throw new Error("fixture missing");
      await tx
        .update(c.sourceItems)
        .set({
          sourceMeta: {
            exploration_id: legacy.id,
            reply_status: "replied",
            reply: { turn_id: turn.id, offered_claim_revision_ids: [preference.revisionId] },
          },
        })
        .where(eq(c.sourceItems.id, legacy.sourceId));
    });
    const next = await nextMessage(f, legacy.id, legacy.version, "继续谈参考材料");
    let before = "";
    responses(f, [
      (context) => {
        before = JSON.stringify(context);
        return final("继续当前讨论");
      },
    ]);
    const first = await request(f, next);
    expect(first.status).toBe(201);
    const accepted = await first.json();
    expect(before).toContain("LEGACY_REPLY_FROM_WITHDRAWABLE_KNOWLEDGE");
    await withProfileTransaction(f.db, f.ctx, async (tx) => {
      await lockPiProfileState(tx, f.ctx);
      await withdrawClaimByOwner(tx as unknown as typeof f.db, f.ctx, {
        claim_revision_id: preference.revisionId,
      });
    });
    const afterInput = await nextMessage(f, legacy.id, accepted.version, "现在再继续");
    let after = "";
    responses(f, [
      (context) => {
        after = JSON.stringify(context);
        return final("仅用当前可用材料");
      },
    ]);
    expect((await request(f, afterInput)).status).toBe(201);
    expect(after).not.toContain("LEGACY_REPLY_FROM_WITHDRAWABLE_KNOWLEDGE");
    expect(after).not.toContain(preference.text);
  } finally {
    await f.close();
  }
});
