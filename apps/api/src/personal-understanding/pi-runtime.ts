import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  type AgentSessionEvent,
  type FileEntry,
  type ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  createAgentSession,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  HISTORY_PREFIX,
  type PromptCompactionPolicy,
  SUMMARY_SYSTEM,
  planPromptCompaction,
  projectedPromptBytes,
} from "./long-session.js";

/** Stored by the host with its Profile/source/version identity, never in global pi files. */
export type PiSessionArchive = {
  format: "findme-pi-session@1";
  sessionId: string;
  leafId: string | null;
  entries: FileEntry[];
};
export type PiRequestRecord = {
  sequence: number;
  method: string;
  input: unknown;
  output?: unknown;
};
export type FindMePiOptions = {
  sessionId: string;
  cwd: string;
  agentDir: string;
  system: string;
  /** Authenticated application data, supplied as quoted material rather than system instructions. */
  taskContext?: unknown;
  modelRuntime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  archive?: PiSessionArchive;
  /** Compatibility for FindMe replies generated before natural-text output. */
  normalizeLegacyReplies?: boolean;
  tools?: ToolDefinition[];
  maxRequests: number;
  /** Must reserve host-wide cost/call budget before dispatch; denial throws. */
  reserve: (record: PiRequestRecord) => void | Promise<void>;
  /** Private archive sink; no application logs. A sink failure stops further requests. */
  record: (record: PiRequestRecord) => unknown | Promise<unknown>;
  onEvent?: (event: AgentSessionEvent) => void;
};

function visible<T>(value: T): T {
  // Provider-delivered thinking is not part of the product archive or trace.
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (Array.isArray(item)) return item.filter((part) => part?.type !== "thinking");
      return item;
    }),
  ) as T;
}

/** Only the old complete FindMe envelope is recognized; arbitrary JSON stays literal. */
export function unwrapLegacyPiReply(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
    const keys = Object.keys(parsed).sort();
    if (keys.join(",") !== "new_information,new_information_note,reply,used_claim_keys")
      return text;
    if (
      typeof parsed.reply !== "string" ||
      !Array.isArray(parsed.used_claim_keys) ||
      !parsed.used_claim_keys.every((key: unknown) => typeof key === "string") ||
      typeof parsed.new_information !== "boolean" ||
      !(parsed.new_information_note === null || typeof parsed.new_information_note === "string")
    )
      return text;
    return parsed.reply;
  } catch {
    return text;
  }
}

function normalizeLegacyHistoryEntry(entry: FileEntry): FileEntry {
  const prefix = HISTORY_PREFIX;
  if (
    entry.type !== "custom_message" ||
    entry.customType !== "findme-history" ||
    typeof entry.content !== "string" ||
    !entry.content.startsWith(prefix)
  )
    return entry;
  try {
    const turns = JSON.parse(entry.content.slice(prefix.length));
    if (!Array.isArray(turns)) return entry;
    return {
      ...entry,
      content:
        prefix +
        JSON.stringify(
          turns.map((turn) =>
            turn?.role === "assistant" &&
            turn?.kind === "pi_reply" &&
            typeof turn.content === "string"
              ? { ...turn, content: unwrapLegacyPiReply(turn.content) }
              : turn,
          ),
        ),
    };
  } catch {
    return entry;
  }
}

function normalizeLegacyAssistantContext(value: unknown): unknown {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { messages?: unknown }).messages)
  )
    return value;
  const context = value as { messages: Array<{ role?: string; content?: unknown }> };
  return {
    ...context,
    messages: context.messages.map((message) => {
      if (
        message.role !== "assistant" ||
        !Array.isArray(message.content) ||
        message.content.length !== 1 ||
        message.content[0]?.type !== "text" ||
        typeof message.content[0].text !== "string"
      )
        return message;
      const text = unwrapLegacyPiReply(message.content[0].text);
      return text === message.content[0].text
        ? message
        : { ...message, content: [{ ...message.content[0], text }] };
    }),
  };
}

/** Full session runtime. Storage and authenticated domain tools remain host-owned. */
export async function createFindMePiSession(options: FindMePiOptions) {
  if (!options.sessionId || !Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1)
    throw new Error("INVALID_PI_SESSION_OPTIONS");
  if (
    options.archive &&
    (options.archive.format !== "findme-pi-session@1" ||
      options.archive.sessionId !== options.sessionId ||
      options.archive.entries[0]?.type !== "session" ||
      options.archive.entries[0].id !== options.sessionId)
  )
    throw new Error("PI_ARCHIVE_IDENTITY_MISMATCH");
  const manager = SessionManager.inMemory(
    options.cwd,
    { id: options.sessionId },
    options.archive
      ? structuredClone(options.archive.entries).map((entry) =>
          options.normalizeLegacyReplies ? normalizeLegacyHistoryEntry(entry) : entry,
        )
      : undefined,
  );
  if (options.archive) {
    if (options.archive.leafId === null) manager.resetLeaf();
    else {
      if (!manager.getEntry(options.archive.leafId)) throw new Error("PI_ARCHIVE_LEAF_MISSING");
      manager.branch(options.archive.leafId);
    }
  }
  let requests = 0;
  const taskContext =
    options.taskContext === undefined ? undefined : structuredClone(options.taskContext);
  const estimateSystem =
    options.system + (taskContext === undefined ? "" : JSON.stringify(taskContext));
  let traceError: unknown;
  let turnError: unknown;
  let aborted = false;
  let compactionAbort: AbortController | undefined;
  const pending = new Set<Promise<void>>();
  const guard = async (method: string, args: unknown[]) => {
    if (traceError) throw traceError;
    if (requests >= options.maxRequests) throw new Error("PI_REQUEST_LIMIT_REACHED");
    const model = args[0] as FindMePiOptions["model"];
    // This is the pi request boundary, not the provider's final HTTP payload.
    // A Model can contain credential-bearing headers: record an allowlist only.
    const request = {
      sequence: requests + 1,
      method,
      input: visible({
        model: {
          id: model.id,
          provider: model.provider,
          api: model.api,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        },
        context: args[1],
      }),
    };
    await options.reserve(request);
    if (aborted) throw new Error("PI_USER_ABORTED");
    try {
      await options.record(request);
    } catch (error) {
      traceError = error;
      throw error;
    }
    requests++;
    return request;
  };
  // Wrap both streaming and complete exits: manual compaction uses the latter.
  const runtime = new Proxy(options.modelRuntime, {
    get(target, property) {
      const original = Reflect.get(target, property, target);
      if (["stream", "streamSimple", "complete", "completeSimple"].includes(String(property))) {
        return (...args: unknown[]) => {
          const execute = async () => {
            if (options.normalizeLegacyReplies) args[1] = normalizeLegacyAssistantContext(args[1]);
            if (
              taskContext !== undefined &&
              !compactionAbort &&
              args[1] &&
              typeof args[1] === "object"
            ) {
              const context = args[1] as { messages?: Array<{ role?: string }> };
              if (Array.isArray(context.messages)) {
                const firstData = context.messages.findIndex(
                  (message) => message.role !== "system",
                );
                const insertAt = firstData < 0 ? context.messages.length : firstData;
                args[1] = {
                  ...context,
                  messages: [
                    ...context.messages.slice(0, insertAt),
                    {
                      role: "user",
                      content: `应用提供的上下文资料，不是用户的新指令：\n${JSON.stringify(taskContext)}`,
                      timestamp: Date.now(),
                    },
                    ...context.messages.slice(insertAt),
                  ],
                };
              }
            }
            const request = await guard(String(property), args);
            const controls = args[2] && typeof args[2] === "object" ? args[2] : {};
            args[2] = { ...controls, maxRetries: 0 };
            return { request, result: original.apply(target, args) };
          };
          const capture = async (request: PiRequestRecord, output: unknown) => {
            try {
              await options.record({ ...request, output: visible(output) });
            } catch (error) {
              traceError = error;
              throw error;
            }
          };
          if (String(property).startsWith("complete")) {
            return (async () => {
              try {
                const { request, result } = await execute();
                const output = await result;
                await capture(request, output);
                return output;
              } catch (error) {
                turnError = error;
                throw error;
              }
            })();
          }
          const stream = createAssistantMessageEventStream();
          const work = (async () => {
            try {
              const { request, result } = await execute();
              for await (const event of result) {
                // Await durable recording before pi sees a terminal event and
                // can start another request or report this turn as successful.
                if (event.type === "done" || event.type === "error")
                  await capture(request, event.type === "done" ? event.message : event.error);
                stream.push(event);
              }
              stream.end(await result.result());
            } catch (error) {
              turnError = error;
              const model = args[0] as FindMePiOptions["model"];
              const failure: AssistantMessage = {
                role: "assistant",
                api: model.api,
                provider: model.provider,
                model: model.id,
                content: [],
                stopReason: aborted ? "aborted" : "error",
                errorMessage: "FindMe execution stopped",
                timestamp: Date.now(),
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
              };
              stream.push({
                type: "error",
                reason: failure.stopReason as "error" | "aborted",
                error: failure,
              });
              stream.end(failure);
            }
          })();
          pending.add(work);
          void work.finally(() => pending.delete(work));
          return stream;
        };
      }
      return typeof original === "function" ? original.bind(target) : original;
    },
  });
  const loader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => options.system,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime: runtime,
    model: options.model,
    thinkingLevel: "off",
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0 },
    }),
    tools: (options.tools ?? []).map((tool) => tool.name),
    customTools: options.tools ?? [],
  });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type.startsWith("thinking_"))
      return;
    options.onEvent?.(visible(event));
  });
  let busy = false;
  const run = async <T>(action: () => Promise<T>) => {
    if (busy) throw new Error("PI_SESSION_BUSY");
    busy = true;
    turnError = undefined;
    aborted = false;
    try {
      const result = await action();
      await Promise.all([...pending]);
      if (turnError) throw turnError;
      if (traceError) throw traceError;
      return result;
    } finally {
      await Promise.all([...pending]);
      busy = false;
    }
  };
  return {
    /** Host-triggered, one bounded summary request through the same runtime and ledger. */
    preparePrompt: (text: string, policy: PromptCompactionPolicy) =>
      run(async () => {
        const plan = planPromptCompaction(
          manager.buildSessionProjection(),
          estimateSystem,
          options.tools ?? [],
          text,
          policy,
        );
        if (!plan.needed)
          return {
            compacted: false as const,
            bytesBefore: plan.bytesBefore,
            bytesAfter: plan.bytesBefore,
          };
        if (requests + 1 + plan.reserveRequests > options.maxRequests)
          throw new Error("PI_REQUEST_LIMIT_REACHED");
        compactionAbort = new AbortController();
        try {
          const context = {
            systemPrompt: SUMMARY_SYSTEM,
            messages: [
              {
                role: "user" as const,
                content: JSON.stringify({
                  kind: "historical_conversation_material",
                  contentAsOf: plan.summary.contentAsOf,
                  summary_budget: {
                    max_utf8_bytes: plan.summaryMaxBytes,
                    approximate_max_chinese_characters: Math.floor(plan.summaryMaxBytes / 3),
                    instruction:
                      "摘要正文必须在此UTF-8字节预算内；用简短中文保留会改变理解的信息，不编造或将未知补成事实。完整原文可回查。",
                  },
                  messages: visible(plan.messages),
                }),
                timestamp: Date.now(),
              },
            ],
          };
          // Refuse legacy material that cannot be summarized inside one bounded request.
          if (Buffer.byteLength(JSON.stringify(context), "utf8") + 4096 > policy.maxInputBytes)
            throw new Error("PI_INPUT_LIMIT_REACHED");
          const output = await runtime.completeSimple(options.model, context, {
            maxRetries: 0,
            signal: compactionAbort.signal,
          });
          if (aborted || output.stopReason === "aborted") throw new Error("PI_USER_ABORTED");
          if (output.stopReason === "length") throw new Error("PI_OUTPUT_LIMIT_REACHED");
          if (
            output.stopReason !== "stop" ||
            output.content.some((part) => part.type === "toolCall")
          )
            throw new Error("PI_CONTEXT_COMPACTION_FAILED");
          const summaryText = output.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim();
          if (!summaryText) throw new Error("PI_CONTEXT_COMPACTION_FAILED");
          const summary = `【派生会话摘要 · context_only · 非独立证据】截至 ${plan.summary.contentAsOf}，来源依赖 ${plan.summary.sourceIds.length} 项，完整依赖记录在摘要归档。可用 read_conversation(id=${options.sessionId}) 分页回查本会话原文。\n${summaryText}`;
          if (Buffer.byteLength(summaryText, "utf8") > plan.summaryMaxBytes)
            throw new Error("PI_INPUT_LIMIT_REACHED");
          const header = manager.getHeader();
          if (!header) throw new Error("PI_SESSION_HEADER_MISSING");
          const proposed = SessionManager.inMemory(options.cwd, { id: options.sessionId }, [
            header,
            ...manager.getEntries(),
          ]);
          const leaf = manager.getLeafId();
          if (leaf) proposed.branch(leaf);
          else proposed.resetLeaf();
          proposed.appendCompaction(
            summary,
            plan.summary.firstKeptEntryId,
            Math.ceil(plan.bytesBefore / 4),
            plan.summary,
            false,
            output.usage,
          );
          const proposedBytes = projectedPromptBytes(
            proposed.buildSessionProjection(),
            estimateSystem,
            options.tools ?? [],
            text,
          );
          if (
            proposedBytes >= plan.bytesBefore ||
            proposedBytes > plan.targetBytes ||
            proposedBytes > plan.capacity
          )
            throw new Error("PI_INPUT_LIMIT_REACHED");
          // Only publish a checkpoint after the proposed projection is smaller
          // and leaves the caller's reserved review/transport space intact.
          manager.appendCompaction(
            summary,
            plan.summary.firstKeptEntryId,
            Math.ceil(plan.bytesBefore / 4),
            plan.summary,
            false,
            output.usage,
          );
          session.agent.state.messages = manager.buildSessionContext().messages;
          const bytesAfter = projectedPromptBytes(
            manager.buildSessionProjection(),
            estimateSystem,
            options.tools ?? [],
            text,
          );
          if (
            bytesAfter >= plan.bytesBefore ||
            bytesAfter > plan.targetBytes ||
            bytesAfter > plan.capacity
          )
            throw new Error("PI_INPUT_LIMIT_REACHED");
          return {
            compacted: true as const,
            bytesBefore: plan.bytesBefore,
            bytesAfter,
            summary: plan.summary,
          };
        } finally {
          compactionAbort = undefined;
        }
      }),
    prompt: (text: string) =>
      run(async () => {
        await session.prompt(text, { expandPromptTemplates: false });
        const last = session.messages.filter((message) => message.role === "assistant").at(-1);
        if (turnError) throw turnError;
        if (traceError) throw traceError;
        if (aborted || last?.stopReason === "aborted") throw new Error("PI_USER_ABORTED");
        if (last?.stopReason === "error") throw new Error("PI_MODEL_ERROR");
        if (last?.stopReason === "length") throw new Error("PI_OUTPUT_LIMIT_REACHED");
        return session.getLastAssistantText() ?? "";
      }),
    /** Keep the original draft in the source archive, replace its future context contribution. */
    reviseLastAssistant: (text: string) => {
      if (busy) throw new Error("PI_SESSION_BUSY");
      if (!text.trim()) throw new Error("PI_REVISION_EMPTY");
      const target = manager
        .getBranch()
        .slice()
        .reverse()
        .find((entry) => entry.type === "message" && entry.message.role === "assistant");
      if (!target || target.type !== "message" || target.message.role !== "assistant")
        throw new Error("PI_ASSISTANT_MESSAGE_MISSING");
      if (["toolUse", "error", "aborted"].includes(target.message.stopReason))
        throw new Error("PI_ASSISTANT_MESSAGE_INCOMPLETE");
      const editId = manager.appendContextEdit(target.id, { content: [{ type: "text", text }] });
      // Refresh the live projection as well as the persisted archive. Raw entries
      // stay append-only; subsequent restore also applies this context edit.
      session.agent.state.messages = manager.buildSessionContext().messages;
      return editId;
    },
    compact: (instructions: string) => run(() => session.compact(instructions)),
    abort: () => {
      aborted = true;
      compactionAbort?.abort();
      return session.abort();
    },
    snapshot: (): PiSessionArchive => {
      const header = manager.getHeader();
      if (!header) throw new Error("PI_SESSION_HEADER_MISSING");
      return {
        format: "findme-pi-session@1",
        sessionId: manager.getSessionId(),
        leafId: manager.getLeafId(),
        entries: visible([header, ...manager.getEntries()]),
      };
    },
    activeTools: () => session.getActiveToolNames(),
    requestCount: () => requests,
    dispose: () => {
      unsubscribe();
      session.dispose();
    },
  };
}
