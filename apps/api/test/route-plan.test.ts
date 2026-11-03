import type { Db } from "@findme/db";
import { describe, expect, it, vi } from "vitest";
import { type AuthOpts, createApp } from "../src/app.js";
import type { AccountSessionProvider } from "../src/auth/account.js";
import type { CloudServices } from "../src/cloud-diagnostic/runtime.js";
import worker, { type FindMeWorkerEnv } from "../src/cloudflare.js";
import { CoreError } from "../src/core/errors.js";
import type { NativeReportService } from "../src/core/report-bridge.js";
import type { ArchiveUnderstandingRuntime } from "../src/understanding-app/archive-runtime.js";
import { createPrivateCoreReportService } from "../src/understanding-app/core-adapter.js";
import type { PrivateUnderstandingRepository } from "../src/understanding-app/repository.js";

const origin = "https://synthetic.invalid";
const identity = {
  provider: "synthetic",
  principalId: "owner",
  sessionId: "session",
  expiresAt: new Date("2099-01-01"),
};
const sessions: AccountSessionProvider = { resolve: async () => identity };
const account: AuthOpts = { mode: "account", sessions, trustedOrigins: [origin] };
const modes: AuthOpts[] = [
  { mode: "none" },
  { mode: "static", accessToken: "synthetic" },
  { mode: "session", loginPassword: "synthetic" },
  account,
];
function noDatabase() {
  const touched = vi.fn((property: PropertyKey) => {
    throw new Error(`Unexpected database access: ${String(property)}`);
  });
  const db = new Proxy({}, { get: (_target, property) => touched(property) }) as Db;
  return { db, touched };
}
function headers(auth: AuthOpts) {
  return {
    "content-type": "application/json",
    Origin: origin,
    ...(auth.mode === "static" ? { Authorization: "Bearer synthetic" } : {}),
  };
}
const pathMounted = (app: ReturnType<typeof createApp>, path: string) =>
  app.routes.some((route) => route.path === path && route.method !== "ALL");

describe("real createApp route configuration without a database", () => {
  it.each(modes)("mounts the actual $mode route surface", async (auth) => {
    const { db, touched } = noDatabase();
    const app = createApp({ db, auth });
    expect(pathMounted(app, "/api/content")).toBe(true);
    expect(pathMounted(app, "/api/records")).toBe(auth.mode !== "account");
    expect(pathMounted(app, "/api/diagnostics/capabilities")).toBe(auth.mode === "account");
    expect(pathMounted(app, "/api/auth/login")).toBe(auth.mode === "session");
    expect(pathMounted(app, "/api/core/bootstrap")).toBe(auth.mode === "static");
    expect(pathMounted(app, "/api/understanding")).toBe(false);
    for (const path of [
      "/api/profiles",
      "/api/data/sources",
      "/api/knowledge/topics",
      "/api/specialist/adhd/sessions",
    ])
      expect(pathMounted(app, path)).toBe(false);
    const response = await app.request("/api/content", { headers: headers(auth) });
    expect(response.status).toBe(auth.mode === "session" ? 401 : 200);
    expect(touched).not.toHaveBeenCalled();
  });

  it.each(modes)("only account mounts supplied cloud services in $mode", (auth) => {
    const { db, touched } = noDatabase();
    const app = createApp({ db, auth, cloud: {} as CloudServices });
    for (const path of [
      "/api/profiles",
      "/api/data/sources",
      "/api/knowledge/topics",
      "/api/specialist/adhd/sessions",
    ])
      expect(pathMounted(app, path)).toBe(auth.mode === "account");
    expect(touched).not.toHaveBeenCalled();
  });

  it.each(modes.filter((auth) => auth.mode !== "session"))(
    "$mode distinguishes absent endpoints from mounted validation",
    async (auth) => {
      const { db, touched } = noDatabase();
      const app = createApp({ db, auth });
      for (const path of [
        "/api/understanding",
        "/api/profiles",
        "/api/data/sources",
        "/api/knowledge/topics",
        "/api/specialist/adhd/sessions",
      ])
        expect((await app.request(path, { headers: headers(auth) })).status).toBe(404);
      expect(
        (await app.request("/api/diagnostics/capabilities", { headers: headers(auth) })).status,
      ).toBe(auth.mode === "account" ? 200 : 404);
      if (auth.mode === "account") {
        expect((await app.request("/api/records", { headers: headers(auth) })).status).toBe(404);
        expect(
          (
            await app.request("/api/diagnostics", {
              method: "POST",
              headers: headers(auth),
              body: "{}",
            })
          ).status,
        ).toBe(400);
      } else {
        expect(
          (
            await app.request("/api/records", {
              method: "POST",
              headers: headers(auth),
              body: "{}",
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await app.request("/api/core/explorations", {
              method: "POST",
              headers: headers(auth),
              body: "{}",
            })
          ).status,
        ).toBe(400);
      }
      expect(touched).not.toHaveBeenCalled();
    },
  );

  it.each([
    modes[1],
    modes[2],
    { ...account, sessions: { resolve: async () => null } },
  ] as AuthOpts[])("$mode rejects missing credentials before routes or DB", async (auth) => {
    const { db, touched } = noDatabase();
    const response = await createApp({ db, auth }).request("/api/content");
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
    expect(touched).not.toHaveBeenCalled();
  });

  it("account rejects missing origin before session lookup; session outages are 503", async () => {
    const { db, touched } = noDatabase();
    const resolve = vi.fn(async () => {
      throw new Error("private provider detail");
    });
    const app = createApp({ db, auth: { ...account, sessions: { resolve } } });
    const refused = await app.request("/api/diagnostics", { method: "POST", body: "{}" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: { code: "ACCOUNT_ORIGIN_REQUIRED" } });
    expect(resolve).not.toHaveBeenCalled();
    const unavailable = await app.request("/api/content");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: { code: "ACCOUNT_SESSION_UNAVAILABLE" } });
    expect(touched).not.toHaveBeenCalled();
  });

  it("static bootstrap and session login validate before database writes", async () => {
    const { db, touched } = noDatabase();
    const bootstrap = await createApp({ db, auth: modes[1] }).request("/api/core/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(bootstrap.status).toBe(400);
    expect(await bootstrap.json()).toEqual({ error: "invalid_bootstrap_code" });
    const login = createApp({ db, auth: modes[2] });
    expect(
      (
        await login.request("/api/auth/login", {
          method: "POST",
          headers: headers(modes[2]),
          body: "{}",
        })
      ).status,
    ).toBe(400);
    const wrong = await login.request("/api/auth/login", {
      method: "POST",
      headers: headers(modes[2]),
      body: '{"password":"wrong"}',
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid_password" });
    expect(touched).not.toHaveBeenCalled();
  });

  it.each(modes)("checks report/archive compatibility in $mode", (auth) => {
    const { db, touched } = noDatabase();
    const reportService = { sourceLifecycle: true } as NativeReportService;
    const archiveRuntime = {} as ArchiveUnderstandingRuntime;
    const report = () => createApp({ db, auth, reportService });
    const archive = () => createApp({ db, auth, archiveRuntime });
    if (auth.mode === "none") expect(report).toThrow("REPORT_BRIDGE_AUTH_REQUIRED");
    else expect(pathMounted(report(), "/api/understanding")).toBe(true);
    if (auth.mode === "static" || auth.mode === "account")
      expect(pathMounted(archive(), "/api/understanding")).toBe(true);
    else expect(archive).toThrow("ARCHIVE_RUNTIME_AUTH_REQUIRED");
    expect(() => createApp({ db, auth, reportService, archiveRuntime })).toThrow(
      auth.mode === "none" ? "REPORT_BRIDGE_AUTH_REQUIRED" : "ARCHIVE_RUNTIME_AUTH_REQUIRED",
    );
    expect(touched).not.toHaveBeenCalled();
  });

  it("refuses account principal override and a report without lifecycle support", () => {
    const { db, touched } = noDatabase();
    expect(() => createApp({ db, auth: account, corePrincipal: () => identity })).toThrow(
      "ACCOUNT_PRINCIPAL_OVERRIDE_FORBIDDEN",
    );
    expect(() =>
      createApp({ db, auth: modes[1], reportService: {} as NativeReportService }),
    ).toThrow("当前服务未启用原生报告探索");
    expect(touched).not.toHaveBeenCalled();
  });

  it("validates cloud bodies before invoking services or resolving a profile", async () => {
    const { db, touched } = noDatabase();
    const resolve = vi.fn();
    const create = vi.fn();
    const purge = vi.fn();
    const confirm = vi.fn();
    // Service seam only: this does not simulate DB membership or RLS.
    const cloud = {
      profiles: { resolve, create },
      purge: { purge },
      ingest: { commit: confirm },
    } as unknown as CloudServices;
    const app = createApp({ db, auth: account, cloud });
    expect(pathMounted(app, "/api/profiles")).toBe(true);
    expect(pathMounted(app, "/api/knowledge/topics")).toBe(true);
    expect(pathMounted(app, "/api/specialist/adhd/sessions")).toBe(true);
    for (const path of [
      "/api/profiles",
      "/api/data/erase-profile",
      "/api/data/imports/not-an-id/commit",
      "/api/knowledge/topics/process",
      "/api/diagnostics",
    ])
      expect(
        (await app.request(path, { method: "POST", headers: headers(account), body: "{}" })).status,
      ).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(touched).not.toHaveBeenCalled();
  });

  it("propagates profile resolution rejection without reaching repository or database", async () => {
    const { db, touched } = noDatabase();
    // Boundary test of injected profile policy, not a membership/RLS test.
    const resolve = vi.fn(async () => {
      throw new CoreError("DIAGNOSTIC_SCOPE_INVALID", 403, "Profile 不可用");
    });
    const list = vi.fn();
    const cloud = { profiles: { resolve }, repository: { list } } as unknown as CloudServices;
    const response = await createApp({ db, auth: account, cloud }).request("/api/diagnostics", {
      headers: { "X-FindMe-Profile": "synthetic-unavailable-profile" },
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("DIAGNOSTIC_SCOPE_INVALID");
    expect(resolve).toHaveBeenCalledWith(
      { provider: "synthetic", principalId: "owner" },
      "synthetic-unavailable-profile",
    );
    expect(list).not.toHaveBeenCalled();
    expect(touched).not.toHaveBeenCalled();
  });

  it("uses the real report adapter owner guard before private repository access", async () => {
    const { db, touched } = noDatabase();
    const read = vi.fn();
    const repository = {
      options: {
        coreBridge: { owner: { tenantId: "owner", subjectId: "self" }, verifySource: vi.fn() },
      },
      read,
    } as unknown as PrivateUnderstandingRepository;
    const reportService = createPrivateCoreReportService(repository);
    const cloud = {
      profiles: { resolve: async () => ({ tenantId: "other", subjectId: "other" }) },
    } as unknown as CloudServices;
    const response = await createApp({ db, auth: account, cloud, reportService }).request(
      "/api/understanding",
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "REPORT_OWNER_MISMATCH", message: "当前身份无权读取这份私有报告" },
    });
    expect(read).not.toHaveBeenCalled();
    expect(touched).not.toHaveBeenCalled();
  });

  it("archive writes are 403 before owner resolution or storage access", async () => {
    const { db, touched } = noDatabase();
    const response = await createApp({
      db,
      auth: modes[1],
      archiveRuntime: {} as ArchiveUnderstandingRuntime,
    }).request("/api/understanding/feedback", {
      method: "POST",
      headers: headers(modes[1]),
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "ARCHIVE_READ_ONLY" } });
    expect(touched).not.toHaveBeenCalled();
  });

  it.each([undefined, "0", "false", "", "true", " 1", "1 "])(
    "scheduled disabled (%s) never reads bindings",
    async (enabled) => {
      const accessed = vi.fn(() => {
        throw new Error("Scheduled binding accessed while disabled");
      });
      const env = {
        FINDME_SCHEDULED_ENABLED: enabled,
        get HYPERDRIVE() {
          return accessed();
        },
        get FINDME_TASKS() {
          return accessed();
        },
      } as unknown as FindMeWorkerEnv;
      const scheduled = worker.scheduled!;
      await scheduled(
        {} as Parameters<typeof scheduled>[0],
        env,
        {} as Parameters<typeof scheduled>[2],
      );
      expect(accessed).not.toHaveBeenCalled();
    },
  );
});
