import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { human3Draft } from "../src/framework-runtime/definitions/human3-draft.js";
import { FrameworkService } from "../src/framework-runtime/service.js";
import { PrivateFrameworkRepository } from "../src/framework-runtime/state.js";
import { createPrivateUnderstandingHost } from "../src/understanding-app/host.js";
import type { PrivateUnderstandingRepository } from "../src/understanding-app/repository.js";
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture(allowDraft = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "findme-u4-host-test-")));
  temporary.push(root);
  const build = path.join(root, "build");
  await mkdir(build);
  await writeFile(
    path.join(build, "index.html"),
    "<!doctype html><html><head></head><body>Existing App</body></html>",
  );
  const state = path.join(root, "private-state");
  const repository = new PrivateFrameworkRepository(state, "synthetic-owner");
  const service = new FrameworkService({
    repository,
    ownerKey: "synthetic-owner",
    definitions: [human3Draft],
    allowInternalDraft: allowDraft,
  });
  const understanding = {
    read: async () => ({
      format: "understanding-app@1",
      baseline_version: "baseline",
      input_hash: "a".repeat(64),
      overall: { status: "unavailable", version: "baseline", report: null },
      capabilities: {
        provider_enabled: false,
        remaining_calls: 0,
        native_core: "unavailable",
        feedback_actions: [],
        overall: {
          status: "blocked",
          blocked_reason: "U2_OVERALL_ABSENT",
          request: null,
          action: null,
        },
      },
      topics: [],
      old_dispositions: { version: "baseline", status: "partial", report: null },
      frameworks: { human_3: "not_run" },
      scope: {
        cutoff_before: "synthetic",
        source_fingerprint: "synthetic",
        exhaustive: false,
        owner_confirmed: false,
      },
      feedback: [],
    }),
  } as unknown as PrivateUnderstandingRepository;
  const app = await createPrivateUnderstandingHost(
    understanding,
    "synthetic-token",
    build,
    service,
  );
  return { app, state, service };
}
describe("same private App framework wiring, no server/DB/provider", () => {
  it("authenticates framework catalog before touching private state", async () => {
    const f = await fixture();
    expect((await f.app.request("/api/understanding/frameworks/definitions")).status).toBe(401);
    await expect(stat(f.state)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("catalog is read-only and exposes a locked draft with independent zero budget", async () => {
    const f = await fixture();
    const response = await f.app.request("/api/understanding/frameworks/definitions", {
      headers: { authorization: "Bearer synthetic-token" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.runs).toEqual([]);
    expect(body.capabilities).toMatchObject({ provider_enabled: false, remaining_u4_calls: 0 });
    expect(body.definitions[0]).toMatchObject({
      available: false,
      blocked_reason: "DRAFT_DISABLED",
    });
    await expect(stat(f.state)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("projects the current HUMAN 3.0 run status into the main understanding view", async () => {
    const f = await fixture(true);
    const headers = { authorization: "Bearer synthetic-token" };
    const before = await f.app.request("/api/understanding", { headers });
    expect((await before.json()).frameworks.human_3).toBe("not_run");
    await f.service.start(
      {
        key: human3Draft.key,
        definition_version: human3Draft.version,
        definition_hash: human3Draft.content_hash,
      },
      "synthetic-status-start",
    );
    const during = await f.app.request("/api/understanding", { headers });
    expect((await during.json()).frameworks.human_3).toBe("in_progress");
  });
  it("serves the same App and retains the private native-Core boundary", async () => {
    const f = await fixture();
    const page = await f.app.request("/");
    expect(await page.text()).toContain('name="findme-private-host"');
    const core = await f.app.request("/api/core/capabilities");
    expect(core.status).toBe(404);
    expect((await core.json()).error.code).toBe("NATIVE_CORE_UNAVAILABLE_PRIVATE_HOST");
    const start = await f.app.request("/api/understanding/frameworks/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-token",
        "content-type": "application/json",
        "Idempotency-Key": "synthetic-start",
      },
      body: JSON.stringify({
        key: human3Draft.key,
        definition_version: human3Draft.version,
        definition_hash: human3Draft.content_hash,
      }),
    });
    expect(start.status).toBe(403);
    expect((await start.json()).error.code).toBe("DRAFT_DISABLED");
  });
});
