import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describe, expect, it } from "vitest";
import { accountSessionAccess } from "../src/auth/account.js";

describe("account identity survives bounded-body Request replacement", () => {
  const origin = "https://synthetic.invalid";
  function fixture() {
    const access = accountSessionAccess(
      {
        resolve: async (req) => ({
          provider: "synthetic",
          principalId: req.headers.get("X-Synthetic-User") ?? "missing",
          sessionId: "synthetic-session",
          expiresAt: new Date(Date.now() + 60000),
        }),
      },
      [origin],
    );
    const app = new Hono();
    app.use("*", access.middleware);
    app.use("*", bodyLimit({ maxSize: 1024 }));
    app.post("/", async (c) => {
      await c.req.json();
      return c.json(access.principal(c));
    });
    return app;
  }
  it("retains the verified identity after body middleware replaces Request", async () => {
    const response = await fixture().request("/", {
      method: "POST",
      body: JSON.stringify({ note: "synthetic" }),
      headers: { Origin: origin, "content-type": "application/json", "X-Synthetic-User": "a" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "synthetic", principalId: "a" });
  });
  it("does not share identity across simultaneous requests", async () => {
    const app = fixture();
    const results = await Promise.all(
      ["a", "b"].map(async (id) => {
        const response = await app.request("/", {
          method: "POST",
          body: "{}",
          headers: { Origin: origin, "content-type": "application/json", "X-Synthetic-User": id },
        });
        return response.json();
      }),
    );
    expect(results.map((r) => r.principalId)).toEqual(["a", "b"]);
  });
});
