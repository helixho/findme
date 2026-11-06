import path from "node:path";
import { expect, it } from "vitest";
import { UnderstandingMethods } from "../src/personal-understanding/methods.js";
import { questionBackgroundSpans } from "../src/personal-understanding/native-conversations.js";
import { prepareReplyMethods } from "../src/personal-understanding/reply-methods.js";

it("loads actual bounded method steps for implicit correction and comparison, not only catalog descriptions", async () => {
  const methods = new UnderstandingMethods(path.resolve("resources/personal-understanding"));
  const prepared = await prepareReplyMethods(methods, "前面那个说法好像不太对，你再看看这两种情况");
  expect(prepared.loadedMethods).toHaveLength(4);
  expect(
    prepared.loadedMethods.every(
      (m) => m.version.length === 64 && m.referenceVersion.length === 64,
    ),
  ).toBe(true);
  expect(prepared.text).toContain("独立事实纠正只修事实");
  expect(prepared.text).toContain("长输入不自动代表本人原创");
  expect(prepared.text).toContain("将获取和后续使用分开");
  expect(prepared.text).not.toContain("## 方法来源");
});
it("keeps exact question and option spans, without old interpretation", () => {
  const text = "你肯定疲劳了。你想选哪个？\nA. 参加\nB. 休息\n这说明你在回避。";
  const spans = questionBackgroundSpans(text);
  expect(spans.map((s) => s.text).join("\n")).not.toMatch(/肯定疲劳|说明你在回避/);
  expect(spans.map((s) => s.text).join("\n")).toContain("B. 休息");
  for (const span of spans) expect(text.slice(span.start, span.end)).toBe(span.text);
});
