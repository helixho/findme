import { randomUUID } from "node:crypto";
import type { Db } from "@findme/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { accountSessionAccess } from "../src/auth/account.js";
import { onError } from "../src/middleware/error.js";
import { specialistRoutes } from "../src/routes/specialist.js";

// Only the scope transaction is mocked. HTTP middleware and validators are real.
vi.mock("../src/cloud-diagnostic/scope.js", () => ({
  withProfileTransaction: async (db: Db, _ctx: unknown, work: (db: Db) => unknown) => work(db),
}));
const id = randomUUID();
function fixture(authenticated = true) {
  const touched = vi.fn(() => {
    throw new Error("UNEXPECTED_DATABASE_ACCESS");
  });
  const db = new Proxy({}, { get: () => touched }) as Db;
  const app = new Hono();
  app.onError(onError);
  app.use(
    "*",
    accountSessionAccess(
      {
        resolve: async () =>
          authenticated
            ? {
                provider: "synthetic",
                principalId: "owner",
                sessionId: "session",
                expiresAt: new Date(Date.now() + 60000),
              }
            : null,
      },
      ["http://localhost"],
    ).middleware,
  );
  const routes = specialistRoutes(db, async () => ({
    tenantId: randomUUID(),
    subjectId: randomUUID(),
  }));
  app.route("/", routes);
  const request = (path: string, body?: unknown, method = "POST", headers = {}) =>
    app.request(path, {
      method,
      headers: { Origin: "http://localhost", "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { request, touched, routes };
}
describe("specialist HTTP contracts / synthetic no DB", () => {
  it("registers the actual sixteen method/path pairs", () => {
    const { routes } = fixture();
    const endpoints = routes.routes
      .filter((r) => r.method !== "ALL")
      .map((r) => `${r.method} ${r.path}`);
    expect(new Set(endpoints).size).toBe(16);
    expect(endpoints).toContain("PATCH /adhd/sessions/:sessionId");
  });
  it("requires account authentication before a database operation", async () => {
    const f = fixture(false);
    for (const path of ["/adhd/sessions", `/trials/${id}`, `/adhd/sessions/${id}/proposals`]) {
      expect((await f.request(path, undefined, "GET")).status).toBe(401);
    }
    expect(f.touched).not.toHaveBeenCalled();
  });
  it("rejects invalid IDs and missing/malformed query", async () => {
    const f = fixture();
    for (const path of [
      "/adhd/sessions/no",
      "/trials/no",
      "/adhd/sessions/no/proposals",
      "/adhd/content-candidates",
      "/adhd/content-candidates?session_id=no",
    ]) {
      expect((await f.request(path, undefined, "GET")).status).toBe(400);
    }
    expect(f.touched).not.toHaveBeenCalled();
  });
  it("requires voluntary entry, bounded strict bodies and an idempotency key", async () => {
    const f = fixture();
    for (const body of [
      {},
      { voluntary: false },
      { voluntary: true, diagnosis: true },
      { voluntary: true, goal: "x".repeat(801) },
      { voluntary: true },
    ]) {
      expect((await f.request("/adhd/sessions", body)).status).toBe(400);
    }
    expect(
      (
        await f.request("/adhd/sessions", { voluntary: true }, "POST", {
          "Idempotency-Key": "x".repeat(201),
        })
      ).status,
    ).toBe(400);
    expect(f.touched).not.toHaveBeenCalled();
  });
  it("validates each transition and rejects conclusions from non-execution", async () => {
    const f = fixture();
    for (const path of [
      `/adhd/sessions/${id}/pause`,
      `/adhd/sessions/${id}/resume`,
      `/proposals/${id}/confirm`,
      `/proposals/${id}/pause`,
      `/proposals/${id}/reject`,
      `/trials/${id}/pause`,
      `/trials/${id}/resume`,
      `/trials/${id}/review`,
      `/adhd/sessions/${id}/proposals`,
    ]) {
      expect((await f.request(path, {})).status).toBe(400);
    }
    expect(
      (
        await f.request(`/trials/${id}/review`, {
          expected_version: 1,
          execution: "not_executed",
          outcome: "no_effect",
          continue_trial: false,
        })
      ).status,
    ).toBe(400);
    expect(f.touched).not.toHaveBeenCalled();
  });
  it("returns 400 for malformed JSON through the application error handler", async () => {
    const f = fixture();
    const r = await f.routes.request("/adhd/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(r.status).toBe(400);
  });
});
