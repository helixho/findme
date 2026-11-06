import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Parse data only: no shell evaluation, expansion, or executable env directives. */
export function parseRuntimeEnv(text) {
  const values = Object.create(null);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) throw new Error("RUNTIME_ENV_INVALID");
    let value = match[2].trim();
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        throw new Error("RUNTIME_ENV_INVALID");
      }
      if (typeof value !== "string") throw new Error("RUNTIME_ENV_INVALID");
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length < 2) throw new Error("RUNTIME_ENV_INVALID");
      value = value.slice(1, -1);
    }
    if (value.includes("\0") || /[\r\n]/.test(value)) throw new Error("RUNTIME_ENV_INVALID");
    values[match[1]] = value;
  }
  return values;
}

function required(values, key) {
  if (!values[key]) throw new Error(`${key}_REQUIRED`);
  return values[key];
}
function absolute(value) {
  if (!value || !path.isAbsolute(value)) throw new Error("ABSOLUTE_PATH_REQUIRED");
  return path.resolve(value);
}

export async function inspectPostgres(container) {
  const { stdout } = await promisify(execFile)("docker", ["inspect", container], {
    maxBuffer: 1024 * 1024,
  });
  let info;
  try {
    [info] = JSON.parse(stdout);
  } catch {
    throw new Error("POSTGRES_INSPECT_INVALID");
  }
  if (!info?.State?.Running) throw new Error("POSTGRES_NOT_RUNNING");
  const addresses = [
    ...new Set(
      Object.values(info.NetworkSettings?.Networks ?? {})
        .map((network) => network.IPAddress)
        .filter(Boolean),
    ),
  ];
  // A multi-network container requires selecting its address explicitly rather
  // than silently connecting to a different network after a Docker change.
  if (addresses.length !== 1 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(addresses[0]))
    throw new Error("POSTGRES_ADDRESS_UNAVAILABLE");
  return addresses[0];
}

export async function buildRuntimeEnv(values, options) {
  const state = absolute(options.stateDir);
  const repo = absolute(options.repoRoot);
  const inherited = options.inheritedEnv ?? process.env;
  const env = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"])
    if (inherited[name]) env[name] = inherited[name];
  const configuredLocation = values.DATABASE_LOCATION?.trim();
  const local = !configuredLocation || configuredLocation === "postgres/findme";
  const host = local
    ? await (options.inspectPostgres ?? inspectPostgres)(
        values.FINDME_POSTGRES_CONTAINER || "findme-postgres-1",
      )
    : null;
  const location = local ? `${host}/findme` : configuredLocation;
  // Validate the location as a URL authority/database, never shell syntax.
  let parsed;
  try {
    parsed = new URL(`postgresql://placeholder@${location}`);
  } catch {
    throw new Error("DATABASE_LOCATION_INVALID");
  }
  if (
    !parsed.hostname ||
    !parsed.pathname ||
    parsed.hash ||
    parsed.username !== "placeholder" ||
    parsed.password
  )
    throw new Error("DATABASE_LOCATION_INVALID");
  for (const role of ["RUNTIME", "IDENTITY", "AUTH"]) {
    const password = required(values, `DB_${role}_PASSWORD`);
    env[`DATABASE_URL_${role}`] =
      `postgresql://findme_${role.toLowerCase()}_login:${encodeURIComponent(password)}@${location}`;
    if (options.setup) env[`DB_${role}_PASSWORD`] = password;
  }
  const port = values.FINDME_PORT || "8000";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("PORT_INVALID");
  const origin = required(values, "FINDME_PUBLIC_URL");
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("PUBLIC_URL_INVALID");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin.replace(/\/$/, ""))
    throw new Error("PUBLIC_URL_INVALID");
  Object.assign(env, {
    NODE_ENV: "production",
    HOST: values.FINDME_BIND || "0.0.0.0",
    PORT: port,
    ACCOUNT_BASE_URL: url.origin,
    ACCOUNT_TRUSTED_ORIGINS: url.origin,
    ACCOUNT_SECRET: required(values, "ACCOUNT_SECRET"),
    ACCOUNT_REGISTRATION_ENABLED: "0",
    FINDME_FILES_ROOT: path.join(state, "files"),
    FINDME_STATIC_ROOT: path.join(repo, "apps/app/dist"),
    FINDME_METHODS_ROOT: path.join(repo, "apps/api/resources/personal-understanding"),
  });
  if (values.FINDME_VERSION) env.FINDME_VERSION = values.FINDME_VERSION;
  if (options.setup) {
    env.DATABASE_URL_ADMIN =
      values.DATABASE_ADMIN_URL ||
      (local
        ? `postgresql://postgres:${encodeURIComponent(required(values, "POSTGRES_PASSWORD"))}@${location}`
        : undefined);
    if (!env.DATABASE_URL_ADMIN) throw new Error("DATABASE_ADMIN_URL_REQUIRED");
  }
  return env;
}

export async function main(args = process.argv.slice(2)) {
  const options = { setup: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--setup") options.setup = true;
    else if (arg === "--state-dir" && args[index + 1]) options.stateDir = args[++index];
    else if (arg === "--repo-root" && args[index + 1]) options.repoRoot = args[++index];
    else throw new Error("NATIVE_RUNTIME_ARGUMENT_INVALID");
  }
  const stateDir = absolute(options.stateDir);
  const repoRoot = absolute(options.repoRoot);
  const values = parseRuntimeEnv(await readFile(path.join(stateDir, "runtime.env"), "utf8"));
  const env = await buildRuntimeEnv(values, { ...options, stateDir, repoRoot });
  const target = path.join(
    repoRoot,
    "apps/api/dist",
    options.setup ? "standalone/setup.js" : "index.js",
  );
  const child = spawn(process.execPath, [target], { cwd: repoRoot, env, stdio: "inherit" });
  const onTerm = () => child.kill("SIGTERM");
  const onInt = () => child.kill("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    process.exitCode = result.code ?? (result.signal === "SIGINT" ? 130 : 143);
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Errors can contain credential-bearing URLs or Docker stderr. Never print them.
    console.error("[native-runtime] startup failed");
    process.exitCode = 1;
  });
}
