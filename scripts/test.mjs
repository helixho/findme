import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnvironment, inventory, selectFiles } from "./test-config.mjs";
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
  const inputArgs = process.argv.slice(2);
  const coverage = inputArgs[0] === "coverage";
  if (coverage) inputArgs.shift();
  const [mode = "all", ...args] = inputArgs;
  if (coverage && !["local", "db"].includes(mode))
    throw new Error("Coverage requires explicit local or db scope.");
  const filters = args[0] === "--" ? args.slice(1) : args;
  const { groups, emptyPackages, browserFiles, appFiles } = await inventory(root);
  const selected =
    mode === "app" && !filters.length ? { local: [], db: [] } : selectFiles(groups, mode, filters);
  const env = cleanEnvironment();
  console.log(
    `[scope] ${mode}${filters.length ? `; focused files: ${filters.join(", ")}` : "; complete group(s)"}`,
  );
  console.log(
    `[inventory] No test files (not counted as passing suites): ${emptyPackages.join(", ")}`,
  );
  if (browserFiles.length)
    console.log(
      `[browser inventory] ${browserFiles.length} files; run pnpm test:browser for explicit browser scope.`,
    );
  const execute = (group, childEnv) =>
    run("pnpm", ["exec", "vitest", "run"], {
      cwd: path.join(root, "apps/api"),
      signal: controller.signal,
      env: {
        ...childEnv,
        FINDME_TEST_GROUP: group,
        ...(coverage ? { FINDME_TEST_COVERAGE: "1" } : {}),
        FINDME_TEST_FILES: JSON.stringify(selected[group]),
      },
    });
  if (mode !== "db" && mode !== "app") {
    console.log("[runner] Node script unit tests (DB-free)");
    await run(process.execPath, ["--test", "scripts/test-runner.test.mjs"], {
      cwd: root,
      env,
      signal: controller.signal,
    });
  }
  for (const group of ["local", "db"]) {
    if (!selected[group].length) {
      console.log(`[${group}] Not selected; no pass claimed.`);
      continue;
    }
    console.log(
      `[${group}] ${selected[group].length} API files; ${group === "local" ? "DB-free synthetic / no real model" : "real disposable PostgreSQL / synthetic model"}`,
    );
    if (group === "local") await execute(group, env);
    else
      await isolatedDatabase({
        root,
        env,
        run,
        signal: controller.signal,
        execute: (dbEnv) => execute(group, dbEnv),
      });
  }
  if (["all", "local", "fast", "app"].includes(mode) && !filters.length) {
    if (!appFiles.length) throw new Error("Expected App unit test assets; none found.");
    console.log(
      `[app] ${appFiles.length} frontend unit test files; real browser checks are separate.`,
    );
    await run("pnpm", ["--filter", "@findme/app", "test"], {
      cwd: root,
      env,
      signal: controller.signal,
    });
  }
  if (mode === "all" && !filters.length) {
    if (!browserFiles.length) throw new Error("Expected browser test assets; none found.");
    await run(process.execPath, ["scripts/test-browser.mjs", "all"], {
      cwd: root,
      env,
      signal: controller.signal,
      timeout: 900_000,
      terminationGraceMs: 60_000,
    });
    await run(process.execPath, ["scripts/test-maintenance-browser.mjs"], {
      cwd: root,
      env,
      signal: controller.signal,
      timeout: 600_000,
      terminationGraceMs: 60_000,
    });
  }
  console.log(`[complete] ${mode} selected scopes passed.`);
} catch (error) {
  console.error(`[test failed] ${error.message}`);
  process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
}
