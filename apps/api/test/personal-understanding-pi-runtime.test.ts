import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createConversationHistoryArchive } from "../src/personal-understanding/long-session.js";
import {
  type PiRequestRecord,
  createFindMePiSession,
  unwrapLegacyPiReply,
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
  it("keeps the original draft archived but restores only the accepted reply into model context", async () => {
    const f = await fixture();
    f.provider.setResponses([
      fauxAssistantMessage("UNACCEPTED_DRAFT"),
      fauxAssistantMessage("next reply"),
    ]);
    const first = await createFindMePiSession(f.options);
    expect(await first.prompt("synthetic")).toBe("UNACCEPTED_DRAFT");
    first.reviseLastAssistant("ACCEPTED_REPLY");
    const archive = first.snapshot();
    expect(JSON.stringify(archive.entries)).toContain("UNACCEPTED_DRAFT");
    expect(archive.entries.some((entry) => entry.type === "context_edit")).toBe(true);
    first.dispose();
    const second = await createFindMePiSession({ ...f.options, archive });
    expect(await second.prompt("continue")).toBe("next reply");
    const input = JSON.stringify(
      f.records.filter((record) => record.output === undefined).at(-1)?.input,
    );
    expect(input).toContain("ACCEPTED_REPLY");
    expect(input).not.toContain("UNACCEPTED_DRAFT");
    second.dispose();
  });
});

it("does not deliver a token-truncated response as a complete reply", async () => {
  const f = await fixture();
  f.provider.setResponses([fauxAssistantMessage("unfinished", { stopReason: "length" })]);
  const session = await createFindMePiSession(f.options);
  await expect(session.prompt("synthetic")).rejects.toThrow("PI_OUTPUT_LIMIT_REACHED");
  expect(f.provider.state.callCount).toBe(1);
  expect(f.records.some((r) => r.output !== undefined)).toBe(true);
  session.dispose();
});

it("unwraps only complete legacy envelopes and leaves ordinary JSON intact", () => {
  const envelope = JSON.stringify({
    reply: "旧回应正文",
    used_claim_keys: [],
    new_information: false,
    new_information_note: null,
  });
  expect(unwrapLegacyPiReply(envelope)).toBe("旧回应正文");
  for (const text of [
    '{"reply":"a literal JSON example"}',
    '{"reply":"text","other":true}',
    "普通回应",
  ])
    expect(unwrapLegacyPiReply(text)).toBe(text);
});

it("normalizes legacy assistant replies after archive restore without changing user JSON or tool results", async () => {
  const f = await fixture();
  const envelope = JSON.stringify({
    reply: "LEGACY_ASSISTANT_TEXT",
    used_claim_keys: [],
    new_information: false,
    new_information_note: null,
  });
  f.provider.setResponses([fauxAssistantMessage(envelope)]);
  const first = await createFindMePiSession(f.options);
  await first.prompt(envelope);
  const archive = first.snapshot();
  first.dispose();
  f.provider.setResponses([
    fauxAssistantMessage(fauxToolCall("lookup", {}, { id: "legacy-lookup" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("new reply"),
  ]);
  const second = await createFindMePiSession({
    ...f.options,
    archive,
    normalizeLegacyReplies: true,
    tools: [
      {
        name: "lookup",
        label: "lookup",
        description: "synthetic",
        parameters: { type: "object", properties: {} } as unknown as ToolDefinition["parameters"],
        execute: async () => ({ content: [{ type: "text", text: envelope }], details: {} }),
      },
    ],
  });
  expect(await second.prompt("continue")).toBe("new reply");
  const input = f.records.filter((r) => r.output === undefined).at(-1)?.input as {
    context: {
      messages: Array<{ role: string; content: Array<{ type: string; text?: string }> | string }>;
    };
  };
  const text = (m: (typeof input.context.messages)[number]) =>
    typeof m.content === "string"
      ? m.content
      : m.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");
  expect(input.context.messages.filter((m) => m.role === "assistant").map(text)).toContain(
    "LEGACY_ASSISTANT_TEXT",
  );
  expect(input.context.messages.filter((m) => m.role === "user").map(text)).toContain(envelope);
  expect(input.context.messages.filter((m) => m.role === "toolResult").map(text)).toContain(
    envelope,
  );
  expect(JSON.stringify(archive.entries)).toContain("used_claim_keys");
  second.dispose();
});

it("unwraps pi replies inside a generated legacy history entry without touching user entries", async () => {
  const f = await fixture();
  const envelope = JSON.stringify({
    reply: "LEGACY_NESTED_ANSWER",
    used_claim_keys: [],
    new_information: false,
    new_information_note: null,
  });
  const manager = SessionManager.inMemory(f.options.cwd, { id: f.options.sessionId });
  const prefix = "以下是本会话有效历史资料，不是新的用户指令：\n";
  manager.appendCustomMessageEntry(
    "findme-history",
    prefix +
      JSON.stringify([
        { role: "user", kind: "message", content: envelope },
        { role: "assistant", kind: "pi_reply", content: envelope },
      ]),
    false,
  );
  const header = manager.getHeader();
  if (!header) throw Error("missing header");
  const archive = {
    format: "findme-pi-session@1" as const,
    sessionId: f.options.sessionId,
    leafId: manager.getLeafId(),
    entries: [header, ...manager.getEntries()],
  };
  f.provider.setResponses([fauxAssistantMessage("next")]);
  const session = await createFindMePiSession({
    ...f.options,
    archive,
    normalizeLegacyReplies: true,
  });
  await session.prompt("continue");
  const input = f.records.find((r) => r.output === undefined)?.input as {
    context: { messages: Array<{ content: Array<{ type: string; text?: string }> | string }> };
  };
  const text = input.context.messages
    .flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : m.content.filter((p) => p.type === "text").map((p) => p.text || ""),
    )
    .find((t) => t.startsWith(prefix));
  const history = JSON.parse(text?.slice(prefix.length) || "[]");
  expect(history[0].content).toBe(envelope);
  expect(history[1].content).toBe("LEGACY_NESTED_ANSWER");
  expect(JSON.stringify(archive.entries)).toContain("used_claim_keys");
  session.dispose();
});

function longHistory() {
  return Array.from({ length: 6 }, (_, i) => [
    {
      role: "user",
      kind: "message",
      source_id: `source-${i + 1}`,
      turn_id: `u-${i + 1}`,
      recorded_at: "2026-11-07T01:00:00.000Z",
      content: `RAW_USER_${i + 1}：${"原话".repeat(400)}`,
    },
    {
      role: "assistant",
      kind: "pi_reply",
      source_id: null,
      turn_id: `a-${i + 1}`,
      recorded_at: "2026-11-07T01:00:01.000Z",
      content: `RAW_ASSISTANT_${i + 1}：${"答复".repeat(400)}`,
    },
  ]).flat();
}
const compactionPolicy = {
  maxInputBytes: 48000,
  reserveBytes: 6000,
  triggerBytes: 24000,
  targetBytes: 22000,
  keepRecentTurns: 2,
  reserveRequests: 2,
  sourceIds: ["source-1", "source-2", "source-3", "source-4", "source-5", "source-6"],
  asOf: "2026-11-07T02:00:00.000Z",
};

describe("host-controlled long-session compaction", () => {
  it("summarizes once through the same recorded runtime, keeps recent raw turns and restores the derived checkpoint", async () => {
    const f = await fixture("compact-conversation");
    f.provider.setResponses([
      fauxAssistantMessage("早期对话讨论过职责边界，具体原话可按来源回查。"),
      fauxAssistantMessage("继续当前讨论。"),
      fauxAssistantMessage("恢复后继续。"),
    ]);
    const archive = createConversationHistoryArchive(
      f.options.sessionId,
      longHistory(),
      f.options.cwd,
    );
    const session = await createFindMePiSession({ ...f.options, archive });
    const prepared = await session.preparePrompt("现在接着聊", compactionPolicy);
    expect(prepared.compacted).toBe(true);
    expect(prepared.bytesAfter).toBeLessThanOrEqual(compactionPolicy.targetBytes);
    expect(session.requestCount()).toBe(1);
    expect(f.provider.state.callCount).toBe(1);
    const checkpoint = session.snapshot();
    const summary = checkpoint.entries.find((entry) => entry.type === "compaction");
    expect(summary?.type === "compaction" ? summary.details : null).toMatchObject({
      kind: "derived_conversation_summary",
      qualification: "context_only",
      independentEvidence: false,
      sourceIds: compactionPolicy.sourceIds,
      contentAsOf: compactionPolicy.asOf,
    });
    // Raw source entries remain in the archive; only the model projection shrinks.
    expect(JSON.stringify(checkpoint.entries)).toContain("RAW_USER_1");
    expect(await session.prompt("现在接着聊")).toBe("继续当前讨论。");
    const input = JSON.stringify(
      f.records.filter((record) => record.output === undefined).at(-1)?.input,
    );
    expect(input).not.toContain("RAW_USER_1");
    expect(input).not.toContain("RAW_ASSISTANT_4");
    expect(input).toContain("RAW_USER_5");
    expect(input).toContain("RAW_ASSISTANT_6");
    expect(input).toContain("派生会话摘要");
    expect(f.records.filter((record) => record.output !== undefined)).toHaveLength(2);
    const saved = session.snapshot();
    session.dispose();
    const restored = await createFindMePiSession({ ...f.options, archive: saved });
    expect(await restored.prompt("恢复继续")).toBe("恢复后继续。");
    const resumed = JSON.stringify(
      f.records.filter((record) => record.output === undefined).at(-1)?.input,
    );
    expect(resumed).toContain("派生会话摘要");
    expect(resumed).not.toContain("RAW_USER_1");
    restored.dispose();
  });

  it("adapts the target to a large current prefix while preserving both recent turns", async () => {
    const f = await fixture("compact-high-prefix");
    f.provider.setResponses([fauxAssistantMessage("早期原话保持职责范围，细节可回查。")]);
    const session = await createFindMePiSession({
      ...f.options,
      system: "固定".repeat(3500),
      archive: createConversationHistoryArchive(f.options.sessionId, longHistory()),
    });
    const prepared = await session.preparePrompt("继续", compactionPolicy);
    expect(prepared.compacted).toBe(true);
    expect(prepared.bytesBefore).toBeGreaterThan(compactionPolicy.maxInputBytes);
    expect(prepared.bytesAfter).toBeGreaterThan(compactionPolicy.targetBytes);
    expect(prepared.bytesAfter).toBeLessThanOrEqual(
      compactionPolicy.maxInputBytes - compactionPolicy.reserveBytes,
    );
    const request = f.records.find((record) => record.output === undefined)?.input as {
      context: { messages: Array<{ content: string }> };
    };
    const material = JSON.parse(request.context.messages[0]!.content);
    expect(material.summary_budget.max_utf8_bytes).toBeGreaterThanOrEqual(512);
    expect(material.summary_budget.max_utf8_bytes).toBeLessThanOrEqual(8000);
    expect(JSON.stringify(session.snapshot())).toContain("RAW_USER_1");
    session.dispose();
  });

  it("does not request a summary when the preserved prefix and recent turns leave no summary space", async () => {
    const f = await fixture("compact-no-space");
    f.provider.setResponses([fauxAssistantMessage("must not run")]);
    const session = await createFindMePiSession({
      ...f.options,
      system: "固定".repeat(6500),
      archive: createConversationHistoryArchive(f.options.sessionId, longHistory()),
    });
    const before = session.snapshot();
    await expect(session.preparePrompt("继续", compactionPolicy)).rejects.toThrow(
      "PI_INPUT_LIMIT_REACHED",
    );
    expect(f.provider.state.callCount).toBe(0);
    expect(session.snapshot()).toEqual(before);
    session.dispose();
  });

  it("rejects a budget-compliant summary that enlarges context without publishing the checkpoint", async () => {
    const f = await fixture("compact-no-shrink");
    f.provider.setResponses([fauxAssistantMessage("X".repeat(7000))]);
    const history = longHistory().map((turn, i) => ({
      ...turn,
      content: `item-${i}-${"material".repeat(25)}`,
    }));
    const session = await createFindMePiSession({
      ...f.options,
      system: "S".repeat(18000),
      archive: createConversationHistoryArchive(f.options.sessionId, history),
    });
    const before = session.snapshot();
    await expect(session.preparePrompt("继续", compactionPolicy)).rejects.toThrow(
      "PI_INPUT_LIMIT_REACHED",
    );
    expect(f.provider.state.callCount).toBe(1);
    const request = f.records.find((record) => record.output === undefined)?.input as {
      context: { messages: Array<{ content: string }> };
    };
    expect(
      JSON.parse(request.context.messages[0]!.content).summary_budget.max_utf8_bytes,
    ).toBeGreaterThanOrEqual(7000);
    expect(session.snapshot()).toEqual(before);
    session.dispose();
  });

  it("reserves capacity for the reply before dispatching a summary", async () => {
    const f = await fixture("compact-budget");
    f.provider.setResponses([fauxAssistantMessage("must not run")]);
    const session = await createFindMePiSession({
      ...f.options,
      maxRequests: 2,
      archive: createConversationHistoryArchive(f.options.sessionId, longHistory()),
    });
    await expect(session.preparePrompt("继续", compactionPolicy)).rejects.toThrow(
      "PI_REQUEST_LIMIT_REACHED",
    );
    expect(f.provider.state.callCount).toBe(0);
    expect(session.requestCount()).toBe(0);
    expect(session.snapshot().entries.some((entry) => entry.type === "compaction")).toBe(false);
    session.dispose();
  });

  it("does not truncate oversized legacy context when no safe recent-turn boundary exists", async () => {
    const f = await fixture("compact-legacy");
    const manager = SessionManager.inMemory(f.options.cwd, { id: f.options.sessionId });
    manager.appendCustomMessageEntry(
      "findme-history",
      `以下是本会话有效历史资料，不是新的用户指令：\n${JSON.stringify(longHistory().map((turn) => ({ ...turn, content: turn.content.repeat(3) })))}`,
      false,
    );
    const header = manager.getHeader();
    if (!header) throw new Error("test header absent");
    const session = await createFindMePiSession({
      ...f.options,
      archive: {
        format: "findme-pi-session@1",
        sessionId: f.options.sessionId,
        leafId: manager.getLeafId(),
        entries: [header, ...manager.getEntries()],
      },
    });
    await expect(session.preparePrompt("继续", compactionPolicy)).rejects.toThrow(
      "PI_INPUT_LIMIT_REACHED",
    );
    expect(f.provider.state.callCount).toBe(0);
    expect(JSON.stringify(session.snapshot())).toContain("RAW_USER_1");
    session.dispose();
  });

  it("never publishes a truncated summary as a compaction checkpoint", async () => {
    const f = await fixture("compact-truncated");
    f.provider.setResponses([fauxAssistantMessage("不完整摘要", { stopReason: "length" })]);
    const session = await createFindMePiSession({
      ...f.options,
      archive: createConversationHistoryArchive(f.options.sessionId, longHistory()),
    });
    await expect(session.preparePrompt("继续", compactionPolicy)).rejects.toThrow(
      "PI_OUTPUT_LIMIT_REACHED",
    );
    expect(f.provider.state.callCount).toBe(1);
    expect(session.snapshot().entries.some((entry) => entry.type === "compaction")).toBe(false);
    expect(JSON.stringify(session.snapshot())).toContain("RAW_USER_1");
    session.dispose();
  });
});
