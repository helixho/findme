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
  modelRuntime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  archive?: PiSessionArchive;
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
    options.archive ? structuredClone(options.archive.entries) : undefined,
  );
  if (options.archive) {
    if (options.archive.leafId === null) manager.resetLeaf();
    else {
      if (!manager.getEntry(options.archive.leafId)) throw new Error("PI_ARCHIVE_LEAF_MISSING");
      manager.branch(options.archive.leafId);
    }
  }
  let requests = 0;
  let traceError: unknown;
  let turnError: unknown;
  let aborted = false;
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
    prompt: (text: string) =>
      run(async () => {
        await session.prompt(text, { expandPromptTemplates: false });
        const last = session.messages.filter((message) => message.role === "assistant").at(-1);
        if (turnError) throw turnError;
        if (traceError) throw traceError;
        if (aborted || last?.stopReason === "aborted") throw new Error("PI_USER_ABORTED");
        if (last?.stopReason === "error") throw new Error("PI_MODEL_ERROR");
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
