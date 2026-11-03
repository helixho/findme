import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@findme/db", () => ({ createDb: vi.fn() }));
vi.mock("../src/app.js", () => ({ createApp: vi.fn() }));
vi.mock("../src/auth/server.js", () => ({ createAccountAuth: vi.fn() }));
vi.mock("../src/cloud-diagnostic/runtime.js", () => ({ createCloudServices: vi.fn() }));
vi.mock("../src/cloud-diagnostic/blobs.js", () => ({ r2BlobStore: vi.fn() }));
vi.mock("../src/hosted/neon-archive-reader.js", () => ({ NeonArchiveReader: vi.fn() }));
vi.mock("../src/understanding-app/archive-runtime.js", () => ({
  ArchiveUnderstandingRuntime: vi.fn(),
}));
vi.mock("../src/llm/deepdive.js", () => ({ generateDeepDive: vi.fn() }));
vi.mock("../src/llm/extract.js", () => ({ runLightExtract: vi.fn() }));
vi.mock("../src/llm/gateway.js", () => ({ createGateway: vi.fn() }));
vi.mock("../src/llm/profile.js", () => ({ generateProfileSnapshot: vi.fn() }));
vi.mock("../src/tasks/dispatch.js", () => ({ dispatchDueTasks: vi.fn() }));
vi.mock("../src/tasks/queue.js", () => ({ consumeTaskMessage: vi.fn() }));

import { createDb } from "@findme/db";
import { createApp } from "../src/app.js";
import worker, { type FindMeWorkerEnv } from "../src/cloudflare.js";

const fetch = worker.fetch!;
const context = { waitUntil: vi.fn() } as unknown as Parameters<typeof fetch>[2];
function request(path: string, init?: RequestInit) {
  return new Request(`https://findme.example.com${path}`, init) as unknown as Parameters<
    typeof fetch
  >[0];
}
function noDatabase() {
  return {
    get HYPERDRIVE() {
      throw new Error("Non-API requests must not initialize the database");
    },
    get ASSETS() {
      throw new Error("Retired client assets must not be fetched");
    },
  } as unknown as FindMeWorkerEnv;
}

describe("API-only Worker after independent client retirement", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(["/", "/index.html", "/assets/legacy.js", "/old-ui/route"])(
    "returns 404 for %s without any database or retired asset access",
    async (path) => {
      const response = await fetch(request(path), noDatabase(), context);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
      expect(createDb).not.toHaveBeenCalled();
      expect(createApp).not.toHaveBeenCalled();
    },
  );

  it.each(["/health", "/api", "/api/core/understanding"])(
    "keeps the existing API dispatch for %s without an ASSETS binding",
    async (path) => {
      const db = {};
      const apiFetch = vi.fn().mockResolvedValue(new Response("synthetic API", { status: 200 }));
      vi.mocked(createDb).mockReturnValue({ db } as ReturnType<typeof createDb>);
      vi.mocked(createApp).mockReturnValue({ fetch: apiFetch } as unknown as ReturnType<
        typeof createApp
      >);
      const env = {
        HYPERDRIVE: { connectionString: "synthetic-only" },
        FINDME_ACCESS_TOKEN: "synthetic",
      } as FindMeWorkerEnv;
      const incoming = request(path);
      const response = await fetch(incoming, env, context);
      expect(await response.text()).toBe("synthetic API");
      expect(apiFetch).toHaveBeenCalledExactlyOnceWith(incoming);
      expect(createDb).toHaveBeenCalledOnce();
    },
  );

  it("keeps unknown hosts rejected before any runtime access", async () => {
    const incoming = new Request("https://unknown.invalid/api") as unknown as Parameters<
      typeof fetch
    >[0];
    expect((await fetch(incoming, noDatabase(), context)).status).toBe(404);
    expect(createDb).not.toHaveBeenCalled();
  });

  it("keeps authorized internal queue delivery independent of UI and database bindings", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = {
      FINDME_ACCOUNT_MODE: "1",
      CLOUD_QUEUE_DISPATCH_TOKEN: "synthetic",
      FINDME_TASKS: { send },
    } as unknown as FindMeWorkerEnv;
    const message = {
      type: "cloud_diagnostic",
      job_id: "11111111-1111-4111-8111-111111111111",
      tenant_id: "22222222-2222-4222-8222-222222222222",
      subject_id: "33333333-3333-4333-8333-333333333333",
    };
    const response = await fetch(
      request("/internal/cloud-diagnostics/enqueue", {
        method: "POST",
        headers: { authorization: "Bearer synthetic" },
        body: JSON.stringify(message),
      }),
      env,
      context,
    );
    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledExactlyOnceWith(message);
    expect(createDb).not.toHaveBeenCalled();
  });
});
