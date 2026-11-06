import path from "node:path";
import { expect, it } from "vitest";
import { UnderstandingMethods } from "../src/personal-understanding/methods.js";
import { questionBackgroundSpans } from "../src/personal-understanding/native-conversations.js";
import {
  prepareReplyMethods,
  selectReplyMethods,
} from "../src/personal-understanding/reply-methods.js";

it("loads operational bodies and reference boundaries for the current question", async () => {
  const methods = new UnderstandingMethods(path.resolve("resources/personal-understanding"));
  const prepared = await prepareReplyMethods(
    methods,
    "你刚才的解释不准确，为什么一次没开始就能说明我的习惯？",
  );
  expect(prepared.loadedMethods.map((m) => m.name)).toEqual([
    "experience-and-evidence",
    "problem-and-explanations",
    "behavior-and-conditions",
    "understanding-revision",
  ]);
  expect(
    prepared.loadedMethods.every(
      (m) => m.version.length === 64 && m.referenceVersion.length === 64,
    ),
  ).toBe(true);
  expect(prepared.text).toContain("独立事实纠正只修事实");
  expect(prepared.text).toContain("长输入不自动代表本人原创");
  expect(prepared.text).toContain("发言角色、实际作者、对象、立场和事件不是同一个维度");
  expect(prepared.text).toContain("不能用结果差异直接反驳机制判断");
});
it("routes by the question and recent user context, without treating assistant analysis as topic evidence", () => {
  expect(selectReplyMethods("谢谢，先到这里")).toEqual(["experience-and-evidence"]);
  expect(selectReplyMethods("买哪种相机更适合我的用途？")).toContain("decisions-and-acquisition");
  expect(
    selectReplyMethods("这说明什么？", [{ role: "user", content: "我没开始音乐练习。" }]),
  ).toContain("behavior-and-conditions");
  expect(
    selectReplyMethods("我想聊聊", [{ role: "assistant", content: "你总在购买和拖延。" }]),
  ).not.toContain("decisions-and-acquisition");
  expect(selectReplyMethods("我想聊聊")).toContain("discriminating-exploration");
});
it("keeps exact question and option spans, without old interpretation", () => {
  const text = "你肯定疲劳了。你想选哪个？\nA. 参加\nB. 休息\n这说明你在回避。";
  const spans = questionBackgroundSpans(text);
  expect(spans.map((s) => s.text).join("\n")).not.toMatch(/肯定疲劳|说明你在回避/);
  expect(spans.map((s) => s.text).join("\n")).toContain("B. 休息");
  for (const span of spans) expect(text.slice(span.start, span.end)).toBe(span.text);
});
