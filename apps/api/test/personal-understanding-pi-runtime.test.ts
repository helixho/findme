import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  type PiRequestRecord,
  createFindMePiSession,
} from "../src/personal-understanding/pi-runtime.js";

async function fixture(id = "synthetic-session") {
  const provider = fauxProvider({
    provider: "findme-faux",
    models: [{ id: "test", contextWindow: 100000, maxTokens: 1000 }],
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(provider.provider);
  const records: PiRequestRecord[] = [];
  return {
    provider,
    records,
    options: {
      sessionId: id,
      cwd: "/tmp/findme-pi-synthetic",
      agentDir: "/tmp/findme-pi-synthetic-config",
      system: "你是合成测试助手，仅回答当前问题。",
      modelRuntime: runtime,
      model: provider.getModel(),
      maxRequests: 4,
      reserve: () => {},
      record: (record: PiRequestRecord) => records.push(record),
    },
  };
}

describe("FindMe pi sessions", () => {
  it("uses explicit resources, archives and restores the same conversation without a global session file", async () => {
    const f = await fixture();
    f.provider.setResponses([
      fauxAssistantMessage("合成回复一"),
      fauxAssistantMessage("合成回复二"),
    ]);
    const first = await createFindMePiSession(f.options);
    expect(first.activeTools()).toEqual([]);
    expect(await first.prompt("合成输入一")).toBe("合成回复一");
    const archive = first.snapshot();
    expect(archive.sessionId).toBe(f.options.sessionId);
    first.dispose();
    const second = await createFindMePiSession({ ...f.options, archive });
    expect(await second.prompt("继续")).toBe("合成回复二");
    const input = JSON.stringify(f.records.filter((r) => r.output === undefined).at(-1)?.input);
    expect(input).toContain("合成输入一");
    expect(input).toContain("合成回复一");
    expect(input).toContain(f.options.system);
    expect(input).not.toContain("You are an expert coding assistant");
    second.dispose();
  });

  it("reserves before dispatch and does not retry a denied request", async () => {
    const f = await fixture();
    const session = await createFindMePiSession({
      ...f.options,
      reserve: () => {
        throw new Error("budget denied");
      },
    });
    await expect(session.prompt("synthetic")).rejects.toThrow("budget denied");
    expect(f.provider.state.callCount).toBe(0);
    expect(session.requestCount()).toBe(0);
    expect(
      session.snapshot().entries.some((e) => e.type === "message" && e.message.role === "user"),
    ).toBe(true);
    session.dispose();
  });

  it("rejects an archive from a different session", async () => {
    const f = await fixture();
    const session = await createFindMePiSession(f.options);
    const archive = session.snapshot();
    session.dispose();
    await expect(
      createFindMePiSession({ ...f.options, sessionId: "other", archive }),
    ).rejects.toThrow("IDENTITY_MISMATCH");
  });

  it("keeps concurrent session traces separate even when the model runtime is shared", async () => {
    const f = await fixture("one");
    f.provider.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
    const other: PiRequestRecord[] = [];
    const one = await createFindMePiSession(f.options);
    const two = await createFindMePiSession({
      ...f.options,
      sessionId: "two",
      record: (r) => other.push(r),
    });
    await Promise.all([one.prompt("first-session"), two.prompt("second-session")]);
    expect(JSON.stringify(f.records[0].input)).toContain("first-session");
    expect(JSON.stringify(f.records[0].input)).not.toContain("second-session");
    expect(JSON.stringify(other[0].input)).toContain("second-session");
    expect(one.requestCount()).toBe(1);
    expect(two.requestCount()).toBe(1);
    one.dispose();
    two.dispose();
  });
  it("executes an actual tool round trip and records the tool result in the next request", async () => {
    const f = await fixture();
    f.provider.setResponses([
      fauxAssistantMessage(fauxToolCall("lookup", {}, { id: "lookup-1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("已核对原文"),
    ]);
    let reads = 0;
    const tool: ToolDefinition = {
      name: "lookup",
      label: "查原文",
      description: "Read synthetic source",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      } as unknown as ToolDefinition["parameters"],
      execute: async () => {
        reads++;
        return { content: [{ type: "text", text: "合成证据原文" }], details: {} };
      },
    };
    const session = await createFindMePiSession({ ...f.options, tools: [tool] });
    expect(await session.prompt("查一下原文")).toBe("已核对原文");
    expect(reads).toBe(1);
    expect(session.requestCount()).toBe(2);
    expect(JSON.stringify(f.records.filter((r) => r.output === undefined)[1].input)).toContain(
      "合成证据原文",
    );
    session.dispose();
  });

  it("enforces the hard limit across prompts without hidden retries", async () => {
    const f = await fixture();
    f.provider.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("must not run")]);
    const session = await createFindMePiSession({ ...f.options, maxRequests: 1 });
    await session.prompt("one");
    await expect(session.prompt("two")).rejects.toThrow();
    expect(f.provider.state.callCount).toBe(1);
    expect(session.requestCount()).toBe(1);
    session.dispose();
  });

  it("manual compaction cannot bypass the same request budget", async () => {
    const f = await fixture();
    f.provider.setResponses([
      fauxAssistantMessage("长回复".repeat(200)),
      fauxAssistantMessage("must not run"),
    ]);
    const session = await createFindMePiSession({ ...f.options, maxRequests: 1 });
    await session.prompt("合成输入".repeat(200));
    await expect(session.compact("保留当前问题和纠正")).rejects.toThrow();
    expect(f.provider.state.callCount).toBe(1);
    session.dispose();
  });

  it("fails the turn when the output archive sink fails", async () => {
    const f = await fixture();
    f.provider.setResponses([fauxAssistantMessage("synthetic")]);
    const session = await createFindMePiSession({
      ...f.options,
      record: (r) => {
        if (r.output !== undefined) throw new Error("archive unavailable");
      },
    });
    await expect(session.prompt("synthetic")).rejects.toThrow("archive unavailable");
    expect(f.provider.state.callCount).toBe(1);
    session.dispose();
  });

  it("does not expose credential headers or thinking blocks/events", async () => {
    const f = await fixture();
    f.provider.setResponses([
      fauxAssistantMessage([fauxThinking("PRIVATE_THINKING"), { type: "text", text: "可见回答" }]),
    ]);
    const events: unknown[] = [];
    const session = await createFindMePiSession({
      ...f.options,
      model: { ...f.options.model, headers: { Authorization: "PRIVATE_TOKEN" } },
      onEvent: (event) => events.push(event),
    });
    expect(await session.prompt("synthetic")).toBe("可见回答");
    expect(JSON.stringify(f.records)).not.toContain("PRIVATE_TOKEN");
    expect(JSON.stringify(f.records)).not.toContain("PRIVATE_THINKING");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_THINKING");
    expect(JSON.stringify(session.snapshot())).not.toContain("PRIVATE_THINKING");
    session.dispose();
  });
  it("waits for async reservation and durable output recording before succeeding", async () => {
    const f = await fixture();
    f.provider.setResponses([fauxAssistantMessage("saved")]);
    let releaseGate!: () => void;
    let releaseRecord!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const output = new Promise<void>((resolve) => {
      releaseRecord = resolve;
    });
    const session = await createFindMePiSession({
      ...f.options,
      reserve: () => gate,
      record: (record) => (record.output === undefined ? undefined : output),
    });
    let finished = false;
    const turn = session.prompt("synthetic").then((reply) => {
      finished = true;
      return reply;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.provider.state.callCount).toBe(0);
    releaseGate();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.provider.state.callCount).toBe(1);
    expect(finished).toBe(false);
    releaseRecord();
    expect(await turn).toBe("saved");
    session.dispose();
  });

  it("fails this turn on async recording errors and prevents another provider call", async () => {
    const f = await fixture();
    f.provider.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("must not run")]);
    const session = await createFindMePiSession({
      ...f.options,
      record: async (record) => {
        if (record.output !== undefined) {
          await Promise.resolve();
          throw new Error("async sink failed");
        }
      },
    });
    await expect(session.prompt("one")).rejects.toThrow("async sink failed");
    await expect(session.prompt("two")).rejects.toThrow("async sink failed");
    expect(f.provider.state.callCount).toBe(1);
    session.dispose();
  });

  it("can continue the same session after a user abort", async () => {
    const f = await fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.provider.setResponses([
      async (_context, options) => {
        entered();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
      fauxAssistantMessage("continued"),
    ]);
    const session = await createFindMePiSession(f.options);
    const turn = session.prompt("first");
    const failure = expect(turn).rejects.toThrow("PI_USER_ABORTED");
    await started;
    await session.abort();
    await failure;
    expect(await session.prompt("continue")).toBe("continued");
    expect(session.requestCount()).toBe(2);
    session.dispose();
  });
});
