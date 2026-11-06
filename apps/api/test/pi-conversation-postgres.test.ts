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
import type { PersonalContext } from "../src/core/exploration-types.js";
import type { CoreGateway } from "../src/core/llm.js";
import { onError } from "../src/middleware/error.js";
import {
  PI_REPLY_LIMITS,
  createPiReplyHandler,
} from "../src/personal-understanding/pi-conversation.js";
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
    if (payload)
      return fauxAssistantMessage(
        review ? review(payload.candidate_reply) : payload.candidate_reply,
      );
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
    expect(loadedMethods).toHaveLength(5);
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
      fauxAssistantMessage(fauxToolCall("read_source", { id: a.sourceId }, { id: "read-a" }), {
        stopReason: "toolUse",
      }),
      final("B_PRIVATE_DERIVATION：周日休息"),
    ]);
    expect((await request(f, b, bKey)).status).toBe(201);
    const cThread = await conversation(f.db, f.ctx, "查看B会话的说明");
    const cKey = randomUUID();
    let expanded = "";
    let defaultExpanded = "";
    responses(f, [
      fauxAssistantMessage(
        fauxToolCall("read_conversation", { id: b.id }, { id: "read-b-default" }),
        {
          stopReason: "toolUse",
        },
      ),
      (context) => {
        defaultExpanded = JSON.stringify(context);
        return fauxAssistantMessage(
          fauxToolCall(
            "read_conversation",
            { id: b.id, include_analysis: true },
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
      fauxAssistantMessage(fauxToolCall("read_source", { id: a.sourceId }, { id: "read-race" }), {
        stopReason: "toolUse",
      }),
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
    const next = await nextMessage(f, thread.id, accepted.version, "那接着聊吧。");
    let restoredContext = "";
    responses(f, [
      (context) => {
        restoredContext = JSON.stringify(context);
        return final("我们接着讨论报名这件事。");
      },
    ]);
    expect((await request(f, next)).status).toBe(201);
    expect(restoredContext).toContain("只是报名");
    expect(restoredContext).not.toContain("你已经付费");
    expect(restoredContext).not.toContain("说明你已投入实际成本");
  } finally {
    await f.close();
  }
});
