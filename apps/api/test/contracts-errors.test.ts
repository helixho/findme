import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { CoreError } from "../src/core/errors.js";
import { classifyGlobalErrorCode, globalErrorCatalog } from "../src/middleware/error-catalog.js";
import { onError } from "../src/middleware/error.js";

function oldStatus(code: string) {
  return /DISABLED|UNAVAILABLE|BUDGET|CAP_/.test(code)
    ? 503
    : /REQUIRED|INVALID|TOO_LARGE|BOUND_EXCEEDED/.test(code)
      ? 400
      : 409;
}
function request(error: Error) {
  const app = new Hono();
  app.onError(onError);
  app.get("/", () => {
    throw error;
  });
  return app.request("/");
}

describe("global HTTP error compatibility", () => {
  it.each(Object.entries(globalErrorCatalog))(
    "retains the status and payload for %s",
    async (code, contract) => {
      expect(contract.status).toBe(oldStatus(code));
      expect(classifyGlobalErrorCode(code)).toEqual(contract);
      const response = await request(new Error(code));
      expect(response.status).toBe(contract.status);
      expect(await response.json()).toEqual({ error: { code } });
    },
  );
  it.each([
    ["ACCOUNT_CONTEXT_REQUIRED", "auth"],
    ["PROFILE_NOT_FOUND", "profile"],
    ["PROFILE_CALL_CAP_EXHAUSTED", "budget"],
    ["QUALIFICATION_INPUT_VERSION_CHANGED", "stale"],
    ["QUALIFICATION_INPUT_BOUND_EXCEEDED", "input"],
    ["SOURCE_EXCERPT_NOT_FULL_TEXT", "input"],
  ] as const)("classifies %s by exact contract", (code, category) => {
    expect(classifyGlobalErrorCode(code)?.category).toBe(category);
  });
  it.each([
    ["REPORT_UNAVAILABLE_REQUIRED", 503],
    ["REPORT_BUDGET_INVALID", 503],
    ["REPORT_RECAP_REQUIRED", 503], // historical CAP_ substring, deliberately retained
    ["REPORT_FUTURE_INVALID", 400],
    ["REPORT_FUTURE_STALE", 409],
  ])("retains uncatalogued legacy precedence for %s", async (code, status) => {
    const response = await request(new Error(String(code)));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code } });
  });
  it("uses CoreError status/message/details before the string fallback", async () => {
    const response = await request(
      new CoreError("ACCOUNT_DISABLED", 403, "个人账号当前不可用", { retry: false }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "ACCOUNT_DISABLED", message: "个人账号当前不可用", retry: false },
    });
  });
  it.each([400, 409, 422] as const)("retains typed adapter status %s", async (status) => {
    const response = await request(
      Object.assign(new Error("REPORT_ADAPTER_ERROR"), {
        publicCode: "STALE_REPORT_VERSION",
        publicStatus: status,
      }),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code: "STALE_REPORT_VERSION" } });
  });
  it.each([
    new SyntaxError("private payload"),
    new Error("REPORT_bad"),
    Object.assign(new Error("REPORT_ADAPTER_ERROR"), {
      publicCode: "private/path",
      publicStatus: 200,
    }),
    new Error("private provider failure"),
  ])("rejects malformed or private errors without leaking their text", async (error) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await request(error);
      const invalid = error instanceof SyntaxError;
      expect(response.status).toBe(invalid ? 400 : 500);
      expect(await response.json()).toEqual({
        error: invalid ? { code: "INVALID_INPUT" } : { code: "internal", message: "服务暂不可用" },
      });
    } finally {
      log.mockRestore();
    }
  });
});
