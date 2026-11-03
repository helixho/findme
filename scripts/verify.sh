#!/usr/bin/env bash
# Repository checks use a clean environment and the same disposable DB runner as CI.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --input-type=module <<'JS'
import { cleanEnvironment } from "./scripts/test-config.mjs";
import { run } from "./scripts/test-process.mjs";
const env = cleanEnvironment();
const controller = new AbortController();
let interrupted;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  interrupted = signal;
  controller.abort();
});
const steps = [
  ["install", ["install", "--frozen-lockfile"]],
  ["lint", ["lint"]],
  ["API typecheck", ["--filter", "@findme/api", "exec", "tsc", "--noEmit"]],
  ["workspace build", ["build"]],
];
try {
  for (const [label, args] of steps) {
    console.log(`[verify] ${label}`);
    await run("pnpm", args, { cwd: process.cwd(), env, timeout: 1_200_000,
      signal: controller.signal });
  }
  console.log("[verify] repository references");
  await run(process.execPath, ["scripts/check-repository.mjs"], {
    cwd: process.cwd(), env, signal: controller.signal,
  });
  // Run the cleanup-owning entry directly, not through an intermediary pnpm process.
  console.log("[verify] complete engineering tests");
  await run(process.execPath, ["scripts/test.mjs", "all"], {
    cwd: process.cwd(), env, timeout: 1_200_000, signal: controller.signal,
    terminationGraceMs: 60_000,
  });
  console.log("[verify] Selected engineering checks passed; no deployment or real model validation.");
} catch (error) {
  console.error(`[verify failed] ${error.message}`);
  process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
}
JS
