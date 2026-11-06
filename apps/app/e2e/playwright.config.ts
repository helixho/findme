import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const real = process.env.FINDME_BROWSER_REAL === "1";
export default defineConfig({
  testDir: ".",
  testMatch: real ? "real.spec.ts" : ["synthetic.spec.ts", "chat.spec.ts"],
  forbidOnly: true,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: "list",
  outputDir: "/tmp/findme-browser-results",
  use: {
    baseURL: `http://127.0.0.1:${real ? 18765 : 18764}`,
    headless: true,
    browserName: "chromium",
  },
  webServer: {
    command: real
      ? "pnpm --filter @findme/api exec tsx scripts/browser-test-host.ts"
      : "pnpm --filter @findme/app exec vite preview --host 127.0.0.1 --port 18764 --strictPort",
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    url: `http://127.0.0.1:${real ? 18765 : 18764}`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
