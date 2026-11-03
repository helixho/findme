import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanEnvironment } from "./test-config.mjs";
import { run } from "./test-process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const [command, mode, output] = process.argv.slice(2);
if (command === "build" || command === "serve") {
  if (mode !== "native" || !output || !path.isAbsolute(output))
    throw new Error("Expected native and an absolute temporary output directory");
  const appRoot = path.join(root, "apps", "app");
  const require = createRequire(path.join(appRoot, "package.json"));
  const vite = await import(pathToFileURL(require.resolve("vite")).href);
  const config = {
    root: appRoot,
    configFile: path.join(appRoot, "vite.config.ts"),
    envDir: false,
    build: { outDir: output, emptyOutDir: true },
  };
  if (command === "build") await vite.build(config);
  else {
    const server = await vite.preview({
      ...config,
      preview: { host: "127.0.0.1", port: 18774, strictPort: true },
    });
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => server.httpServer.close(() => process.exit(0)));
  }
} else {
  if (command && command !== "--list")
    throw new Error("Usage: node scripts/test-maintenance-browser.mjs [--list]");
  const controller = new AbortController();
  let interrupted;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      interrupted = signal;
      controller.abort();
    });
  const temporary = await mkdtemp(path.join(tmpdir(), "findme-maintenance-browser-"));
  const env = {
    ...cleanEnvironment(),
    FINDME_BROWSER_TEST: "1",
    VITE_APP_AUTH_MODE: "private",
    VITE_APP_PRIVATE_TOOLS: "false",
    VITE_CORE_API_BASE: "",
    FINDME_MAINTENANCE_NATIVE: path.join(temporary, "native"),
  };
  try {
    if (!command) {
      for (const [mode, pkg, output] of [["native", "app", env.FINDME_MAINTENANCE_NATIVE]]) {
        await run("pnpm", ["--filter", `@findme/${pkg}`, "exec", "tsc", "--noEmit"], {
          cwd: root,
          env,
          signal: controller.signal,
        });
        await run(
          process.execPath,
          ["scripts/test-maintenance-browser.mjs", "build", mode, output],
          { cwd: root, env, signal: controller.signal, timeout: 120_000 },
        );
      }
    }
    console.log(
      "[maintenance browser] Retained App native/private; synthetic HTTP only; separate temporary builds, dotenv disabled.",
    );
    await run(
      "pnpm",
      [
        "exec",
        "playwright",
        "test",
        "--config",
        "apps/app/e2e/maintenance.config.ts",
        ...(command ? ["--list"] : []),
      ],
      { cwd: root, env, signal: controller.signal, timeout: 300_000, terminationGraceMs: 10_000 },
    );
  } catch (error) {
    console.error(`[maintenance browser failed] ${error.message}`);
    process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
