import { describe, expect, it } from "vitest";
import { detectCrisis } from "../src/safety/crisis.js";

describe("detectCrisis", () => {
  it("命中危机关键词返回 hit + ruleId + 资源(非阻断,仅提示)", () => {
    const r = detectCrisis("我想结束自己的生命");
    expect(r.hit).toBe(true);
    if (r.hit) {
      expect(r.ruleId).toBeTruthy();
      expect(r.resources.length).toBeGreaterThan(0);
    }
  });
  it("普通文本不命中", () => {
    const r = detectCrisis("今天天气不错,心情平静");
    expect(r.hit).toBe(false);
  });
});
