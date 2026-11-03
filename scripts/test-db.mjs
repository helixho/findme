import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function query(Client, url, sql, params = []) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 1000,
    query_timeout: 5000,
    statement_timeout: 5000,
    ssl: false,
    options: "",
    application_name: "findme-disposable-tests",
  });
  try {
    await client.connect();
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

export async function connectionPreflight(Client, url, signal, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (true) {
    signal?.throwIfAborted();
    try {
      await query(Client, url, "SELECT 1");
      return;
    } catch (error) {
      if (Date.now() >= deadline)
        throw new Error(`Isolated DB connection preflight failed: ${error.code ?? error.message}`);
      await delay(200, undefined, { signal });
    }
  }
}

export async function isolatedDatabase({
  root,
  env,
  run,
  signal,
  execute,
  log = console.log,
  Client = createRequire(path.join(root, "apps/api/package.json"))("pg").Client,
}) {
  const id = randomUUID();
  const name = `findme-test-${id}`;
  const password = randomBytes(24).toString("hex");
  const docker = (args, options = {}) =>
    run("docker", args, { env, signal, timeout: 15_000, capture: true, ...options });
  let directory;
  let attempted = false;
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]);
    attempted = true;
    await docker(
      [
        "create",
        "--name",
        name,
        "--label",
        `findme.test-run=${id}`,
        "--publish",
        "127.0.0.1::5432",
        "--env",
        "POSTGRES_DB=findme_test",
        "--env",
        `POSTGRES_PASSWORD=${password}`,
        "postgres:17",
      ],
      { timeout: 120_000 },
    );
    await docker(["start", name]);
    const address = await docker(["port", name, "5432/tcp"]);
    if (!/^127\.0\.0\.1:\d+$/.test(address))
      throw new Error("Expected a single ephemeral localhost PostgreSQL port.");
    const url = (user, pass = password) => `postgresql://${user}:${pass}@${address}/findme_test`;
    const admin = url("postgres");
    await connectionPreflight(Client, admin, signal);
    log("[db setup] PostgreSQL 17 ready; applying schema.sql, then account-runtime.sql.");
    await query(Client, admin, await readFile(path.join(root, "packages/db/schema.sql"), "utf8"));
    await query(
      Client,
      admin,
      await readFile(path.join(root, "packages/db/access/account-runtime.sql"), "utf8"),
    );
    const config = {
      host: "127.0.0.1",
      database: "findme_test",
      secret: randomBytes(32).toString("hex"),
    };
    for (const role of ["runtime", "identity", "auth"]) {
      const login = `test_${role}`;
      const pass = randomBytes(24).toString("hex");
      // Identifiers and password are generated here, never from caller input.
      await query(
        Client,
        admin,
        `CREATE ROLE ${login} LOGIN PASSWORD '${pass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT findme_${role} TO ${login};`,
      );
      config[`${role}_url`] = url(login, pass);
      const result = await query(
        Client,
        config[`${role}_url`],
        "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin,pg_has_role(current_user,$1,'member') AS member FROM pg_roles WHERE rolname=current_user",
        [`findme_${role}`],
      );
      const row = result.rows[0];
      if (
        !row?.member ||
        !row.rolcanlogin ||
        row.rolsuper ||
        row.rolcreatedb ||
        row.rolcreaterole ||
        row.rolreplication ||
        row.rolbypassrls
      )
        throw new Error(`Unsafe test role: ${role}`);
    }
    directory = await mkdtemp(path.join(tmpdir(), "findme-test-"));
    const configPath = path.join(directory, "account-verify.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    log(
      "[db setup] Runtime / identity / auth LOGIN roles verified: non-superuser, no BYPASSRLS, matching NOLOGIN group membership.",
    );
    await execute({ ...env, DATABASE_URL_TEST: admin, FINDME_ACCOUNT_VERIFY_CONFIG: configPath });
  } finally {
    // Ignore cancellation during cleanup; inspect ownership even if docker create timed out.
    async function cleanupContainer() {
      if (attempted) {
        let owner;
        try {
          owner = await docker(
            ["inspect", "--format", '{{ index .Config.Labels "findme.test-run" }}', name],
            { signal: undefined },
          );
        } catch (error) {
          if (!/No such (object|container)/i.test(error.message)) throw error;
        }
        if (owner === id) await docker(["rm", "--force", "--volumes", name], { signal: undefined });
        else if (owner)
          throw new Error("Refusing cleanup of container without invocation ownership label.");
      }
    }
    try {
      await cleanupContainer();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
