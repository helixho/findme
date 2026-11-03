// V1 关键词/正则规则;规则可独立扩充。
const RULES: { id: string; pattern: RegExp }[] = [
  { id: "self_harm_1", pattern: /(结束自己|自杀|不想活|轻生|自残)/ },
];

const RESOURCES = [
  { name: "全国心理援助热线", contact: "010-82951332" },
  { name: "希望24热线", contact: "400-161-9995" },
];

export type CrisisResult =
  | { hit: true; ruleId: string; resources: typeof RESOURCES }
  | { hit: false };

// B3(修订):命中不拦截——调用方照常建 raw_record / async_tasks,附加资源卡片并写 safety_events 元数据
export function detectCrisis(text: string): CrisisResult {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return { hit: true, ruleId: rule.id, resources: RESOURCES };
    }
  }
  return { hit: false };
}
