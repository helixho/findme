import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const dbFiles = ["cloud-account-integration", "core-reliability"].map(
  (name) => `test/${name}.test.ts`,
);

// Explicit postfix identifies new standalone real-PostgreSQL suites.
export const isDatabaseTest = (file) =>
  dbFiles.includes(file) || file.endsWith("-postgres.test.ts");

// Fast is a focused feedback loop, not a replacement for full local/DB/browser checks.
export const fastNames = new Set([
  "account-session-context",
  "cloud-processing-local",
  "env",
  "export-restore-continuity",
  "gateway-error-classification",
  "llm-router",
  "ordered-source-index",
  "core-report-temporal",
  "specialist-session-update",
  "u2-budget-compatibility",
  "u2-semantic-regressions",
  "runtime-primitives",
  "runtime-boundaries",
  "knowledge-processing-snapshot",
]);
export const isFastTest = (file) =>
  fastNames.has(path.posix.basename(file).replace(/\.test\.ts$/, ""));

// Deliberately omit NODE_OPTIONS, database/model credentials, proxy settings and all app config.
// Docker's connection selection is retained without ever changing the global context.
export function cleanEnvironment(source = process.env) {
  const keys = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "CI",
    "TERM",
    "NO_COLOR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ];
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
}

export async function testFiles(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["node_modules", "dist"].includes(entry.name)) continue;
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory())
      result.push(...(await testFiles(path.join(directory, entry.name), name)));
    else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) result.push(name);
  }
  return result.sort();
}

export async function inventory(root) {
  const groups = { local: [], db: [] };
  const emptyPackages = [];
  const browserFiles = [];
  const appFiles = [];
  for (const parent of ["apps", "packages"]) {
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const relative = `${parent}/${entry.name}`;
      const files = await testFiles(path.join(root, relative));
      if (!files.length) emptyPackages.push(relative);
      else if (relative === "apps/app") {
        for (const file of files) {
          if (file.startsWith("e2e/") && file.endsWith(".spec.ts"))
            browserFiles.push(`${relative}/${file}`);
          else if (file.startsWith("test/") && file.endsWith(".test.ts"))
            appFiles.push(`${relative}/${file}`);
          else throw new Error(`Unassigned App test file: ${file}`);
        }
      } else if (relative !== "apps/api")
        throw new Error(
          `Unassigned test files in ${relative}; add an explicit runner before claiming complete coverage.`,
        );
      else
        for (const file of files) {
          const source = await readFile(path.join(root, relative, file), "utf8");
          if (
            /process\.env\.(DATABASE_URL_TEST|FINDME_ACCOUNT_VERIFY_CONFIG)/.test(source) &&
            !isDatabaseTest(file)
          ) {
            throw new Error(`New DB test requires explicit grouping: ${file}`);
          }
          groups[isDatabaseTest(file) ? "db" : "local"].push(file);
        }
    }
  }
  for (const file of dbFiles)
    if (!groups.db.includes(file)) throw new Error(`Missing DB test asset: ${file}`);
  return { groups, emptyPackages, browserFiles, appFiles };
}

export function selectFiles(groups, mode, filters) {
  if (!["all", "local", "db", "fast"].includes(mode))
    throw new Error(
      "Usage: test.mjs all|local|db|fast [file filters]. File filters only; Vitest flags are not forwarded.",
    );
  const allowed =
    mode === "all"
      ? [...groups.local, ...groups.db]
      : mode === "fast"
        ? groups.local.filter(isFastTest)
        : groups[mode];
  const selected = new Set();
  for (const raw of filters) {
    if (raw.startsWith("-") || !raw.trim())
      throw new Error(
        `Unsupported filter: ${raw}. Use file names, not test-name/skip/empty-suite flags.`,
      );
    const filter = raw
      .replaceAll("\\", "/")
      .replace(/^.*apps\/api\//, "")
      .replace(/^\.\//, "");
    const matches = allowed.filter((file) => file.includes(filter));
    if (!matches.length) throw new Error(`No ${mode} test files match: ${raw}`);
    for (const file of matches) selected.add(file);
  }
  return Object.fromEntries(
    ["local", "db"].map((group) => [
      group,
      groups[group].filter(
        (file) => allowed.includes(file) && (!filters.length || selected.has(file)),
      ),
    ]),
  );
}

export function vitestSelection(env) {
  const group = env.FINDME_TEST_GROUP;
  if (!["local", "db"].includes(group))
    throw new Error("Use pnpm test, pnpm test:local or pnpm test:db (isolated setup required).");
  const files = JSON.parse(env.FINDME_TEST_FILES ?? "[]");
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.some(
      (file) =>
        typeof file !== "string" ||
        !/^test\/[\w/-]+\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
        isDatabaseTest(file) !== (group === "db"),
    )
  )
    throw new Error("Invalid or empty test group selection.");
  if (group === "db" && (!env.DATABASE_URL_TEST || !env.FINDME_ACCOUNT_VERIFY_CONFIG)) {
    throw new Error("DB prerequisites absent; run pnpm test:db to provision isolated PostgreSQL.");
  }
  if (group === "local" && (env.DATABASE_URL_TEST || env.FINDME_ACCOUNT_VERIFY_CONFIG))
    throw new Error("Local group must be DB-free.");
  return files;
}
