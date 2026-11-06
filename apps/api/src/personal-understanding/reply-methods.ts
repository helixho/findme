import type { UnderstandingMethods } from "./methods.js";

// This bounded portfolio is selected by the application rather than fragile
// keywords: implicit corrections and comparisons must not miss their method.
const REPLY_METHODS = [
  "experience-and-evidence",
  "discriminating-exploration",
  "understanding-revision",
  "decisions-and-acquisition",
] as const;

export async function prepareReplyMethods(
  methods: UnderstandingMethods,
  _input: string,
  _history: readonly { role?: string; content?: string }[] = [],
) {
  const loaded = await Promise.all(
    REPLY_METHODS.map(async (name) => {
      const [method, reference] = await Promise.all([
        methods.load(name),
        methods.reference(name, "method.md"),
      ]);
      // Runtime steps and stopping conditions are relevant; bibliographies remain
      // available through the on-demand method tool instead of every request.
      const body = method.text.replace(/^---[\s\S]*?---\s*/, "").trim();
      const referenceSteps = reference.text.split(/\n## (?:来源|方法来源)/)[0];
      const steps = `${body}\n\n${referenceSteps}`;
      return { name, version: method.version, referenceVersion: reference.version, steps };
    }),
  );
  return {
    loadedMethods: loaded.map(({ name, version, referenceVersion }) => ({
      name,
      version,
      referenceVersion,
    })),
    text: `以下是本轮实际载入的方法步骤，按其适用条件使用，不要求每次执行全部方法或输出报告。\n${loaded.map((m) => `【${m.name}】\n${m.steps}`).join("\n\n")}\n回应时先给当前问题站得住的判断。方法里的输出用于核对依据，用户可见回应保持自然；没有能改变判断的问题就结束。`,
  };
}
