import { describe, expect, it } from "vitest";
import { resolveModel, resolveStrategy } from "../src/llm/router.js";

const cfg = { deepseekModel: "cfg-model" }; // B3:型号来自配置,不硬编码

describe("M-X2 router", () => {
  it("route 映射到 provider,型号来自配置", () => {
    expect(resolveModel("dialogue_model", cfg)).toEqual({
      provider: "deepseek",
      model: "cfg-model",
    });
  });
  it("未知 route 回落 default provider", () => {
    expect(resolveModel("unknown", cfg).provider).toBe("deepseek");
  });
  it("strategy 按显式配置优先,缺省 text_parse", () => {
    expect(resolveStrategy("json_mode")).toBe("json_mode");
    expect(resolveStrategy(undefined)).toBe("text_parse");
  });
});
