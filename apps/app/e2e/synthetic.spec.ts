import { type Page, type Route, expect, test } from "@playwright/test";

// Synthetic transport fixtures exercise the production-built React App, not model quality.
const profiles = [
  { id: "p1", name: "资料一", version: 1, status: "active" },
  { id: "p2", name: "资料二", version: 1, status: "active" },
];
const run = {
  id: "run1",
  domain: "collaboration",
  question: "合成专题",
  version: 1,
  head_version: 0,
  status: "awaiting_input",
  report: null,
  report_revision_id: null,
  report_status: "unavailable",
};
const definition = {
  key: "synthetic",
  title: "合成框架",
  version: "1",
  content_hash: "hash",
  publication_status: "draft",
  disclaimer: "合成访谈，非本人结论",
  domains: [{ key: "one", title: "领域一", min_answers: 1, max_answers: 2 }],
  levels: [],
  phases: [],
  concepts: [],
  source_refs: [],
  boundaries: [],
  creator: "fixture",
  source_status: "synthetic",
};
const frameworkRun = {
  id: "fr1",
  version: 1,
  status: "active",
  definition,
  answers: [],
  result: null,
  open_question: { id: "q1", domain: "one", text: "说说具体经历" },
  updated_at: "2026-01-01T00:00:00Z",
};
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
async function setup(page: Page, custom?: (route: Route, path: string) => Promise<boolean>) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (custom && (await custom(route, path))) return;
    if (path === "/api/auth/get-session")
      return json(route, {
        user: { id: "u1", name: "合成账号", email: "synthetic@validation.invalid" },
      });
    if (path === "/api/profiles") return json(route, profiles);
    if (path === "/api/diagnostics") return json(route, [run]);
    if (path === "/api/diagnostics/run1") return json(route, run);
    if (/\/diagnostics\/run1\/(responses|jobs|history)$/.test(path)) return json(route, []);
    if (path === "/api/data/sources") return json(route, { items: [], next_cursor: null });
    if (path === "/api/blobs") return json(route, { items: [] });
    if (path === "/api/knowledge/topics") return json(route, []);
    if (path.endsWith("/definitions"))
      return json(route, {
        definitions: [{ definition, available: true }],
        runs: [{ ...frameworkRun, title: "合成访谈" }],
        capabilities: { provider_enabled: false, remaining_u4_calls: 0 },
      });
    if (path.endsWith("/runs/fr1")) return json(route, frameworkRun);
    return json(route, { error: { code: `UNEXPECTED_FIXTURE:${path}` } }, 500);
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "FindMe 首页" })).toBeVisible();
}
async function more(page: Page, name: string) {
  await page.getByText("更多理解方式与资料", { exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
}
async function correct(page: Page) {
  await page.getByRole("button", { name: /合成专题/ }).click();
  await page.getByRole("button", { name: "纠正与补充", exact: true }).click();
}

test("response draft survives refresh and report navigation with its bound version", async ({
  page,
}) => {
  await setup(page);
  await correct(page);
  await page.getByRole("textbox").fill("仅在项目开始时成立");
  await page.getByRole("radio", { name: "仅某种情境成立" }).check();
  await page.getByRole("button", { name: "返回当前理解" }).click();
  await correct(page);
  await expect(page.getByRole("textbox")).toHaveValue("仅在项目开始时成立");
  await page.reload();
  await correct(page);
  await expect(page.getByRole("textbox")).toHaveValue("仅在项目开始时成立");
  await expect(page.getByRole("radio", { name: "仅某种情境成立" })).toBeChecked();
});

test("failed response save retries the identical body and idempotency key after refresh", async ({
  page,
}) => {
  const attempts: { key: string | undefined; body: string | null }[] = [];
  await setup(page, async (route, path) => {
    if (path.endsWith("/responses") && route.request().method() === "POST") {
      attempts.push({
        key: route.request().headers()["idempotency-key"],
        body: route.request().postData(),
      });
      await json(route, { error: { code: "TEMPORARY_FAILURE" } }, 503);
      return true;
    }
    return false;
  });
  await correct(page);
  await page.getByRole("textbox").fill("合成纠正");
  await page.getByRole("button", { name: "保存纠正，等待核验" }).click();
  await expect(page.getByRole("alert")).toContainText("TEMPORARY_FAILURE");
  await expect(page.getByRole("textbox")).toHaveValue("合成纠正");
  await page.reload();
  await correct(page);
  await page.getByRole("button", { name: "保存纠正，等待核验" }).click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[0].key).toBeTruthy();
  expect(attempts[1]).toEqual(attempts[0]);
});

test("profile switch isolates drafts", async ({ page }) => {
  await setup(page);
  await correct(page);
  await page.getByRole("textbox").fill("资料一草稿");
  await page.getByText("合成账号", { exact: true }).click();
  await page.getByLabel("切换个人资料").selectOption("p2");
  await expect(page.locator(".fm-account")).not.toHaveAttribute("open", "");
  await correct(page);
  await expect(page.getByRole("textbox")).toHaveValue("");
  await page.getByText("合成账号", { exact: true }).click();
  await page.getByLabel("切换个人资料").selectOption("p1");
  await correct(page);
  await expect(page.getByRole("textbox")).toHaveValue("资料一草稿");
});

test("late profile list response cannot overwrite the selected profile", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let hold = false;
  let started = false;
  let completed = false;
  await setup(page, async (route, path) => {
    if (path === "/api/diagnostics") {
      if (hold && route.request().headers()["x-findme-profile"] === "p1") {
        started = true;
        await held;
        await json(route, [{ ...run, question: "旧资料晚到结果" }]);
        completed = true;
      } else
        await json(
          route,
          route.request().headers()["x-findme-profile"] === "p2"
            ? [{ ...run, question: "资料二当前结果" }]
            : [run],
        );
      return true;
    }
    return false;
  });
  hold = true;
  await page.getByRole("button", { name: "专题阅读", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await page.getByText("合成账号", { exact: true }).click();
  await page.getByLabel("切换个人资料").selectOption("p2");
  await expect(page.getByRole("button", { name: /资料二当前结果/ })).toBeVisible();
  release();
  await expect.poll(() => completed).toBe(true);
  await expect(page.getByRole("button", { name: /资料二当前结果/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /旧资料晚到结果/ })).toHaveCount(0);
});

test("late response from a logged-out account cannot enter the next account", async ({ page }) => {
  let nextAccount = false;
  let hold = false;
  let started = false;
  let completed = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await setup(page, async (route, path) => {
    if (path === "/api/auth/sign-out") {
      nextAccount = true;
      await json(route, {});
      return true;
    }
    if (path === "/api/auth/sign-in/email") {
      await json(route, {});
      return true;
    }
    if (nextAccount && path === "/api/auth/get-session") {
      await json(route, {
        user: { id: "u2", name: "第二合成账号", email: "second@validation.invalid" },
      });
      return true;
    }
    if (path === "/api/profiles") {
      await json(route, nextAccount ? [profiles[1]] : [profiles[0]]);
      return true;
    }
    if (path === "/api/diagnostics") {
      if (hold && route.request().headers()["x-findme-profile"] === "p1") {
        started = true;
        await pending;
        await json(route, [{ ...run, question: "前账号晚到内容" }]);
        completed = true;
      } else
        await json(route, [{ ...run, question: nextAccount ? "新账号当前内容" : run.question }]);
      return true;
    }
    return false;
  });
  hold = true;
  await page.getByRole("button", { name: "专题阅读", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await page.getByText("合成账号", { exact: true }).click();
  await page.getByRole("button", { name: "退出账号" }).click();
  await page.getByLabel("邮箱").fill("second@validation.invalid");
  await page.getByLabel("密码").fill("Synthetic-Password-2026!");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: /新账号当前内容/ })).toBeVisible();
  release();
  await expect.poll(() => completed).toBe(true);
  await expect(page.getByRole("button", { name: /新账号当前内容/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /前账号晚到内容/ })).toHaveCount(0);
});

test("source inventory loads page beyond fifty and preserves earlier sources", async ({ page }) => {
  const source = (n: number) => ({
    id: `s${n}`,
    text: `合成来源第${n}条`,
    hash: `h${n}`,
    status: "active",
    eligibility: "eligible",
    assessment_version: 1,
  });
  await setup(page, async (route, path) => {
    if (path !== "/api/data/sources") return false;
    const next = new URL(route.request().url()).searchParams.get("cursor") === "50";
    await json(route, {
      items: next ? [source(51)] : Array.from({ length: 50 }, (_, i) => source(i + 1)),
      next_cursor: next ? null : 50,
    });
    return true;
  });
  await more(page, "我的资料");
  await expect(page.getByText("合成来源第50条", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "更多来源", exact: true }).click();
  await expect(page.getByText("合成来源第51条", { exact: true })).toBeVisible();
  await expect(page.getByText("合成来源第1条", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "更多来源", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "FindMe 首页" }).click();
  await page.getByRole("button", { name: /合成专题/ }).click();
  await page.getByRole("button", { name: "修订记录", exact: true }).click();
  await page.getByText("继续处理与历史材料", { exact: true }).click();
  await page.getByText("选择历史材料与专题依据", { exact: true }).click();
  await page.getByRole("button", { name: "读取可选资料" }).click();
  await page.getByRole("checkbox", { name: "合成来源第51条", exact: true }).check();
  await expect(page.getByText("可选资料共 51 条 · 已选 1 条", { exact: true })).toBeVisible();
});

test("framework start retry retains its mutation identity", async ({ page }) => {
  const keys: string[] = [];
  await setup(page, async (route, path) => {
    if (path.endsWith("/frameworks/runs") && route.request().method() === "POST") {
      keys.push(route.request().headers()["idempotency-key"]);
      await json(
        route,
        keys.length === 1 ? { error: { code: "PROVIDER_TIMEOUT" } } : frameworkRun,
        keys.length === 1 ? 503 : 201,
      );
      return true;
    }
    return false;
  });
  await more(page, "独立框架");
  await page.getByRole("button", { name: "开始独立访谈" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "开始独立访谈" }).click();
  await expect(page.getByLabel("你的回答")).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

test("framework answer draft and failed-save identity survive navigation and refresh", async ({
  page,
}) => {
  const attempts: string[] = [];
  await setup(page, async (route, path) => {
    if (path.endsWith("/respond")) {
      attempts.push(route.request().headers()["idempotency-key"]);
      await json(route, { error: { code: "PROVIDER_TIMEOUT" } }, 503);
      return true;
    }
    return false;
  });
  await more(page, "独立框架");
  await page.getByRole("button", { name: /合成访谈/ }).click();
  await page.getByLabel("你的回答").fill("合成回答仍应保留");
  await page.getByRole("button", { name: "仅保存回答" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "返回框架列表" }).click();
  await page.getByRole("button", { name: /合成访谈/ }).click();
  await expect(page.getByLabel("你的回答")).toHaveValue("合成回答仍应保留");
  await page.reload();
  await more(page, "独立框架");
  await page.getByRole("button", { name: /合成访谈/ }).click();
  await expect(page.getByLabel("你的回答")).toHaveValue("合成回答仍应保留");
  await page.getByRole("button", { name: "仅保存回答" }).click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[1]).toBe(attempts[0]);
});

test("specialist existing context saves with PATCH and current version", async ({ page }) => {
  let session = {
    id: "ss1",
    version: 3,
    status: "open",
    pathway: "general",
    goal: "原有目标",
    setting: "原有场景",
    difficulty: "",
    environment: "",
    existingSupports: "",
    burden: "",
    selfReportedDiagnosis: null,
    difficultyCategories: [],
    environmentCategories: [],
    scopeFlags: [],
  };
  let body: { goal: string; expected_version: number } | undefined;
  let method: string | undefined;
  await setup(page, async (route, path) => {
    if (path.endsWith("/adhd/sessions")) {
      await json(route, { items: [{ session, proposals: [], trials: [] }] });
      return true;
    }
    if (path.endsWith("/adhd/sessions/ss1")) {
      method = route.request().method();
      body = route.request().postDataJSON();
      session = { ...session, goal: body.goal, version: 4 };
      await json(route, { session });
      return true;
    }
    if (path.endsWith("/content-candidates")) {
      await json(route, { status: "empty", items: [] });
      return true;
    }
    return false;
  });
  await more(page, "具体困难与尝试");
  await page.getByText("已保存的情境 · 1", { exact: true }).click();
  await page.getByRole("button", { name: /原有目标/ }).click();
  await page.getByRole("button", { name: /补全或修改/ }).click();
  await page.getByLabel("你希望这件事有什么变化").fill("修改后的目标");
  await page.getByRole("button", { name: "保存情境补充" }).click();
  await expect.poll(() => method).toBe("PATCH");
  expect(body?.expected_version).toBe(3);
  expect(body).not.toHaveProperty("voluntary");
  await expect(page.getByText("修改后的目标", { exact: true }).first()).toBeVisible();
});

test("invalid current report never renders cached conclusions", async ({ page }) => {
  await setup(page, async (route, path) => {
    if (path === "/api/diagnostics/run1") {
      await json(route, {
        ...run,
        status: "needs_review",
        report_status: "accepted",
        report: { headline: "不应显示的旧结论" },
      });
      return true;
    }
    return false;
  });
  await page.getByRole("button", { name: /合成专题/ }).click();
  await expect(page.getByRole("heading", { name: "当前没有可读的已审核报告" })).toBeVisible();
  await expect(page.getByText("不应显示的旧结论")).toHaveCount(0);
});

for (const path of ["/dogfood", "/diagnostic-preview"])
  test(`production account build gates ${path}`, async ({ page }) => {
    await setup(page);
    await page.goto(path);
    await expect(page.getByRole("button", { name: "FindMe 首页" })).toBeVisible();
    await expect(page.locator(".diagnostic-preview, .dogfood")).toHaveCount(0);
  });

test("conversation saves input, shows the processing outcome and the narrowed prior", async ({
  page,
}) => {
  const posted: Array<{ path: string; body: unknown; key: string | undefined }> = [];
  let continues = 0;
  await setup(page, async (route, path) => {
    const method = route.request().method();
    if (path === "/api/core/model-status") {
      await json(route, {
        enabled: true,
        window_hours: 24,
        operation_limit: 30,
        operations_used: 1,
      });
      return true;
    }
    if (path === "/api/core/understanding") {
      await json(route, { state: "current", claims: [{ claim_id: "c0" }], needs_review: [] });
      return true;
    }
    if (path === "/api/core/explorations" && method === "GET") {
      await json(route, { items: [] });
      return true;
    }
    if (method !== "POST" || !path.startsWith("/api/core/explorations")) return false;
    posted.push({
      path,
      body: route.request().postDataJSON(),
      key: route.request().headers()["idempotency-key"],
    });
    if (path === "/api/core/explorations") {
      await json(
        route,
        {
          exploration: { id: "e1", status: "active", version: 1 },
          experience: { id: "x1", summary: "s" },
          phase: "ready_to_plan",
          saved: true,
        },
        201,
      );
      return true;
    }
    if (path === "/api/core/explorations/e1/continue" && continues++ === 0) {
      await json(route, { error: { code: "CORE_MODEL_LIMIT_REACHED" } }, 503);
      return true;
    }
    if (path === "/api/core/explorations/e1/continue") {
      await json(
        route,
        {
          exploration_id: "e1",
          version: 2,
          phase: "review",
          reading: { current_reading: "合成读数", key_uncertainty: null },
          claims: [
            {
              claim_id: "c1",
              claim_revision_id: "r1",
              key: "k",
              kind: "pattern",
              mode: "observation",
              text: "在熟人小组讨论里，你会直接先说想法。",
              scope: "熟人小组讨论。",
              confidence_level: "medium",
              confidence_basis: "单次合成经历。",
            },
          ],
          gaps: [],
          processing: {
            result: "revised",
            new_claims: 1,
            prior_effects: [
              {
                prior_key: "P1",
                claim_id: "c0",
                from_revision_id: "r0",
                to_revision_id: "r0b",
                effect: "narrows",
                text: "在会议讨论中，你倾向先听完别人再发言。",
                scope: "仅限有上级在场的正式评审会。",
                rationale: "合成理由",
              },
            ],
          },
          prior_understanding: {
            selection_version: "v",
            used: [{ key: "P1" }],
            excluded: [],
            candidate_count: 1,
            omitted_count: 0,
          },
        },
        201,
      );
      return true;
    }
    return false;
  });
  await page.getByRole("button", { name: "对话" }).click();
  await expect(page.getByText(/当前理解中有 1 条有效认识/)).toBeVisible();
  await page.getByLabel("说说一件具体的事").fill("合成经历：熟人讨论我会直接说。");
  await page.getByRole("button", { name: "保存并继续" }).click();
  // Limit reached: the input is reported as saved and can be processed again.
  await expect(page.getByText(/已保存。最近 24 小时的自动处理次数已用完/)).toBeVisible();
  await page.getByRole("button", { name: "重新处理" }).click();
  await expect(page.getByText("这次输入修订了已有认识")).toBeVisible();
  await expect(page.getByText("收窄了适用范围")).toBeVisible();
  await expect(page.getByText("适用范围：仅限有上级在场的正式评审会。")).toBeVisible();
  await expect(page.getByText("在熟人小组讨论里，你会直接先说想法。")).toBeVisible();
  expect(posted.map((item) => item.path)).toEqual([
    "/api/core/explorations",
    "/api/core/explorations/e1/continue",
    "/api/core/explorations/e1/continue",
  ]);
  // The retry of the same continue request reuses its idempotency key.
  expect(posted[2]?.key).toBe(posted[1]?.key);
  expect(posted[1]?.body).toEqual({ expected_version: 1 });
});

test("conversation retries a still-processing run with the same request identity", async ({
  page,
}) => {
  const continues: string[] = [];
  const done = {
    exploration_id: "e2",
    version: 2,
    phase: "review",
    reading: { current_reading: "合成读数", key_uncertainty: null },
    claims: [
      {
        claim_id: "c",
        claim_revision_id: "r",
        key: "k",
        kind: "pattern",
        mode: "observation",
        text: "合成完成的认识。",
        scope: "合成范围。",
        confidence_level: "low",
        confidence_basis: "合成。",
      },
    ],
    gaps: [],
    processing: { result: "added", new_claims: 1, prior_effects: [] },
  };
  await setup(page, async (route, path) => {
    const method = route.request().method();
    if (path === "/api/core/model-status") {
      await json(route, {
        enabled: true,
        window_hours: 24,
        operation_limit: 30,
        operations_used: 0,
      });
      return true;
    }
    if (path === "/api/core/understanding") {
      await json(route, { state: "empty", claims: [], needs_review: [] });
      return true;
    }
    if (path === "/api/core/explorations" && method === "GET") {
      await json(route, { items: [] });
      return true;
    }
    if (path === "/api/core/explorations" && method === "POST") {
      await json(
        route,
        {
          exploration: { id: "e2", status: "active", version: 1 },
          experience: { id: "x", summary: "s" },
          phase: "ready_to_plan",
          saved: true,
        },
        201,
      );
      return true;
    }
    if (path === "/api/core/explorations/e2/continue") {
      continues.push(route.request().headers()["idempotency-key"] ?? "");
      if (continues.length === 1)
        await json(route, { operation_id: "op1", status: "processing" }, 202);
      else await json(route, done, 201);
      return true;
    }
    if (path === "/api/core/explorations/e2" && method === "GET") {
      // Still running when refreshed.
      await json(route, {
        id: "e2",
        version: 1,
        status: "active",
        phase: "ready_to_plan",
        open_question: null,
        latest_step: null,
        understanding: { outcome: null, claims: [], gaps: [], needs_review: [] },
      });
      return true;
    }
    return false;
  });
  await page.getByRole("button", { name: "对话" }).click();
  await page.getByLabel("说说一件具体的事").fill("合成经历。");
  await page.getByRole("button", { name: "保存并继续" }).click();
  await expect(page.getByText(/上一次处理仍在进行/)).toBeVisible();
  await page.getByRole("button", { name: "刷新状态" }).click();
  // Still pending after an unfinished refresh: no new request was made.
  await expect(page.getByText(/仍在处理中/)).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新状态" })).toBeVisible();
  expect(continues).toHaveLength(1);
  await page.getByRole("button", { name: "重新处理" }).click();
  await expect(page.getByText("合成完成的认识。")).toBeVisible();
  expect(continues).toHaveLength(2);
  expect(continues[1]).toBe(continues[0]);
});

test("correcting one claim keeps the other claims of the result", async ({ page }) => {
  const claim = (id: string, text: string) => ({
    claim_id: `c-${id}`,
    claim_revision_id: `r-${id}`,
    key: id,
    kind: "pattern",
    mode: "observation",
    text,
    scope: "合成范围。",
    confidence_level: "low",
    confidence_basis: "合成。",
  });
  let corrected = false;
  await setup(page, async (route, path) => {
    const method = route.request().method();
    if (path === "/api/core/model-status")
      return json(route, {
        enabled: true,
        window_hours: 24,
        operation_limit: 30,
        operations_used: 0,
      }).then(() => true);
    if (path === "/api/core/understanding")
      return json(route, { state: "empty", claims: [], needs_review: [] }).then(() => true);
    if (path === "/api/core/explorations" && method === "GET")
      return json(route, { items: [] }).then(() => true);
    if (path === "/api/core/explorations" && method === "POST")
      return json(
        route,
        {
          exploration: { id: "e3", status: "active", version: 1 },
          experience: { id: "x", summary: "s" },
          phase: "ready_to_plan",
          saved: true,
        },
        201,
      ).then(() => true);
    if (path === "/api/core/explorations/e3/continue")
      return json(
        route,
        {
          exploration_id: "e3",
          version: 2,
          phase: "review",
          reading: { current_reading: "读数", key_uncertainty: null },
          claims: [claim("one", "第一条合成认识。"), claim("two", "第二条合成认识。")],
          gaps: [],
          processing: { result: "added", new_claims: 2, prior_effects: [] },
        },
        201,
      ).then(() => true);
    if (path === "/api/core/explorations/e3/corrections")
      return json(
        route,
        { exploration_id: "e3", version: 3, correction_source_id: "s1", status: "pending" },
        201,
      ).then(() => true);
    if (path === "/api/core/explorations/e3/correct") {
      corrected = true;
      return json(
        route,
        {
          exploration_id: "e3",
          version: 3,
          change_summary: "收窄第一条",
          claims: [claim("one2", "第一条修订后。")],
          gaps: [],
        },
        201,
      ).then(() => true);
    }
    if (path === "/api/core/explorations/e3" && method === "GET")
      return json(route, {
        id: "e3",
        version: 3,
        status: "active",
        phase: "review",
        open_question: null,
        latest_step: {
          sequence: 1,
          decision: "stop",
          current_reading: "读数",
          key_uncertainty: null,
          intent: "i",
          decision_meta: {},
        },
        understanding: {
          outcome: "provisional",
          claims: corrected
            ? [claim("one2", "第一条修订后。"), claim("two", "第二条合成认识。")]
            : [],
          gaps: [],
          needs_review: [],
        },
      }).then(() => true);
    return false;
  });
  await page.getByRole("button", { name: "对话" }).click();
  await page.getByLabel("说说一件具体的事").fill("合成经历。");
  await page.getByRole("button", { name: "保存并继续" }).click();
  await expect(page.getByText("第二条合成认识。")).toBeVisible();
  await page.getByRole("button", { name: "纠正这条" }).first().click();
  await page.getByLabel("说明").fill("只在部分情境成立。");
  await page.getByRole("button", { name: "保存纠正" }).click();
  await expect(page.getByText("已修订：收窄第一条")).toBeVisible();
  await expect(page.getByText("第一条修订后。")).toBeVisible();
  await expect(page.getByText("第二条合成认识。")).toBeVisible();
});

test("a correction still being processed is not reported as done", async ({ page }) => {
  const claim = (id: string, text: string) => ({
    claim_id: `c-${id}`,
    claim_revision_id: `r-${id}`,
    key: id,
    kind: "pattern",
    mode: "observation",
    text,
    scope: "合成范围。",
    confidence_level: "low",
    confidence_basis: "合成。",
  });
  const keys: string[] = [];
  await setup(page, async (route, path) => {
    const method = route.request().method();
    if (path === "/api/core/model-status")
      return json(route, {
        enabled: true,
        window_hours: 24,
        operation_limit: 30,
        operations_used: 0,
      }).then(() => true);
    if (path === "/api/core/understanding")
      return json(route, { state: "empty", claims: [], needs_review: [] }).then(() => true);
    if (path === "/api/core/explorations" && method === "GET")
      return json(route, { items: [] }).then(() => true);
    if (path === "/api/core/explorations" && method === "POST")
      return json(
        route,
        {
          exploration: { id: "e4", status: "active", version: 1 },
          experience: { id: "x", summary: "s" },
          phase: "ready_to_plan",
          saved: true,
        },
        201,
      ).then(() => true);
    if (path === "/api/core/explorations/e4/continue")
      return json(
        route,
        {
          exploration_id: "e4",
          version: 2,
          phase: "review",
          reading: { current_reading: "读数", key_uncertainty: null },
          claims: [claim("one", "第一条合成认识。")],
          gaps: [],
          processing: { result: "added", new_claims: 1, prior_effects: [] },
        },
        201,
      ).then(() => true);
    if (path === "/api/core/explorations/e4/corrections")
      return json(
        route,
        { exploration_id: "e4", version: 3, correction_source_id: "s1", status: "pending" },
        201,
      ).then(() => true);
    if (path === "/api/core/explorations/e4/correct") {
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      return (
        keys.length === 1
          ? json(route, { operation_id: "op", status: "processing" }, 202)
          : json(
              route,
              {
                exploration_id: "e4",
                version: 3,
                change_summary: "收窄第一条",
                claims: [claim("one2", "第一条修订后。")],
                gaps: [],
              },
              201,
            )
      ).then(() => true);
    }
    if (path === "/api/core/explorations/e4" && method === "GET") {
      const done = keys.length > 1;
      return json(route, {
        id: "e4",
        version: 3,
        status: "active",
        phase: "review",
        open_question: null,
        latest_step: null,
        turns: [],
        // Saved but not yet processed until the second /correct completes.
        pending: {
          corrections: done
            ? []
            : [
                {
                  source_id: "s1",
                  note: "只在部分情境成立。",
                  correction_type: "missing_context",
                  claim_revision_ids: ["r-one"],
                  saved_at: "2026-11-05T00:00:00Z",
                },
              ],
          messages: [],
        },
        understanding: {
          outcome: "provisional",
          claims: done ? [claim("one2", "第一条修订后。")] : [claim("one", "第一条合成认识。")],
          gaps: [],
          needs_review: [],
        },
      }).then(() => true);
    }
    return false;
  });
  await page.getByRole("button", { name: "对话" }).click();
  await page.getByLabel("说说一件具体的事").fill("合成经历。");
  await page.getByRole("button", { name: "保存并继续" }).click();
  await page.getByRole("button", { name: "纠正这条" }).click();
  await page.getByLabel("说明").fill("只在部分情境成立。");
  await page.getByRole("button", { name: "保存纠正" }).click();
  await expect(page.getByText(/纠正已保存，仍在处理中/)).toBeVisible();
  await expect(page.getByText(/已修订/)).toHaveCount(0);
  // The saved correction is listed and can be processed again with the same request.
  await expect(page.getByText("已保存、尚未处理的纠正")).toBeVisible();
  await page.getByRole("button", { name: "重新处理" }).click();
  await expect(page.getByText("已修订：收窄第一条")).toBeVisible();
  await expect(page.getByText("第一条修订后。")).toBeVisible();
  expect(keys[1]).toBe(keys[0]);
});
