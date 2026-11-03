export type Provider = "deepseek" | "anthropic" | "ollama";
export type ModelRoute = { provider: Provider; model: string };
export type OutputStrategy = "json_mode" | "tool_call" | "text_parse";
export type ModelConfig = { deepseekModel: string };

// B3:route → provider;型号不在此固化,由 env 配置注入。
const ROUTE_PROVIDER: Record<string, Provider> = {
  default_model: "deepseek",
  dialogue_model: "deepseek",
  extraction_model: "deepseek",
  observation_model: "deepseek",
};

export function resolveModel(route: string, cfg: ModelConfig): ModelRoute {
  const provider = ROUTE_PROVIDER[route] ?? "deepseek";
  // V1 仅 deepseek;型号来自配置(多 Provider 时按 provider 取各自配置)
  return { provider, model: cfg.deepseekModel };
}

// I4:结构化输出策略按 agent 配置;缺省最保守 text_parse
export function resolveStrategy(s: string | undefined): OutputStrategy {
  if (s === "json_mode" || s === "tool_call" || s === "text_parse") return s;
  return "text_parse";
}
