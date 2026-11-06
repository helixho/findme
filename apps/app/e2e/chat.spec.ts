import { type Page, type Route, expect, test } from "@playwright/test";

const replyText =
  "## 可以先把两件事分开\n\n**兴趣**有依据，投入范围还未知。\n\n- 先谈清交付范围\n- 再决定是否承接\n\n| 已知 | 未知 |\n| --- | --- |\n| 题材有意思 | 修改次数 |\n\n> 这里只针对这次合作。\n\n<script>window.bad = true</script>";
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function setupChat(page: Page, delayed = false, cancellable = false) {
  let source = "";
  let message = "";
  let finished = false;
  let attempts = 0;
  let saves = 0;
  let cancellations = 0;
  let materialReads = 0;
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
      expect(new URL(route.request().url()).searchParams.get("async")).toBe("1");
      attempts++;
      if (delayed && !cancellations)
        return json(
          route,
          {
            status: "processing",
            operation_id: "op",
            ...(cancellable
              ? { execution_id: "00000000-0000-4000-8000-000000000001", can_cancel: true }
              : {}),
          },
          202,
        );
      if (cancellations) {
        finished = true;
        return json(route, { version: 2, reply: replyText, new_information: false });
      }
      if (attempts === 1) return json(route, { error: { code: "PI_MODEL_ERROR" } }, 503);
      finished = true;
      return json(route, { version: 2, reply: replyText, new_information: false });
    }
    if (path === "/api/core/explorations/chat/replies/reply/materials") {
      materialReads++;
      const query = new URL(route.request().url()).searchParams;
      const first = {
        source_id: "00000000-0000-4000-8000-000000000002",
        author_kind: "subject",
        source_kind: "native_event",
        recorded_at: "2026-11-01T10:00:00Z",
        occurred_at: null,
        text: "原话第一段",
        start: 0,
        end: 5,
        next_text_offset: 5,
      };
      const second = {
        ...first,
        source_id: "00000000-0000-4000-8000-000000000003",
        author_kind: "assistant",
        text: "这条是助手旧解释",
        end: 8,
        next_text_offset: null,
      };
      if (query.has("source_id")) {
        expect(query.get("source_id")).toBe(first.source_id);
        expect(query.get("start")).toBe("5");
        return json(route, {
          reply_turn_id: "reply",
          qualification: "reference_range_not_statement_support",
          total_sources: 3,
          unavailable_in_page: 0,
          items: [{ ...first, text: "后续原话", start: 5, end: 9, next_text_offset: null }],
          next_cursor: null,
        });
      }
      return json(route, {
        reply_turn_id: "reply",
        qualification: "reference_range_not_statement_support",
        total_sources: 3,
        unavailable_in_page: query.get("cursor") === "1" ? 1 : 0,
        items: query.get("cursor") === "1" ? [second] : [first],
        next_cursor: query.get("cursor") === "1" ? null : 1,
      });
    }
    if (path === "/api/core/model-operations/op/cancel") {
      expect(route.request().postDataJSON()).toEqual({
        execution_id: "00000000-0000-4000-8000-000000000001",
      });
      cancellations++;
      return json(route, { status: "stopped" });
    }
    if (path === "/api/core/model-operations/op") {
      if (cancellable)
        return json(
          route,
          cancellations
            ? { status: "failed", error: { code: "PI_USER_ABORTED" } }
            : {
                status: "processing",
                execution_id: "00000000-0000-4000-8000-000000000001",
                can_cancel: true,
              },
        );
      finished = true;
      return json(route, { status: "completed" });
    }
    return json(route, { items: [], changes: [] });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "对话", exact: true }).click();
  return {
    releaseSave,
    counts: () => ({ saves, attempts }),
    cancellations: () => cancellations,
    materialReads: () => materialReads,
  };
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

test("explicit stop keeps the saved message retryable without saving it twice", async ({
  page,
}) => {
  const fixture = await setupChat(page, true, true);
  await page.getByLabel("说说一件具体的事").fill("先讨论一下这次分工。");
  await page.getByRole("button", { name: "保存并继续", exact: true }).click();
  fixture.releaseSave();
  await page.getByRole("button", { name: "停止本轮生成", exact: true }).click();
  await expect(
    page.getByText("本轮已停止。消息已保存，可以稍后重新处理。", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".thread-user")).toContainText("先讨论一下这次分工。");
  expect(fixture.cancellations()).toBe(1);
  expect(fixture.counts()).toEqual({ saves: 1, attempts: 1 });
  await page.getByRole("button", { name: "重新处理", exact: true }).click();
  await expect(page.locator(".thread-markdown h2")).toBeVisible();
  expect(fixture.counts()).toEqual({ saves: 1, attempts: 2 });
});

test("leaving a pending conversation does not send a cancellation", async ({ page }) => {
  const fixture = await setupChat(page, true, true);
  await page.getByLabel("说说一件具体的事").fill("先保存这段话，晚些回来继续。");
  await page.getByRole("button", { name: "保存并继续", exact: true }).click();
  fixture.releaseSave();
  await expect(page.getByRole("button", { name: "停止本轮生成", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今天，想从哪里说起？", exact: true }),
  ).toBeVisible();
  expect(fixture.cancellations()).toBe(0);
  expect(fixture.counts()).toEqual({ saves: 1, attempts: 1 });
});

test("reply materials are loaded on demand with bounded source and text paging", async ({
  page,
}) => {
  const fixture = await setupChat(page, true);
  await page.getByLabel("说说一件具体的事").fill("这次先谈清交付范围。");
  await page.getByRole("button", { name: "保存并继续", exact: true }).click();
  fixture.releaseSave();
  await expect(page.locator(".thread-markdown h2")).toBeVisible();
  expect(fixture.materialReads()).toBe(0);
  await expect(page.getByText("原话第一段", { exact: true })).not.toBeVisible();
  await page.getByText("参考材料", { exact: true }).click();
  await expect(
    page.getByText("这是本轮参考的材料范围，并不表示每条都支持回答。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("原话第一段", { exact: true })).toBeVisible();
  expect(fixture.materialReads()).toBe(1);
  await page.getByRole("button", { name: "继续看这条原文", exact: true }).click();
  await expect(page.getByText("原话第一段后续原话", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看更多材料", exact: true }).click();
  await expect(page.getByText("这条是助手旧解释", { exact: true })).toBeVisible();
  await expect(page.getByText(/来源作者：助手/)).toBeVisible();
  await expect(page.getByText("部分材料已不可用，不再展示原文。", { exact: true })).toBeVisible();
  expect(fixture.materialReads()).toBe(3);
});

test("conversation keeps a pending-feedback understanding readable and correctable", async ({
  page,
}) => {
  const fixture = await setupChat(page, true);
  await page.route("**/api/core/explorations/chat", (route) =>
    json(route, {
      id: "chat",
      version: 2,
      status: "active",
      phase: "review",
      experience: { id: "experience", summary: "待核对的讨论", context: {} },
      open_question: null,
      latest_step: null,
      understanding: {
        claims: [],
        gaps: [],
        needs_review: [
          {
            claim_id: "claim",
            claim_revision_id: "revision",
            key: "claim",
            version: 1,
            kind: "value",
            mode: "self_report",
            text: "仍可阅读的待核对认识",
            scope: "本次情境",
            evidence_status: "valid",
            confidence_level: "high",
            confidence_basis: "合成依据",
            pending_feedback: true,
          },
        ],
      },
      pending: { messages: [], corrections: [], updates: [] },
      turns: [
        { id: "u", role: "user", turnKind: "event", content: "我补充了不同情况" },
        { id: "a", role: "assistant", turnKind: "pi_reply", content: "反馈已保留" },
      ],
    }),
  );
  await page.getByLabel("说说一件具体的事").fill("我补充了不同情况");
  await page.getByRole("button", { name: "保存并继续", exact: true }).click();
  fixture.releaseSave();
  await page.locator(".conversation-insights summary").click();
  await expect(
    page.getByRole("listitem").filter({ hasText: "仍可阅读的待核对认识" }),
  ).toBeVisible();
  await expect(
    page.getByText("本条存在待核对反馈，尚未判定原认识错误。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "纠正这条", exact: true })).toBeVisible();
});
