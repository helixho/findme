import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GatewayErrorKind, GatewayRequestError } from "../src/llm/gateway.js";
import { onError } from "../src/middleware/error.js";

afterEach(() => vi.restoreAllMocks());

function request(error: Error) {
  const app = new Hono();
  app.onError(onError);
  app.post("/continue", () => {
    throw error;
  });
  return app.request("/continue", { method: "POST" });
}

describe("model failures at the HTTP boundary", () => {
  it.each([
    ["timeout", 504],
    ["provider", 502],
    ["quota", 503],
    ["rate_limit", 503],
    ["authentication", 503],
    ["model_not_found", 503],
    ["bad_request", 503],
    ["json_parse", 502],
    ["schema_validation", 502],
  ] satisfies [GatewayErrorKind, number][])(
    "reports %s without treating it as an application bug",
    async (kind, status) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const error = new GatewayRequestError(kind);
      // Even an accidentally attached original message/stack must stay private.
      error.message = "private provider body and user content";
      error.stack = "private stack";
      const response = await request(error);
      expect(response.status).toBe(status);
      const payload = await response.json();
      expect(payload).toMatchObject({ error: { code: `LLM_${kind.toUpperCase()}` } });
      expect(payload.error.message).toEqual(expect.any(String));
      expect(JSON.stringify(payload)).not.toContain("private");
      expect(log.mock.calls).toEqual([["gateway_error", kind]]);
    },
  );

  it("keeps unexpected application failures distinct from typed gateway failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await request(new Error("private application detail"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal", message: "服务暂不可用" } });
    expect(log.mock.calls).toEqual([["internal_error", "Error"]]);
  });
});
