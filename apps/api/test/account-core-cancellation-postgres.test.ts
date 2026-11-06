import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { coreSchema as c, createDb } from "@findme/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { ProfileService } from "../src/auth/profiles.js";
import { lockPiProfileState, withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import type { CoreGateway } from "../src/core/llm.js";
import { completeCoreOperation, lockCoreOperation } from "../src/core/operations.js";
import { onError } from "../src/middleware/error.js";
import type { PiReplyHandler } from "../src/personal-understanding/pi-conversation.js";
import { accountCoreModelRoutes } from "../src/routes/account-core-model.js";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(waitMs: number | null = 0) {
  const config = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const runtime = createDb(config.runtime_url);
  const identity = createDb(config.identity_url);
  const profiles = new ProfileService(identity.db);
  const ctx = await profiles.resolve({ provider: "cancel-test", principalId: randomUUID() });
  let requestCtx = ctx;
  const calls: Array<{ signal?: AbortSignal; release: () => void }> = [];
  const piReply: PiReplyHandler = async (owner, raw, operationId, signal) => {
    const input = raw as { exploration_id: string; message_source_id: string };
    const waiting = gate();
    calls.push({ signal, release: waiting.release });
    // Intentionally ignore transport abort until released: the durable commit
    // gate must reject even a provider that returns a late successful answer.
    await waiting.promise;
    return withProfileTransaction(runtime.db, owner, async (tx) => {
      await lockPiProfileState(tx, owner);
      await lockCoreOperation(tx as never, operationId);
      await tx.insert(c.explorationTurns).values({
        explorationId: input.exploration_id,
        role: "assistant",
        turnKind: "pi_reply",
        content: "synthetic final",
      });
      await tx
        .update(c.sourceItems)
        .set({ sourceMeta: { exploration_id: input.exploration_id, reply_status: "replied" } })
        .where(eq(c.sourceItems.id, input.message_source_id));
      const result = { exploration_id: input.exploration_id, version: 2, reply: "synthetic final" };
      await completeCoreOperation(tx as never, operationId, 201, result);
      return result;
    });
  };
  const app = new Hono();
  app.onError(onError);
  app.route(
    "/api/core",
    accountCoreModelRoutes({
      db: runtime.db,
      gateway: {
        extract: async () => {
          throw new Error("no legacy generation");
        },
      } as unknown as CoreGateway,
      piReply,
      ...(waitMs === null ? {} : { piSynchronousWaitMs: waitMs }),
      contextFor: async () => requestCtx,
      dailyOperationLimit: 10,
    }),
  );
  const thread = await withProfileTransaction(runtime.db, ctx, async (tx) => {
    const [experience] = await tx
      .insert(c.experiences)
      .values({ ...ctx, summary: "synthetic cancellation" })
      .returning();
    const [exploration] = await tx
      .insert(c.explorations)
      .values({ ...ctx, experienceId: experience!.id })
      .returning();
    const [source] = await tx
      .insert(c.sourceItems)
      .values({
        ...ctx,
        sourceKind: "native_event",
        authorKind: "subject",
        content: "saved input",
        sourceMeta: { exploration_id: exploration!.id, reply_status: "pending" },
      })
      .returning();
    await tx.insert(c.explorationTurns).values({
      explorationId: exploration!.id,
      sourceItemId: source!.id,
      role: "user",
      turnKind: "event",
      content: "saved input",
    });
    return { id: exploration!.id, sourceId: source!.id };
  });
  const request = (path: string, body?: unknown, key = randomUUID()) =>
    app.request(`/api/core${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    ctx,
    db: runtime.db,
    thread,
    calls,
    request,
    reply: (key: string, asynchronous = false) =>
      request(
        `/explorations/${thread.id}/reply${asynchronous ? "?async=1" : ""}`,
        { expected_version: 1, message_source_id: thread.sourceId },
        key,
      ),
    switchProfile: async () => {
      requestCtx = await profiles.resolve({ provider: "cancel-test", principalId: randomUUID() });
    },
    restoreProfile: () => {
      requestCtx = ctx;
    },
    close: async () => {
      for (const call of calls) call.release();
      await Promise.all([runtime.sql.end(), identity.sql.end()]);
    },
  };
}

it("explicit cancellation is scoped and idempotent, blocks a late commit, and permits a fresh charged retry", async () => {
  const f = await fixture();
  try {
    const replyKey = randomUUID();
    const started = await f.reply(replyKey);
    expect(started.status).toBe(202);
    const first = await started.json();
    expect(first.can_cancel).toBe(true);
    expect(first.execution_id).toBeTruthy();
    expect(f.calls[0]?.signal?.aborted).toBe(false);
    // Merely returning 202 and querying status never cancels the generator.
    expect((await (await f.request(`/model-operations/${first.operation_id}`)).json()).status).toBe(
      "processing",
    );
    expect(f.calls[0]?.signal?.aborted).toBe(false);
    await f.switchProfile();
    expect(
      (
        await f.request(`/model-operations/${first.operation_id}/cancel`, {
          execution_id: first.execution_id,
        })
      ).status,
    ).toBe(404);
    expect(f.calls[0]?.signal?.aborted).toBe(false);
    f.restoreProfile();
    const cancelKey = randomUUID();
    const stopped = await f.request(
      `/model-operations/${first.operation_id}/cancel`,
      { execution_id: first.execution_id },
      cancelKey,
    );
    expect((await stopped.json()).status).toBe("stopped");
    expect(f.calls[0]?.signal?.aborted).toBe(true);
    const status = await (await f.request(`/model-operations/${first.operation_id}`)).json();
    expect(status.error.code).toBe("PI_USER_ABORTED");
    expect((await f.reply(replyKey)).status).toBe(409);
    expect((await f.reply(randomUUID())).status).toBe(409);
    expect((await (await f.request("/model-status")).json()).operations_used).toBe(1);
    f.calls[0]!.release();
    await expect
      .poll(
        async () =>
          (await (await f.request(`/model-operations/${first.operation_id}`)).json()).stopping,
      )
      .toBe(false);
    const old = await withProfileTransaction(f.db, f.ctx, async (tx) => ({
      turns: await tx
        .select()
        .from(c.explorationTurns)
        .where(eq(c.explorationTurns.explorationId, f.thread.id)),
      sources: await tx.select().from(c.sourceItems).where(eq(c.sourceItems.id, f.thread.sourceId)),
    }));
    expect(old.turns.every((turn) => turn.role === "user")).toBe(true);
    expect(old.sources[0]?.sourceMeta?.reply_status).toBe("pending");
    const retried = await f.reply(replyKey);
    expect(retried.status).toBe(202);
    const second = await retried.json();
    expect(second.operation_id).toBe(first.operation_id);
    expect(second.execution_id).not.toBe(first.execution_id);
    expect((await (await f.request("/model-status")).json()).operations_used).toBe(2);
    // A lost cancellation response replay must never stop the new execution.
    expect(
      (
        await (
          await f.request(
            `/model-operations/${first.operation_id}/cancel`,
            { execution_id: first.execution_id },
            cancelKey,
          )
        ).json()
      ).status,
    ).toBe("stopped");
    expect(f.calls[1]?.signal?.aborted).toBe(false);
    expect(
      (
        await f.request(`/model-operations/${second.operation_id}/cancel`, {
          execution_id: first.execution_id,
        })
      ).status,
    ).toBe(409);
    expect(f.calls[1]?.signal?.aborted).toBe(false);
    f.calls[1]!.release();
    await expect
      .poll(
        async () =>
          (await (await f.request(`/model-operations/${second.operation_id}`)).json()).status,
      )
      .toBe("completed");
    const completed = await f.request(`/model-operations/${second.operation_id}/cancel`, {
      execution_id: second.execution_id,
    });
    expect((await completed.json()).status).toBe("completed");
  } finally {
    await f.close();
  }
});

it("async App replies immediately expose a cancellable execution while default replies still wait", async () => {
  const asynchronous = await fixture(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      asynchronous.reply(randomUUID(), true),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 2000);
      }),
    ]);
    expect(response, "async=1 must not wait for the default synchronous timeout").not.toBeNull();
    expect(response?.status).toBe(202);
    const started = await response!.json();
    expect(started.can_cancel).toBe(true);
    expect(started.execution_id).toBeTruthy();
    expect(asynchronous.calls[0]?.signal?.aborted).toBe(false);
    const stopped = await asynchronous.request(`/model-operations/${started.operation_id}/cancel`, {
      execution_id: started.execution_id,
    });
    expect((await stopped.json()).status).toBe("stopped");
    expect(asynchronous.calls[0]?.signal?.aborted).toBe(true);
    asynchronous.calls[0]!.release();
    await expect
      .poll(
        async () =>
          (await (await asynchronous.request(`/model-operations/${started.operation_id}`)).json())
            .stopping,
      )
      .toBe(false);
  } finally {
    if (timer) clearTimeout(timer);
    await asynchronous.close();
  }
  const synchronous = await fixture(null);
  try {
    const response = synchronous.reply(randomUUID());
    await expect.poll(() => synchronous.calls.length).toBe(1);
    synchronous.calls[0]!.release();
    expect((await response).status).toBe(201);
  } finally {
    await synchronous.close();
  }
});
