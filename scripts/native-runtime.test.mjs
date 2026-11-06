import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildRuntimeEnv, parseRuntimeEnv } from "./native-runtime.mjs";

const values = {
  DB_RUNTIME_PASSWORD: "runtime@pass",
  DB_IDENTITY_PASSWORD: "identity#pass",
  DB_AUTH_PASSWORD: "auth/pass",
  POSTGRES_PASSWORD: "admin@pass",
  ACCOUNT_SECRET: "account-secret",
  FINDME_PUBLIC_URL: "https://example.test",
  FINDME_PORT: "8000",
};
const options = {
  stateDir: "/data/findme",
  repoRoot: "/data/workspace/findme",
  inheritedEnv: {
    PATH: "/usr/bin",
    DATABASE_URL_ADMIN: "must-not-leak",
    NODE_OPTIONS: "must-not-inject",
  },
};
test("parses runtime.env as literal data without shell interpolation", () => {
  const parsed = parseRuntimeEnv("# data\nA=$(touch /tmp/no)\nB='literal $HOME'\nC=\"quoted\"\n");
  assert.equal(parsed.A, "$(touch /tmp/no)");
  assert.equal(parsed.B, "literal $HOME");
  assert.equal(parsed.C, "quoted");
  assert.throws(() => parseRuntimeEnv("export A=1"), /INVALID/);
  assert.throws(() => parseRuntimeEnv("A=1\nA=2"), /INVALID/);
  assert.throws(() => parseRuntimeEnv('A="unterminated'), /INVALID/);
});
test("resolves local container each launch and keeps admin credentials out of application env", async () => {
  const seen = [];
  const env = await buildRuntimeEnv(values, {
    ...options,
    inspectPostgres: async (name) => {
      seen.push(name);
      return "172.21.0.9";
    },
  });
  assert.deepEqual(seen, ["findme-postgres-1"]);
  assert.equal(
    env.DATABASE_URL_RUNTIME,
    "postgresql://findme_runtime_login:runtime%40pass@172.21.0.9/findme",
  );
  assert.equal(env.FINDME_FILES_ROOT, "/data/findme/files");
  assert.equal(env.FINDME_STATIC_ROOT, "/data/workspace/findme/apps/app/dist");
  assert.equal(
    env.FINDME_METHODS_ROOT,
    "/data/workspace/findme/apps/api/resources/personal-understanding",
  );
  for (const key of [
    "DATABASE_URL_ADMIN",
    "DATABASE_ADMIN_URL",
    "POSTGRES_PASSWORD",
    "DB_RUNTIME_PASSWORD",
    "NODE_OPTIONS",
  ])
    assert.equal(env[key], undefined);
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.ACCOUNT_BASE_URL, "https://example.test");
});
test("legacy postgres location is local and explicit container selection is honored", async () => {
  const env = await buildRuntimeEnv(
    { ...values, DATABASE_LOCATION: "postgres/findme", FINDME_POSTGRES_CONTAINER: "selected-db" },
    {
      ...options,
      setup: true,
      inspectPostgres: async (name) => {
        assert.equal(name, "selected-db");
        return "172.19.0.5";
      },
    },
  );
  assert.equal(env.DATABASE_URL_ADMIN, "postgresql://postgres:admin%40pass@172.19.0.5/findme");
  assert.equal(env.DB_AUTH_PASSWORD, values.DB_AUTH_PASSWORD);
});
test("external database uses configured authority and never invokes Docker", async () => {
  const admin = "postgresql://owner:secret@db.example.test/custom?sslmode=require";
  const env = await buildRuntimeEnv(
    {
      ...values,
      DATABASE_LOCATION: "db.example.test:5433/custom?sslmode=require",
      DATABASE_ADMIN_URL: admin,
    },
    {
      ...options,
      setup: true,
      inspectPostgres: async () => {
        throw new Error("must not call Docker");
      },
    },
  );
  assert.equal(
    env.DATABASE_URL_IDENTITY,
    "postgresql://findme_identity_login:identity%23pass@db.example.test:5433/custom?sslmode=require",
  );
  assert.equal(env.DATABASE_URL_ADMIN, admin);
  await assert.rejects(
    buildRuntimeEnv(
      { ...values, DATABASE_LOCATION: "db.example.test/custom" },
      { ...options, setup: true },
    ),
    /DATABASE_ADMIN_URL_REQUIRED/,
  );
});
test("invalid runtime values fail without printing values", async () => {
  await assert.rejects(
    buildRuntimeEnv(
      { ...values, FINDME_PORT: "0" },
      { ...options, inspectPostgres: async () => "172.20.0.2" },
    ),
    /PORT_INVALID/,
  );
  await assert.rejects(
    buildRuntimeEnv({ ...values, DATABASE_LOCATION: "bad:credential@host/db" }, options),
    /DATABASE_LOCATION_INVALID/,
  );
  await assert.rejects(
    buildRuntimeEnv(values, { ...options, stateDir: "relative" }),
    /ABSOLUTE_PATH_REQUIRED/,
  );
});

test("launcher executes built API with scoped env and forwards termination", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "findme-native-launch-"));
  try {
    const state = path.join(root, "state");
    const repo = path.join(root, "repo");
    await mkdir(state);
    await mkdir(path.join(repo, "apps/api/dist"), { recursive: true });
    await writeFile(
      path.join(state, "runtime.env"),
      Object.entries({ ...values, DATABASE_LOCATION: "db.example.test/findme" })
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
    await writeFile(
      path.join(repo, "apps/api/dist/index.js"),
      `
      if (process.env.DATABASE_URL_ADMIN || process.env.NODE_OPTIONS) process.exit(9);
      if (process.env.FINDME_FILES_ROOT !== ${JSON.stringify(path.join(state, "files"))}) process.exit(8);
      process.on('SIGTERM', () => { console.log('STOPPED'); process.exit(0); });
      setInterval(() => {}, 1000); console.log('READY');
    `,
    );
    const child = spawn(
      process.execPath,
      [path.resolve("scripts/native-runtime.mjs"), "--state-dir", state, "--repo-root", repo],
      {
        env: { PATH: process.env.PATH, DATABASE_URL_ADMIN: "must-not-leak" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const ended = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("launcher startup timed out"));
      }, 10000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("READY")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        if (!output.includes("READY")) reject(new Error(`launcher exited ${code}`));
      });
    });
    child.kill("SIGTERM");
    assert.equal(await ended, 0);
    assert.match(output, /STOPPED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
