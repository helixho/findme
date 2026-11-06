import { afterEach, describe, expect, it, vi } from "vitest";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}
async function api() {
  vi.resetModules();
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  return import("../src/cloud-api");
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("account HTTP response boundaries", () => {
  it("rejects a success body completed after a Profile switch", async () => {
    const cloud = await api();
    cloud.selectCloudProfile("first");
    let finish!: (value: unknown) => void;
    const body = new Promise((resolve) => {
      finish = resolve;
    });
    const readBody = vi.fn(() => body);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: readBody })),
    );
    const pending = cloud.cloudRequest("/api/diagnostics");
    await vi.waitFor(() => expect(readBody).toHaveBeenCalled());
    cloud.selectCloudProfile("second");
    finish([{ id: "private-first" }]);
    await expect(pending).rejects.toMatchObject({ code: "PROFILE_CHANGED" });
  });
  it("rejects an account response completed after logout", async () => {
    const cloud = await api();
    let finish!: (value: unknown) => void;
    const body = new Promise((resolve) => {
      finish = resolve;
    });
    const readBody = vi.fn(() => body);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: readBody })),
    );
    const pending = cloud.cloudRequest("/api/profiles", {}, false);
    await vi.waitFor(() => expect(readBody).toHaveBeenCalled());
    cloud.resetCloudSession();
    finish([{ id: "old-account" }]);
    await expect(pending).rejects.toMatchObject({ code: "PROFILE_CHANGED" });
  });
  it("does not dispatch an old mutation into a new Profile while hashing its body", async () => {
    const cloud = await api();
    cloud.selectCloudProfile("first");
    let finish!: (value: ArrayBuffer) => void;
    const hashed = new Promise<ArrayBuffer>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(hashed);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const pending = cloud.cloudMutation("/api/diagnostics", { question: "first profile input" });
    cloud.selectCloudProfile("second");
    finish(new ArrayBuffer(32));
    await expect(pending).rejects.toMatchObject({ code: "PROFILE_CHANGED" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps account-level logout valid while a Profile changes during body decoding", async () => {
    const cloud = await api();
    cloud.selectCloudProfile("first");
    let finish!: (value: unknown) => void;
    const body = new Promise((resolve) => {
      finish = resolve;
    });
    const readBody = vi.fn(() => body);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: readBody })),
    );
    const pending = cloud.cloudRequest("/api/auth/sign-out", { method: "POST" }, false);
    await vi.waitFor(() => expect(readBody).toHaveBeenCalled());
    cloud.selectCloudProfile("second");
    finish({ success: true });
    await expect(pending).resolves.toEqual({ success: true });
  });
  it("keeps account-level mutation valid while a Profile changes during hashing", async () => {
    const cloud = await api();
    cloud.selectCloudProfile("first");
    let finish!: (value: ArrayBuffer) => void;
    const hashed = new Promise<ArrayBuffer>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(hashed);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetch);
    const pending = cloud.cloudMutation("/api/auth/sign-out", {}, "POST", false);
    cloud.selectCloudProfile("second");
    finish(new ArrayBuffer(32));
    await expect(pending).resolves.toEqual({ success: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("X-FindMe-Profile")).toBe(false);
  });
  it("fails closed when a source pagination cursor repeats", async () => {
    const cloud = await api();
    cloud.selectCloudProfile("first");
    const fetch = vi.fn(async () => Response.json({ items: [{ id: "s1" }], next_cursor: 0 }));
    vi.stubGlobal("fetch", fetch);
    await expect(cloud.cloudSources()).rejects.toMatchObject({ code: "SOURCE_CURSOR_REPEATED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps the idempotency key while the server still processes the request", async () => {
    const cloud = await api();
    cloud.selectCloudProfile("p");
    const keys: string[] = [];
    const replies = [
      { status: "processing", operation_id: "op" },
      { phase: "review" },
      { phase: "review" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        keys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
        return { ok: true, json: async () => replies.shift() };
      }),
    );
    await cloud.cloudMutation("/api/core/explorations/e/continue", { expected_version: 1 });
    await cloud.cloudMutation("/api/core/explorations/e/continue", { expected_version: 1 });
    await cloud.cloudMutation("/api/core/explorations/e/continue", { expected_version: 1 });
    // Retry after 202 reuses the key; a completed reply releases it.
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });
  it("keeps a saved operation recoverable after a non-JSON gateway error", async () => {
    const cloud = await api();
    cloud.selectCloudProfile("p");
    const keys: string[] = [];
    const replies = [
      new Response("upstream temporarily unavailable", { status: 502 }),
      Response.json({ phase: "review", version: 11 }),
      Response.json({ phase: "review", version: 11 }),
    ];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
      return replies.shift()!;
    });
    vi.stubGlobal("fetch", fetch);
    const path = "/api/core/explorations/e/continue";
    const input = { expected_version: 10 };
    await expect(cloud.cloudMutation(path, input)).rejects.toMatchObject({
      status: 502,
      code: "HTTP_502",
    });
    // Recovery is explicitly requested, never an automatic extra model call.
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(cloud.cloudMutation(path, input)).resolves.toEqual({
      phase: "review",
      version: 11,
    });
    await cloud.cloudMutation(path, input);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });
});
