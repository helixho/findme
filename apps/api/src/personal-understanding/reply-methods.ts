import type { MethodName, UnderstandingMethods } from "./methods.js";

/** Conservative topic routing; missed methods remain available through read_method.
 * Only recent user turns supply topic context, never assistant interpretations. */
export function selectReplyMethods(
  input: string,
  history: readonly { role?: string; content?: string }[] = [],
): MethodName[] {
  const context = history
    .filter((turn) => turn.role === "user")
    .slice(-3)
    .map((turn) => turn.content ?? "")
    .join("\n");
  const topic = `${context}\n${input}`;
  const names = new Set<MethodName>(["experience-and-evidence"]);
  if (
    /为什么|原因|解释|怎么看|看出|判断|是不是|说明|意味着|怎么想|困惑|分析|调整|反而|总是|一直|习惯|why|pattern|explain/i.test(
      topic,
    )
  ) {
    names.add("problem-and-explanations");
    names.add("behavior-and-conditions");
  }
  if (
    /行动|完成|开始|没做|没去|取消|拖延|截止|期限|报告|工作|任务|执行|行为|打算|计划|做事|deadline|motivat|behavior/i.test(
      topic,
    )
  ) {
    names.add("behavior-and-conditions");
  }
  if (
    /选|比较|购买|买|付费|价格|划算|值得|决定|建议|要不要|取舍|成本|compare|decid|purchas|buy|choose/i.test(
      topic,
    )
  ) {
    names.add("decisions-and-acquisition");
  }
  if (
    /不对|不准确|不是|纠正|修正|改口|撤回|你.*(?:说|判断)|前面.*(?:说|判断)|刚才|仍然成立|核对|补充|correct|retract|you said/i.test(
      input,
    )
  ) {
    names.add("understanding-revision");
  }
  if (/价值观|人生意义|认同什么|向往|自我叙事|values|meaning/i.test(topic)) {
    names.add("needs-values-and-narrative");
  }
  if (/信任|不放心|托付|反复检查|反复确认|委托|trust|delegat/i.test(topic)) {
    names.add("trust-and-verification");
  }
  if (/生活结构|生活重心|人生方向|跨领域|life structure/i.test(topic)) {
    names.add("life-structure-synthesis");
  }
  if (/聊聊|讨论|迷茫|说不清|想不清|帮我想|问我|选项|探索|talk|explor/i.test(input)) {
    names.add("discriminating-exploration");
  }
  return [...names];
}

export async function prepareReplyMethods(
  methods: UnderstandingMethods,
  input: string,
  history: readonly { role?: string; content?: string }[] = [],
) {
  const loaded = await Promise.all(
    selectReplyMethods(input, history).map(async (name) => {
      const [method, reference] = await Promise.all([
        methods.load(name),
        methods.reference(name, "method.md"),
      ]);
      const body = method.text.replace(/^---[\s\S]*?---\s*/, "").trim();
      // References are small and have different heading structures. Retain the
      // whole reference so a source heading cannot erase its operational scope.
      const steps = `${body}\n\n${reference.text}`;
      return { name, version: method.version, referenceVersion: reference.version, steps };
    }),
  );
  return {
    loadedMethods: loaded.map(({ name, version, referenceVersion }) => ({
      name,
      version,
      referenceVersion,
    })),
    text: `以下是本轮按当前问题与近期本人表达载入的方法，按适用条件使用，不要求执行全部步骤或输出报告。未选中的方法仍可按需读取；没有载入不代表相关边界失效。\n${loaded.map((m) => `【${m.name}】\n${m.steps}`).join("\n\n")}\n先回应原问题，区分事实、有限观察和竞争解释。假设须说明支持与未证前提，不因尚不能确定原因就删掉有用的有限观察；也不为交付结论而凑判断。没有能改变判断的问题就结束。`,
  };
}
