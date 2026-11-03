import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export default defineConfig({
  testDir: ".",
  testMatch: "maintenance-*.spec.ts",
  forbidOnly: true,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: "list",
  outputDir: "/tmp/findme-maintenance-browser-results",
  use: { browserName: "chromium", headless: true },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: (["native"] as const).map((mode) => ({
    command: `node scripts/test-maintenance-browser.mjs serve ${mode} "${process.env.FINDME_MAINTENANCE_NATIVE}"`,
    cwd: root,
    url: `http://127.0.0.1:${18774}`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  })),
});
