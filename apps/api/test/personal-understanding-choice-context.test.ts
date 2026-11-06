import { describe, expect, it } from "vitest";
import {
  deriveChoiceBindings,
  explicitChoiceLabels,
} from "../src/personal-understanding/choice-context.js";

describe("explicit choice context", () => {
  it("binds a short answer to the exact Markdown question and all options without inventing an interpretation", () => {
    const question =
      "OLD_ANALYSIS。\n\n假如两个安排都可行，你更愿意：\n- **A**：先确认日期\n- **B：** 等资料齐了再决定\n\nAFTER_ANALYSIS。";
    const [binding] = deriveChoiceBindings([
      { id: "question", role: "assistant", content: question },
      { id: "answer", sourceItemId: "answer-source", role: "user", content: " b。 " },
    ]);
    expect(binding).toMatchObject({
      kind: "derived_selection",
      not_spontaneous_quote: true,
      scope: "question_conditions_only",
      question_turn_id: "question",
      answer_turn_id: "answer",
      answer_source_id: "answer-source",
      original_answer: " b。 ",
      selected_labels: ["B"],
    });
    expect(binding?.options).toHaveLength(2);
    expect(binding?.selected_options[0]?.text).toBe("- **B：** 等资料齐了再决定");
    expect(binding?.question_text).toContain("假如两个安排都可行");
    expect(binding?.question_text).not.toContain("OLD_ANALYSIS");
    expect(binding?.question_text).not.toContain("AFTER_ANALYSIS");
    for (const span of binding?.question_spans ?? [])
      expect(question.slice(span.start, span.end)).toBe(span.text);
    for (const span of binding?.selected_options ?? [])
      expect(question.slice(span.start, span.end)).toBe(span.text);
  });

  it("keeps explicit multiple selections and their raw answer rather than replacing them with one option", () => {
    const [binding] = deriveChoiceBindings([
      { id: "q", role: "assistant", content: "你要哪些？\nA. 文字\nB. 直播\nC. 录屏" },
      { id: "a", role: "user", sourceItemId: "multi-source", content: "Ａ＋Ｃ" },
    ]);
    expect(binding?.selected_labels).toEqual(["A", "C"]);
    expect(binding?.selected_options.map((option) => option.text)).toEqual(["A. 文字", "C. 录屏"]);
    expect(binding?.original_answer).toBe("Ａ＋Ｃ");
    expect(binding?.options).toHaveLength(3);
    expect(explicitChoiceLabels("A、A、C")).toEqual(["A", "C"]);
  });

  it("never skips unavailable or intervening turns to bind an answer to an older question", () => {
    const question = { id: "q", role: "assistant", content: "选哪项？\nA. 第一项\nB. 第二项" };
    const answer = { id: "a", role: "user", content: "B" };
    expect(
      deriveChoiceBindings([question, { id: "hidden", role: "assistant", content: "" }, answer]),
    ).toEqual([]);
    expect(
      deriveChoiceBindings([
        question,
        { id: "another", role: "user", content: "补充情况" },
        answer,
      ]),
    ).toEqual([]);
    expect(
      deriveChoiceBindings([
        question,
        { id: "new-q", role: "assistant", content: "现在想聊什么？" },
        answer,
      ]),
    ).toEqual([]);
  });

  it("does not guess uncertain, explanatory, unknown or duplicate-label answers", () => {
    const question = { id: "q", role: "assistant", content: "A. 第一项\nB. 第二项" };
    for (const content of ["A/B", "A或B", "B更多一些", "选B", "不是A，是B", "C", "都不是", "AB"]) {
      expect(deriveChoiceBindings([question, { id: "a", role: "user", content }])).toEqual([]);
    }
    expect(
      deriveChoiceBindings([
        { id: "q", role: "assistant", content: "第一题：\nA. 甲\nB. 乙\n第二题：\nA. 丙\nB. 丁" },
        { id: "a", role: "user", content: "B" },
      ]),
    ).toEqual([]);
  });
});
