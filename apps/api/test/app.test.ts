import { createDb, schema } from "@findme/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const url = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:dev@localhost:5434/findme_test";
const { db, sql } = createDb(url);
const app = createApp({ db, auth: { mode: "session", loginPassword: "secret" } });
const staticApp = createApp({ accessToken: "secret", db });
const localApp = createApp({ db });

beforeEach(async () => {
  await db.delete(schema.appSessions);
  await db.delete(schema.asyncTasks);
  await db.delete(schema.lightExtracts); // FK 依赖 raw_records,先删
  await db.delete(schema.rawRecords);
});
afterAll(async () => {
  await sql.end();
});

describe("app", () => {
  it("/health 无需鉴权返回结构化状态", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.checks.db).toBe("ok");
  });

  it("/api/health?strict=1 在数据库与队列健康时通过部署门", async () => {
    const res = await app.request("/api/health?strict=1");
    expect(res.status).toBe(200);
  });

  it("失败任务会让队列健康状态降级", async () => {
    await db.insert(schema.asyncTasks).values({ taskType: "light_extract", status: "failed" });
    const res = await app.request("/health");
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.queue).toBe("degraded");
    expect(body.detail.queue.failed).toBe(1);
  });

  it("登录生成可用 session,登出后失效", async () => {
    const bad = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(bad.status).toBe(401);

    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "secret" }),
    });
    expect(login.status).toBe(200);
    const { token } = await login.json();
    expect(token).toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };
    expect((await app.request("/api/records", { headers: auth })).status).toBe(200);

    await app.request("/api/auth/logout", { method: "POST", headers: auth });
    expect((await app.request("/api/records", { headers: auth })).status).toBe(401);
  });

  it("登录失败超过阈值后限流", async () => {
    const limitedApp = createApp({
      db,
      auth: {
        mode: "session",
        loginPassword: "secret",
        loginRateLimit: { maxFailures: 2, windowSeconds: 60 },
      },
    });
    const badLogin = () =>
      limitedApp.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.10" },
        body: JSON.stringify({ password: "wrong" }),
      });

    expect((await badLogin()).status).toBe(401);
    expect((await badLogin()).status).toBe(401);
    expect((await badLogin()).status).toBe(429);
  });

  it("目标 App 的 mutation 预检允许 Idempotency-Key", async () => {
    const res = await app.request("/api/core/explorations", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.findme.example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.findme.example.com");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "idempotency-key",
    );
  });

  it("/api/* 无 token → 401", async () => {
    const res = await app.request("/api/records");
    expect(res.status).toBe(401);
  });
  it("自用本地模式不要求登录", async () => {
    const res = await localApp.request("/api/records");
    expect(res.status).toBe(200);
  });
  it("测试注入的 static token 仍可用于业务用例", async () => {
    const res = await staticApp.request("/api/records", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });
  it("/api/* 带错误 token → 401", async () => {
    const res = await staticApp.request("/api/records", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });
});
