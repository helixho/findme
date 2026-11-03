// Opt-in verification of a synthetic single-node installation; no model requests.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const config = Object.fromEntries(
  (await readFile(process.env.FINDME_VERIFY_ENV_FILE ?? "/data/findme/runtime.env", "utf8"))
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => {
      const split = line.indexOf("=");
      return [line.slice(0, split), line.slice(split + 1)];
    }),
);
assert.equal(config.CLOUD_INFERENCE_ENABLED, "0", "Verification requires inference disabled");
const base = config.FINDME_PUBLIC_URL;
const evidence = process.env.FINDME_VERIFY_STATE ?? "/tmp/findme-standalone-verification.json";
let cookie = "";
let profile = "";
async function request(path, method = "GET", body = undefined, expected = 200, raw = false) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Origin: base,
      Cookie: cookie,
      ...(profile ? { "X-FindMe-Profile": profile } : {}),
      ...(body !== undefined
        ? {
            "Content-Type": raw ? "text/plain" : "application/json",
            "Idempotency-Key": randomUUID(),
          }
        : {}),
    },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(response.status, expected, `${method} ${path}`);
  return response;
}
const html = await (await request("/")).text();
assert.match(html, /<div id="root">/);
const asset = html.match(/src="(\/assets\/[^\"]+\.js)"/)[1];
await request(asset);
// Instabox's HTTPS gateway overwrites cache-control with no-store. Validate
// the origin's CDN policy separately, without dropping the public HTTPS check.
const origin = process.env.FINDME_VERIFY_ORIGIN ?? `http://127.0.0.1:${config.FINDME_PORT}`;
assert.match((await fetch(origin + asset)).headers.get("cache-control"), /immutable/);
await request("/health?strict=1");
const ready = await (await request("/ready")).json();
assert.equal(ready.worker.inferenceEnabled, false);
await request("/api/profiles", "GET", undefined, 401);
const login = await request("/api/auth/sign-in/email", "POST", {
  email: config.OWNER_EMAIL,
  password: config.OWNER_PASSWORD,
});
cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
assert(cookie);
await request("/api/not-a-route", "GET", undefined, 404);
let saved;
if (process.argv[2] === "verify") {
  saved = JSON.parse(await readFile(evidence, "utf8"));
  profile = saved.profile;
} else {
  const created = await (
    await request("/api/profiles", "POST", { name: `部署验证 ${randomUUID().slice(0, 8)}` }, 201)
  ).json();
  profile = created.id;
  assert(profile);
  const run = await (
    await request(
      "/api/diagnostics",
      "POST",
      { domain: "deployment_test", question: "Synthetic deployment persistence check" },
      201,
    )
  ).json();
  const text = `Synthetic original ${randomUUID()}`;
  const hash = createHash("sha256").update(text).digest("hex");
  const blob = await (
    await request(
      "/api/blobs",
      "POST",
      {
        content_sha256: hash,
        byte_length: Buffer.byteLength(text),
        media_type: "text/plain",
      },
      201,
    )
  ).json();
  await request(`/api/blobs/${blob.id}/content`, "PUT", text, 200, true);
  saved = { profile, run: run.id, blob: blob.id, hash, text };
  await writeFile(evidence, JSON.stringify(saved), { mode: 0o600 });
}
const run = await (await request(`/api/diagnostics/${saved.run}`)).json();
assert.equal(run.question, "Synthetic deployment persistence check");
const content = await (await request(`/api/blobs/${saved.blob}/content`)).text();
assert.equal(content, saved.text);
assert.equal(createHash("sha256").update(content).digest("hex"), saved.hash);
console.log(
  "[verification] real HTTPS login, scoped writes, file round-trip and persisted content passed",
);

if (process.env.FINDME_BROWSER_CDP) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.connectOverCDP(process.env.FINDME_BROWSER_CDP);
  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(base);
      await page.getByLabel("邮箱", { exact: true }).fill(config.OWNER_EMAIL);
      await page.getByLabel("密码", { exact: true }).fill(config.OWNER_PASSWORD);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByRole("button", { name: "FindMe 首页" }).waitFor();
      await page.reload();
      await page.getByRole("button", { name: "FindMe 首页" }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.deepEqual(errors, []);
      if (process.env.FINDME_VERIFY_SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.FINDME_VERIFY_SCREENSHOTS}/${viewport.width}.png`,
          fullPage: true,
        });
      await context.close();
    }
    console.log("[verification] real desktop/mobile browser login, refresh and layout passed");
  } finally {
    await browser.close();
  }
}
