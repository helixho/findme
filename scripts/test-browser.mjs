import { fileURLToPath } from "node:url";
import { cleanEnvironment } from "./test-config.mjs";
import { isolatedDatabase } from "./test-db.mjs";
import { run } from "./test-process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const controller = new AbortController();
let interrupted;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = signal;
    controller.abort();
  });
try {
  const mode = process.argv[2] ?? "synthetic";
  if (!["synthetic", "real", "all"].includes(mode))
    throw new Error("Usage: node scripts/test-browser.mjs synthetic|real|all");
  const env = {
    ...cleanEnvironment(),
    VITE_APP_AUTH_MODE: "account",
    FINDME_BROWSER_TEST: "1",
    VITE_APP_PRIVATE_TOOLS: "false",
    VITE_CORE_API_BASE: "",
  };
  await run("pnpm", ["--filter", "@findme/app", "build"], {
    cwd: root,
    env,
    signal: controller.signal,
    timeout: 120_000,
  });
  const execute = (testEnv, real, project) =>
    run(
      "pnpm",
      [
        "exec",
        "playwright",
        "test",
        "--config",
        "apps/app/e2e/playwright.config.ts",
        ...(project ? ["--project", project] : []),
      ],
      {
        cwd: root,
        env: { ...testEnv, FINDME_BROWSER_REAL: real ? "1" : "0" },
        signal: controller.signal,
        timeout: 300_000,
        terminationGraceMs: 10_000,
      },
    );
  if (mode !== "real") {
    console.log(
      "[browser synthetic] Formal React account App + intercepted synthetic HTTP; no real model or database.",
    );
    await execute(env, false);
  }
  if (mode !== "synthetic") {
    // Each viewport has a fresh real account/database. Keep production rate limits intact
    // instead of making ten fresh logins share one eight-per-minute fixture bucket.
    for (const project of ["desktop", "mobile"]) {
      await isolatedDatabase({
        root,
        env,
        run,
        signal: controller.signal,
        execute: async (dbEnv) => {
          console.log(
            `[browser real ${project}] Browser cookies + createApp + Better Auth + fresh PostgreSQL roles; synthetic identity, inference disabled.`,
          );
          await execute(dbEnv, true, project);
        },
      });
    }
  }
} catch (error) {
  console.error(`[browser failed] ${error.message}`);
  process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
}
