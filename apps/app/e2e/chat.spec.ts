import { type Page, type Route, expect, test } from "@playwright/test";

const replyText =
  "## 可以先把两件事分开\n\n**兴趣**有依据，投入范围还未知。\n\n- 先谈清交付范围\n- 再决定是否承接\n\n| 已知 | 未知 |\n| --- | --- |\n| 题材有意思 | 修改次数 |\n\n> 这里只针对这次合作。\n\n<script>window.bad = true</script>";
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function setupChat(page: Page, delayed = false) {
  let source = "";
  let message = "";
  let finished = false;
  let attempts = 0;
  let saves = 0;
  let releaseSave: () => void = () => {};
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const view = () => ({
    id: "chat",
    version: finished ? 2 : 1,
    status: "active",
    phase: "review",
    experience: { id: "experience", summary: "周五的合作，要不要接？", context: {} },
    open_question: null,
    latest_step: null,
    understanding: { outcome: null, claims: [], gaps: [], needs_review: [] },
    pending: {
      corrections: [],
      updates: [],
      messages: finished ? [] : [{ source_id: source, message }],
    },
    turns: [
      { id: "user", role: "user", turnKind: "event", content: message },
      ...(finished
        ? [{ id: "reply", role: "assistant", turnKind: "pi_reply", content: replyText }]
        : []),
    ],
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/session") return json(route, { user: { id: "u", name: "合成用户" } });
    if (path === "/api/profiles")
      return json(route, [{ id: "p", name: "合成资料", status: "active", version: 1 }]);
    if (path === "/api/diagnostics") return json(route, []);
    if (path === "/api/core/model-status")
      return json(route, {
        enabled: true,
        window_hours: 24,
        operations_used: 0,
        operation_limit: 20,
      });
    if (path === "/api/core/understanding")
      return json(route, { state: "empty", claims: [], needs_review: [], open: [], changes: [] });
    if (path === "/api/core/understanding/changes") return json(route, { changes: [] });
    if (path === "/api/core/explorations" && method === "GET") return json(route, { items: [] });
    if (path === "/api/core/explorations" && method === "POST") {
      saves++;
      message = route.request().postDataJSON().event;
      source = "source";
      await saveGate;
      return json(
        route,
        {
          exploration: { id: "chat", version: 1, status: "active" },
          event_source_id: source,
          saved: true,
          phase: "ready_to_plan",
        },
        201,
      );
    }
    if (path === "/api/core/explorations/chat") return json(route, view());
    if (path === "/api/core/explorations/chat/reply") {
      attempts++;
      if (delayed) return json(route, { status: "processing", operation_id: "op" }, 202);
      if (attempts === 1) return json(route, { error: { code: "PI_MODEL_ERROR" } }, 503);
      finished = true;
      return json(route, { version: 2, reply: replyText, new_information: false });
    }
    if (path === "/api/core/model-operations/op") {
      finished = true;
      return json(route, { status: "completed" });
    }
    return json(route, { items: [], changes: [] });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "对话", exact: true }).click();
  return { releaseSave, counts: () => ({ saves, attempts }) };
}

test("chat shows the saving message, retries its saved input, and renders a readable safe reply", async ({
  page,
}, info) => {
  const fixture = await setupChat(page);
  await page
    .getByLabel("说说一件具体的事")
    .fill("题材有意思，但修改次数没谈清楚。我想接又有点担心。");
  await page.getByRole("button", { name: "保存并继续", exact: true }).click();
  await expect(page.locator(".thread-user")).toContainText("题材有意思");
  await expect(page.getByText("正在保存……", { exact: true })).toBeVisible();
  fixture.releaseSave();
  await expect(page.getByText(/这条消息已保存，还没有回应/)).toBeVisible();
  await page.getByRole("button", { name: "重新处理", exact: true }).click();
  await expect(page.locator(".thread-markdown h2")).toHaveText("可以先把两件事分开");
  await expect(page.locator(".thread-markdown li")).toHaveCount(2);
  await expect(page.locator(".thread-markdown table")).toBeVisible();
  await expect(page.locator(".thread-markdown script")).toHaveCount(0);
  await expect(page.getByText("目前没有形成认识。")).toHaveCount(0);
  expect(fixture.counts()).toEqual({ saves: 1, attempts: 2 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/findme-chat-${info.project.name}.png`, fullPage: true });
});

test("a 202 reply is polled with GET and published without another save or generation", async ({
  page,
}) => {
  const fixture = await setupChat(page, true);
  await page.getByLabel("说说一件具体的事").fill("先谈清范围，再考虑接项目。");
  await page.getByRole("button", { name: "保存并继续", exact: true }).click();
  fixture.releaseSave();
  await expect(page.locator(".thread-markdown h2")).toBeVisible();
  expect(fixture.counts()).toEqual({ saves: 1, attempts: 1 });
});

test("home sends its draft once into the conversation", async ({ page }, info) => {
  const fixture = await setupChat(page, true);
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await page.getByLabel("聊件新的", { exact: true }).fill("先商量一下这次合作的范围。");
  await page.screenshot({ path: `/tmp/findme-home-${info.project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: "发送 ↑", exact: true }).click();
  await expect(page.locator(".thread-user")).toContainText("先商量一下这次合作的范围。");
  fixture.releaseSave();
  await expect(page.locator(".thread-markdown h2")).toBeVisible();
  expect(fixture.counts()).toEqual({ saves: 1, attempts: 1 });
});
