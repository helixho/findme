import { type Page, type Route, expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
});

const nativeURL = "http://127.0.0.1:18774";
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const question = {
  exploration_id: "e1",
  experience_id: "x1",
  version: 2,
  phase: "awaiting_answer",
  reading: { current_reading: "合成阅读", key_uncertainty: null, intent: "合成提问" },
  question: {
    id: "q1",
    question: "当时你在想什么？",
    intent: "确认具体场景",
    quick_options: ["合成选项"],
  },
  question_budget: { asked: 1, default_budget: 3, hard_cap: 5 },
};
async function native(page: Page, custom?: (route: Route, path: string) => Promise<boolean>) {
  const unexpected: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (custom && (await custom(route, path))) return;
    if (path === "/api/understanding") return json(route, { error: { code: "NOT_FOUND" } }, 404);
    if (path === "/api/core/me")
      return json(route, { tenant_id: "fixture", subject_id: "fixture" });
    if (path === "/api/core/understanding")
      return json(route, { state: "empty", claims: [], needs_review: [] });
    if (path === "/api/core/explorations" && route.request().method() === "GET")
      return json(route, { items: [] });
    unexpected.push(`${route.request().method()} ${path}`);
    return json(route, { error: { code: "UNEXPECTED_FIXTURE" } }, 500);
  });
  await page.goto(nativeURL);
  await page.getByLabel("开发访问串").fill("synthetic-maintenance-token");
  await page.getByRole("button", { name: "进入 FindMe" }).click();
  return unexpected;
}

test("native input and answer retries retain bodies, options and mutation identities", async ({
  page,
}) => {
  const starts: { body: unknown; key: string | undefined }[] = [];
  const answers: { body: unknown; key: string | undefined }[] = [];
  const unexpected = await native(page, async (route, path) => {
    const request = route.request();
    if (path === "/api/core/explorations" && request.method() === "POST") {
      starts.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"] });
      if (starts.length === 1) await json(route, { error: { code: "TEMPORARY" } }, 503);
      else await json(route, { exploration: { id: "e1", version: 1 }, saved: true });
      return true;
    }
    if (path === "/api/core/explorations/e1/continue") {
      await json(route, question);
      return true;
    }
    if (path === "/api/core/explorations/e1/respond") {
      answers.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"] });
      await json(route, { error: { code: "TEMPORARY" } }, 503);
      return true;
    }
    return false;
  });
  await page.getByRole("button", { name: "查看全部" }).click();
  await expect(page.getByRole("heading", { name: "当前认识", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await page.getByRole("button", { name: "从一个事件开始" }).click();
  await page.getByRole("textbox").fill("合成事件，重试时保留输入");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(
    page.getByText("暂时没能保存这次探索。你的文字还在页面里，可以稍后再试。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveValue("合成事件，重试时保留输入");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.getByRole("heading", { name: question.question.question })).toBeVisible();
  expect(starts).toHaveLength(2);
  expect(starts[0].body).toEqual({ event: "合成事件，重试时保留输入" });
  expect(starts[0].key).toBeTruthy();
  expect(starts[1]).toEqual(starts[0]);
  await page.getByRole("button", { name: "合成选项", exact: true }).click();
  await page.getByRole("textbox").fill("合成回答草稿");
  await page.getByRole("button", { name: "提交这次回答" }).click();
  await expect(page.getByRole("button", { name: "提交这次回答" })).toBeEnabled();
  await expect(page.getByRole("textbox")).toHaveValue("合成回答草稿");
  await expect(page.getByRole("button", { name: "合成选项", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "提交这次回答" }).click();
  await expect.poll(() => answers.length).toBe(2);
  expect(answers[0].body).toEqual({
    expected_version: 2,
    question_id: "q1",
    answer: "合成回答草稿",
    selected_options: ["合成选项"],
  });
  expect(answers[0].key).toBeTruthy();
  expect(answers[1]).toEqual(answers[0]);
  expect(unexpected).toEqual([]);
});

test("non-404 capability errors do not fall back to native APIs", async ({ page }) => {
  const nativeRequests: string[] = [];
  const unexpected = await native(page, async (route, path) => {
    if (path !== "/api/understanding") {
      nativeRequests.push(path);
      return false;
    }
    await json(route, { error: { code: "SOURCE_UNAVAILABLE" } }, 503);
    return true;
  });
  await expect(
    page.getByText("读取失败：SOURCE_UNAVAILABLE。请核对来源或连接后重试。", { exact: true }),
  ).toBeVisible();
  expect(unexpected).toEqual([]);
  expect(nativeRequests).toEqual([]);
  await expect(page.getByRole("button", { name: "从一个事件开始" })).toHaveCount(0);
});

test("explicit private host keeps understanding navigation and forbids native fallback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("findme_private_understanding_token", "synthetic");
  });
  await page.route(`${nativeURL}/`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        "<head>",
        '<head><meta name="findme-private-host" content="understanding">',
      ),
    });
  });
  const paths: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    paths.push(path);
    if (path !== "/api/understanding") return json(route, { error: { code: "UNEXPECTED" } }, 500);
    return json(route, {
      format: "synthetic",
      baseline_version: "v1",
      input_hash: "synthetic",
      overall: { status: "unavailable", version: "v1", report: null },
      topics: [],
      feedback: [],
      old_dispositions: { version: "v1", status: "partial", report: null },
      frameworks: { human_3: "not_run" },
      scope: {
        cutoff_before: "2026-01-01",
        source_fingerprint: "synthetic",
        exhaustive: false,
        owner_confirmed: false,
      },
      capabilities: {
        native_core: "available",
        provider_enabled: false,
        remaining_calls: 0,
        feedback_actions: [],
        overall: { status: "blocked", action: null, request: null, blocked_reason: null },
      },
    });
  });
  await page.goto(nativeURL);
  await page.getByRole("button", { name: "专题阅读", exact: true }).click();
  await expect(page.getByText("这批材料尚未形成可阅读的专题。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "整体认识", exact: true }).click();
  await expect(page.getByRole("button", { name: "从一个事件开始" })).toHaveCount(0);
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every((path) => path === "/api/understanding")).toBe(true);
});
