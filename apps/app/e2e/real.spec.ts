import { type Page, expect, test } from "@playwright/test";

// Real browser HTTP/cookies, createApp and disposable PostgreSQL. Synthetic identity only.
// No route interception and no generated understanding/report fixtures.
// No sign-in: opening the App acts as the instance owner.
async function login(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "FindMe 首页" })).toBeVisible();
}
async function browserApi(page: Page, path: string, body?: unknown, key?: string, method = "POST") {
  return page.evaluate(
    async ({ path, body, key, method }) => {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : method,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
          ...(sessionStorage.getItem("findme_cloud:profile")
            ? { "X-FindMe-Profile": String(sessionStorage.getItem("findme_cloud:profile")) }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body, key, method },
  );
}

test("real account API rejects an untrusted Origin", async ({ page, context }) => {
  await login(page);
  // APIRequestContext shares this browser's cookie jar; Origin is deliberately hostile.
  const response = await context.request.post("/api/profiles", {
    headers: { Origin: "https://untrusted.invalid", "Idempotency-Key": crypto.randomUUID() },
    data: { name: "must-not-exist" },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).error.code).toBe("ACCOUNT_ORIGIN_REQUIRED");
  const list = await browserApi(page, "/api/profiles");
  expect(list.body.some((p: { name: string }) => p.name === "must-not-exist")).toBe(false);
});

test("real response/source save, idempotent replay, version conflict and refresh persistence", async ({
  page,
}) => {
  await login(page);
  const question = `浏览器专题-${crypto.randomUUID()}`;
  await page.getByRole("button", { name: "专题阅读", exact: true }).click();
  await page.locator("summary").filter({ hasText: "创建专题报告" }).click();
  await page.getByLabel("问题", { exact: true }).fill(question);
  await page.getByRole("button", { name: "创建专题，不调用模型" }).click();
  await expect(page.getByRole("heading", { name: "当前没有可读的已审核报告" })).toBeVisible();
  const runs = await browserApi(page, "/api/diagnostics?limit=50");
  const run = runs.body.find((r: { question: string }) => r.question === question);
  expect(run).toBeTruthy();
  await page.getByRole("button", { name: "纠正与补充", exact: true }).click();
  const note = "浏览器合成经历：任务开始之前，我会先核对资料。";
  await page.getByLabel("你知道的情况").fill(note);
  const savedRequest = page.waitForRequest(
    (r) => r.url().endsWith(`/api/diagnostics/${run.id}/responses`) && r.method() === "POST",
  );
  const savedResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/diagnostics/${run.id}/responses`) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存纠正，等待核验" }).click();
  const request = await savedRequest;
  const response = await savedResponse;
  expect(response.status()).toBe(201);
  const saved = await response.json();
  expect(saved.source_id).toBeTruthy();
  expect(saved.analysis_status).toBe("recorded");
  await expect(page.getByText(note, { exact: true })).toBeVisible();
  const payload = request.postDataJSON();
  const key = request.headers()["idempotency-key"];
  expect(key).toBeTruthy();
  const replay = await browserApi(page, `/api/diagnostics/${run.id}/responses`, payload, key);
  expect(replay.status).toBe(201);
  expect(replay.body.id).toBe(saved.id);
  const stale = await browserApi(
    page,
    `/api/diagnostics/${run.id}/responses`,
    payload,
    crypto.randomUUID(),
  );
  expect(stale.status).toBe(409);
  await page.reload();
  await page.getByRole("button", { name: "专题阅读", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(question) }).click();
  await page.getByRole("button", { name: "修订记录", exact: true }).click();
  await expect(page.getByText(note, { exact: true })).toBeVisible();
  const responses = await browserApi(page, `/api/diagnostics/${run.id}/responses`);
  expect(responses.body.filter((r: { id: string }) => r.id === saved.id)).toHaveLength(1);
  const sources = await browserApi(page, "/api/data/sources");
  expect(
    sources.body.items.some(
      (s: { id: string; text: string }) => s.id === saved.source_id && s.text === note,
    ),
  ).toBe(true);
  const read = await browserApi(page, `/api/diagnostics/${run.id}`);
  expect(read.body.version).toBe(2);
  expect(read.body.report).toBeNull();
  const jobs = await browserApi(page, `/api/diagnostics/${run.id}/jobs`);
  expect(jobs.body).toEqual([]);
});
