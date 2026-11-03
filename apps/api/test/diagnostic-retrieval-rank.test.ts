import { describe, expect, it } from "vitest";
import {
  informativeTerms,
  lexicalScores,
  relevanceFirstOrder,
} from "../src/diagnostic-reasoning/ranking.js";

describe("relevance before decorative diversity", () => {
  it("does not rank generic question boilerplate as substantive matching", () => {
    const rows = [
      { id: "noise", quote: "现在还有哪些问题需要分析？这些要求是什么？" },
      { id: "target", quote: "未经授权不能使用工具，范围确认后可以自主推进。" },
    ];
    const scores = lexicalScores("现在 AI 执行自主、权限授权、确认之间有哪些要求？", rows);
    expect(scores.get("noise")?.score).toBe(0);
    expect(scores.get("target")?.score).toBeGreaterThan(0);
    expect(informativeTerms("WHAT ARE THESE 问题有哪些").has("哪些")).toBe(false);
  });
  it("values informative terms over terms repeated in every source", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: `row-${i}`, quote: "执行方案检查" }));
    rows.push({ id: "specific", quote: "执行授权边界" });
    const scores = lexicalScores("执行授权边界", rows);
    expect(scores.get("specific")?.score).toBeGreaterThan(scores.get("row-0")?.score ?? 0);
  });
  it("does not promote a weak new group over strong same-group evidence", () => {
    const row = (id: string, score: number, group: string) => ({
      id,
      score,
      quote: "授权边界",
      use: "personal_expression",
      source: { group_id: group, session_id: group },
    });
    expect(
      relevanceFirstOrder(
        [row("a", 10, "same"), row("b", 9, "same"), row("noise", 1, "new")],
        3,
      ).map((r) => r.id),
    ).toEqual(["a", "b"]);
  });
  it("retains a relevant contrast and does not reward negation without relevance", () => {
    const source = { group_id: "g", session_id: "s" };
    const rows = [
      { id: "a", score: 10, quote: "可以自主执行", use: "personal_expression", source },
      { id: "b", score: 9, quote: "但是越出授权范围需要确认", use: "personal_expression", source },
      { id: "noise", score: 0, quote: "但是不喜欢这个天气", use: "context", source },
    ];
    expect(relevanceFirstOrder(rows, 3).map((r) => r.id)).toEqual(["a", "b"]);
  });
});
