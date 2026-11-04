import { createHash } from "node:crypto";
import { type MethodName, type UnderstandingMethods, requiredMethods } from "./methods.js";

export type InteractionPreference = {
  id: string;
  version: number;
  text: string;
  sourceId: string;
  explicit: boolean;
  status: "current" | "candidate" | "withdrawn" | "superseded";
  sourceValid: boolean;
  scope:
    | { kind: "conversation"; id: string }
    | { kind: "topic"; id: string }
    | { kind: "task"; id: string }
    | { kind: "default"; explicitlyLongTerm: boolean };
};
export type ContextTask = {
  id: string;
  conversationId: string;
  topicId?: string;
  taskType: string;
  intent: "conversation" | "correction" | "synthesis";
  input: string;
  writesUnderstanding: boolean;
};

/** Only selection, not semantic qualification: the caller supplies authenticated, current source states. */
export function applicablePreferences(
  task: ContextTask,
  preferences: readonly InteractionPreference[],
) {
  return preferences.filter((p) => {
    if (!p.explicit || !p.sourceId || p.status !== "current" || !p.sourceValid) return false;
    switch (p.scope.kind) {
      case "conversation":
        return p.scope.id === task.conversationId;
      case "topic":
        return p.scope.id === task.topicId;
      case "task":
        return p.scope.id === task.taskType;
      case "default":
        return p.scope.explicitlyLongTerm;
    }
  });
}

export async function prepareUnderstandingContext(
  resources: UnderstandingMethods,
  taskInput: ContextTask,
  contextInput: {
    preferences: readonly InteractionPreference[];
    recentMessages: readonly { id: string; role: "user" | "assistant"; text: string }[];
    summaries: readonly {
      id: string;
      text: string;
      sourceIds: readonly string[];
      valid: boolean;
    }[];
    understandingIndex: readonly { id: string; version: number; title: string; status: string }[];
    selectedMethods: readonly MethodName[];
  },
) {
  // Capture before the first await so concurrent input changes cannot enter this task.
  const task = structuredClone(taskInput);
  const input = structuredClone(contextInput);
  const system = await resources.system();
  const catalog = await resources.catalog();
  const names = requiredMethods(task.intent, task.writesUnderstanding, input.selectedMethods);
  const methods = await Promise.all(names.map((name) => resources.load(name)));
  // Sections are kept as data, not concatenated into a system prompt. The AG-03 adapter supplies roles.
  const sections = structuredClone([
    { kind: "preferences", value: applicablePreferences(task, input.preferences) },
    {
      kind: "conversation",
      value: {
        messages: input.recentMessages,
        summaries: input.summaries.filter((s) => s.valid && s.sourceIds.length > 0),
      },
    },
    { kind: "understanding_index", value: input.understandingIndex },
    {
      kind: "current_input",
      value: {
        taskId: task.id,
        conversationId: task.conversationId,
        topicId: task.topicId,
        taskType: task.taskType,
        intent: task.intent,
        text: task.input,
      },
    },
  ]);
  if (Buffer.byteLength(JSON.stringify({ system, catalog, methods, sections })) > 256 * 1024)
    throw new Error("UNDERSTANDING_CONTEXT_TOO_LARGE");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        system: system.version,
        catalog,
        methods: methods.map((m) => ({ name: m.name, version: m.version })),
        sections,
      }),
    )
    .digest("hex");
  return { system, catalog, methods, sections, fingerprint };
}
