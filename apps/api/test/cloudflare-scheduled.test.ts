import { beforeEach, describe, expect, it, vi } from "vitest";

// No driver or real database is loaded by this test.
vi.mock("@findme/db", () => ({ createDb: vi.fn() }));
vi.mock("../src/app.js", () => ({ createApp: vi.fn(() => ({})) }));
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
import worker, { type FindMeWorkerEnv } from "../src/cloudflare.js";
import { dispatchDueTasks } from "../src/tasks/dispatch.js";

const scheduled = worker.scheduled!;
const controller = {} as Parameters<typeof scheduled>[0];
const context = {} as Parameters<typeof scheduled>[2];

describe("scheduled dispatch opt-in", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([undefined, "0", "false", "", "true", " 1", "1 "])(
    "does not touch the database or queue when configured as %s",
    async (value) => {
      const send = vi.fn();
      const env = {
        ...(value === undefined ? {} : { FINDME_SCHEDULED_ENABLED: value }),
        get HYPERDRIVE() {
          throw new Error("Database binding must not be read");
        },
        FINDME_TASKS: { send },
      } as unknown as FindMeWorkerEnv;
      await scheduled(controller, env, context);
      expect(createDb).not.toHaveBeenCalled();
      expect(dispatchDueTasks).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("dispatches existing tasks and awaits queue delivery only when explicitly enabled", async () => {
    const db = {};
    vi.mocked(createDb).mockReturnValue({ db } as ReturnType<typeof createDb>);
    vi.mocked(dispatchDueTasks).mockImplementation(async (_db, send) => {
      await send("synthetic-task");
      return 1;
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const env = {
      FINDME_SCHEDULED_ENABLED: "1",
      HYPERDRIVE: { connectionString: "synthetic-unreachable" },
      FINDME_TASKS: { send },
    } as unknown as FindMeWorkerEnv;
    await scheduled(controller, env, context);
    expect(createDb).toHaveBeenCalledExactlyOnceWith("synthetic-unreachable", {
      max: 3,
      idleTimeout: 30,
      prepare: false,
    });
    expect(dispatchDueTasks).toHaveBeenCalledExactlyOnceWith(db, expect.any(Function));
    expect(send).toHaveBeenCalledExactlyOnceWith({ task_id: "synthetic-task" });
    send.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(scheduled(controller, env, context)).rejects.toThrow("queue unavailable");
  });

  it("preserves the existing account-mode exclusion even when enabled", async () => {
    const env = {
      FINDME_SCHEDULED_ENABLED: "1",
      FINDME_ACCOUNT_MODE: "1",
      get HYPERDRIVE() {
        throw new Error("Database binding must not be read");
      },
    } as unknown as FindMeWorkerEnv;
    await scheduled(controller, env, context);
    expect(createDb).not.toHaveBeenCalled();
    expect(dispatchDueTasks).not.toHaveBeenCalled();
  });
});
