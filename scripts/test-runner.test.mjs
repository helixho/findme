import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cleanEnvironment,
  dbFiles,
  inventory,
  isDatabaseTest,
  isFastTest,
  selectFiles,
  vitestSelection,
} from "./test-config.mjs";
import { connectionPreflight, isolatedDatabase } from "./test-db.mjs";
import { run } from "./test-process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = cleanEnvironment();

test("inventory assigns API and browser assets, with explicit real-Postgres suffix", async () => {
  const { groups, emptyPackages, browserFiles } = await inventory(root);
  assert.equal(dbFiles.length, 13);
  for (const file of dbFiles) assert.ok(groups.db.includes(file));
  assert.ok(groups.db.every(isDatabaseTest));
  assert.ok(browserFiles.every((file) => file.startsWith("apps/app/e2e/")));
  assert.ok(!emptyPackages.includes("apps/app"));
  assert.ok(groups.local.includes("test/crisis.test.ts"));
  assert.ok(groups.local.includes("test/framework-runtime.test.ts"));
  assert.ok(emptyPackages.includes("packages/db"));
  assert.ok(emptyPackages.includes("packages/core"));
  assert.equal(
    new Set([...groups.local, ...groups.db]).size,
    groups.local.length + groups.db.length,
  );
});

test("file filters are useful, every filter must match and unsupported flags fail", () => {
  const groups = {
    local: ["test/crisis.test.ts", "test/framework-runtime.test.ts"],
    db: [dbFiles[0]],
  };
  assert.deepEqual(
    selectFiles(groups, "all", ["apps/api/test/crisis.test.ts", "framework-runtime"]),
    { local: groups.local, db: [] },
  );
  assert.deepEqual(selectFiles(groups, "db", ["app.test.ts"]).db, [dbFiles[0]]);
  for (const filters of [["missing"], ["crisis", "missing"], ["--passWithNoTests"], ["-t"], [""]]) {
    assert.throws(() => selectFiles(groups, "all", filters));
  }
  assert.throws(() => selectFiles(groups, "db", ["crisis"]));
  assert.throws(() => selectFiles(groups, "typo", []));
});

test("fast selection is a genuine subset and database suffix cannot leak to local", () => {
  const groups = {
    local: ["test/env.test.ts", "test/framework-runtime.test.ts"],
    db: ["test/knowledge-processing-postgres.test.ts"],
  };
  assert.ok(isDatabaseTest(groups.db[0]));
  assert.ok(!isFastTest(groups.local[1]));
  assert.deepEqual(selectFiles(groups, "fast", []), { local: ["test/env.test.ts"], db: [] });
  assert.throws(() => selectFiles(groups, "fast", ["framework-runtime"]));
});

test("clean child environment drops app/model/DB credentials and Node injection; respects Docker selection", () => {
  assert.deepEqual(
    cleanEnvironment({
      PATH: "/bin",
      HOME: "/home/test",
      DOCKER_HOST: "unix:///tmp/dedicated.sock",
      DOCKER_CONTEXT: "dedicated",
      DATABASE_URL_TEST: "production",
      FINDME_ACCOUNT_VERIFY_CONFIG: "production.json",
      OPENAI_API_KEY: "secret",
      NODE_OPTIONS: "--env-file=private",
      HTTPS_PROXY: "private",
    }),
    {
      PATH: "/bin",
      HOME: "/home/test",
      DOCKER_HOST: "unix:///tmp/dedicated.sock",
      DOCKER_CONTEXT: "dedicated",
    },
  );
});

test("Vitest config fails fast on direct, empty, mixed or unprovisioned DB invocation", () => {
  assert.throws(() => vitestSelection({}), /Use pnpm test/);
  assert.throws(() => vitestSelection({ FINDME_TEST_GROUP: "local" }), /empty/);
  assert.throws(
    () => vitestSelection({ FINDME_TEST_GROUP: "db", FINDME_TEST_FILES: JSON.stringify(dbFiles) }),
    /prerequisites/,
  );
  assert.throws(
    () =>
      vitestSelection({ FINDME_TEST_GROUP: "local", FINDME_TEST_FILES: JSON.stringify(dbFiles) }),
    /Invalid/,
  );
  const local = { FINDME_TEST_GROUP: "local", FINDME_TEST_FILES: '["test/crisis.test.ts"]' };
  assert.deepEqual(vitestSelection(local), ["test/crisis.test.ts"]);
  assert.throws(() => vitestSelection({ ...local, DATABASE_URL_TEST: "unexpected" }), /DB-free/);
});

function fixture(failAt, controller) {
  const calls = [];
  let label;
  let savedConfig;
  class Client {
    constructor(options) {
      this.options = options;
    }
    async connect() {
      calls.push(["connect", this.options]);
    }
    async query(sql, params) {
      calls.push(["sql", sql, params]);
      if (failAt === "policy" && sql.includes("BEGIN;")) throw new Error("policy failed");
      if (failAt === "roles" && sql.includes("pg_has_role"))
        return { rows: [{ member: true, rolcanlogin: true, rolsuper: true }] };
      return {
        rows: [
          {
            member: true,
            rolcanlogin: true,
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolreplication: false,
            rolbypassrls: false,
          },
        ],
      };
    }
    async end() {
      calls.push(["end"]);
    }
  }
  const fakeRun = async (command, args, options) => {
    calls.push([command, args, options]);
    if (command === "pnpm" && failAt === "migration") throw new Error("migration failed");
    if (command !== "docker") return "";
    if (args[0] === "info" && failAt === "docker") throw new Error("Docker absent");
    if (args[0] === "create") {
      label = args[args.indexOf("--label") + 1].split("=")[1];
      if (failAt === "create") throw new Error("docker create timed out");
    }
    if (args[0] === "port") return "127.0.0.1:54321";
    if (args[0] === "inspect") return label;
    return "";
  };
  return {
    calls,
    options: {
      log: () => {},
      root,
      env,
      run: fakeRun,
      Client,
      signal: controller?.signal,
      execute: async (childEnv) => {
        savedConfig = childEnv.FINDME_ACCOUNT_VERIFY_CONFIG;
        calls.push(["execute", childEnv]);
        const config = JSON.parse(await readFile(savedConfig, "utf8"));
        assert.equal(config.database, "findme_test");
        assert.equal(config.host, "127.0.0.1");
        assert.equal((await stat(savedConfig)).mode & 0o777, 0o600);
        for (const role of ["runtime", "identity", "auth"])
          assert.equal(new URL(config[`${role}_url`]).username, `test_${role}`);
        if (controller) {
          controller.abort();
          controller.signal.throwIfAborted();
        }
        if (failAt === "vitest") throw new Error("suite failed");
      },
    },
    configPath: () => savedConfig,
  };
}

test("DB setup applies migration + policy before Vitest and verifies all restricted logins; cleans owned resources", async () => {
  const f = fixture();
  await isolatedDatabase(f.options);
  assert.deepEqual(f.calls.find(([cmd]) => cmd === "pnpm")[1], ["db:migrate"]);
  const migrationEnv = f.calls.find(([cmd]) => cmd === "pnpm")[2].env;
  assert.equal(migrationEnv.DOTENV_CONFIG_PATH, "/dev/null");
  assert.deepEqual(
    Object.keys(migrationEnv).sort(),
    [...Object.keys(env), "DATABASE_URL_MIGRATION", "DOTENV_CONFIG_PATH"].sort(),
  );
  const migration = f.calls.findIndex(([cmd]) => cmd === "pnpm");
  const policy = f.calls.findIndex(([cmd, sql]) => cmd === "sql" && sql.includes("BEGIN;"));
  const execute = f.calls.findIndex(([cmd]) => cmd === "execute");
  assert.ok(migration < policy && policy < execute);
  assert.equal(
    f.calls.filter(([cmd, sql]) => cmd === "sql" && sql.includes("pg_has_role")).length,
    3,
  );
  assert.ok(f.calls.some(([cmd, args]) => cmd === "docker" && args[0] === "rm"));
  assert.ok(
    f.calls
      .filter(([cmd]) => cmd === "connect")
      .every(([, options]) => options.connectionTimeoutMillis === 1000),
  );
  await assert.rejects(stat(f.configPath()), { code: "ENOENT" });
});

test("connection preflight has a bounded deadline and closes unsuccessful clients", async () => {
  let ended = false;
  class Unavailable {
    async connect() {
      throw new Error("ECONNREFUSED");
    }
    async end() {
      ended = true;
    }
  }
  await assert.rejects(
    connectionPreflight(Unavailable, "synthetic", undefined, 0),
    /preflight failed: ECONNREFUSED/,
  );
  assert.ok(ended);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(connectionPreflight(Unavailable, "synthetic", controller.signal));
});

test("cleanup refuses resources not owned by this invocation", async () => {
  const f = fixture();
  const original = f.options.run;
  f.options.run = async (command, args, options) => {
    if (command === "docker" && args[0] === "inspect") return "another-run";
    return original(command, args, options);
  };
  await assert.rejects(isolatedDatabase(f.options), /without invocation ownership/);
  assert.ok(!f.calls.some(([cmd, args]) => cmd === "docker" && args[0] === "rm"));
  await assert.rejects(stat(f.configPath()), { code: "ENOENT" });
});

test("CLI rejects nonexistent and unsupported filtering before starting suites", async () => {
  for (const filter of ["no-such-findme-test", "--passWithNoTests"]) {
    await assert.rejects(
      run(process.execPath, ["scripts/test.mjs", "local", filter], {
        cwd: root,
        env,
        capture: true,
      }),
      /test failed/,
    );
  }
});

for (const failure of ["docker", "create", "migration", "policy", "roles", "vitest"]) {
  test(`DB ${failure} failure stops before tests when appropriate, cleans only owned resources`, async () => {
    const f = fixture(failure);
    await assert.rejects(isolatedDatabase(f.options));
    assert.equal(
      f.calls.some(([cmd]) => cmd === "execute"),
      failure === "vitest",
    );
    assert.equal(
      f.calls.some(([cmd, args]) => cmd === "docker" && args[0] === "rm"),
      failure !== "docker",
    );
    if (f.configPath()) await assert.rejects(stat(f.configPath()), { code: "ENOENT" });
  });
}

test("cancellation still cleans container and temporary config without aborted signal", async () => {
  const controller = new AbortController();
  const f = fixture(undefined, controller);
  await assert.rejects(isolatedDatabase(f.options));
  const cleanup = f.calls.find(([cmd, args]) => cmd === "docker" && args[0] === "rm");
  assert.equal(cleanup[2].signal, undefined);
  assert.ok(
    cleanup[1].includes("--volumes"),
    "remove the invocation-owned anonymous PostgreSQL volume",
  );
  await assert.rejects(stat(f.configPath()), { code: "ENOENT" });
});

test("subprocess failure, bounded timeout and cancellation reject rather than claim success", async () => {
  await assert.rejects(
    run(process.execPath, ["-e", "process.exit(3)"], { env, capture: true }),
    /failed \(3\)/,
  );
  await assert.rejects(
    run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env, capture: true, timeout: 100 }),
    /exceeded/,
  );
  const controller = new AbortController();
  const pending = run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    env,
    capture: true,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /interrupted/);
  await assert.rejects(run("findme-nonexistent-command", [], { env, capture: true }), /ENOENT/);
});

test("interrupted cleanup-owning child gets time to finish cleanup before forced termination", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "findme-signal-check-"));
  const ready = path.join(directory, "ready");
  const cleaned = path.join(directory, "cleaned");
  const controller = new AbortController();
  const childCode = `
    const fs = require('node:fs');
    const timer = setInterval(() => {}, 1000);
    process.on('SIGTERM', () => setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(cleaned)}, 'done'); clearInterval(timer);
    }, 1200));
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
  `;
  const pending = run(process.execPath, ["-e", childCode], {
    env,
    capture: true,
    signal: controller.signal,
    terminationGraceMs: 5000,
  }).then(
    () => null,
    (error) => error,
  );
  try {
    const deadline = Date.now() + 5000;
    while (!(await stat(ready).catch(() => null))) {
      if (Date.now() > deadline) throw new Error("child did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    assert.match((await pending).message, /interrupted/);
    assert.equal(await readFile(cleaned, "utf8"), "done");
  } finally {
    controller.abort();
    await pending;
    await rm(directory, { recursive: true, force: true });
  }
});
