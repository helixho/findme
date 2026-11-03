import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeUnderstandingSourceData } from "./helpers/understanding-source-data.js";

const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const worker = fileURLToPath(new URL("./helpers/understanding-lock-process.ts", import.meta.url));
type Kind = "batch" | "framework";

function writer(kind: Kind, directory: string, operation: string) {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ["--import", "tsx", worker, kind, directory, operation],
    { cwd: apiRoot, env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  // Outer watchdog also covers loader/import failure before the child's watchdog exists.
  const timeout = setTimeout(() => child.kill("SIGKILL"), 12_000);
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("error", (error) => {
      stderr += error.message;
      resolve({ code: null, signal: "spawn-error" });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  return {
    child,
    exited,
    async ready() {
      // Bounded, event-driven wait, including early process exit.
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 8_000);
      try {
        while (!stdout.includes("READY\n")) {
          const result = await Promise.race([
            once(child.stdout, "data", { signal: controller.signal }).then(() => "data"),
            exited.then(() => "exit"),
          ]);
          if (result === "exit") throw new Error(`Child exited before READY: ${stdout} ${stderr}`);
        }
      } finally {
        clearTimeout(deadline);
        controller.abort();
      }
    },
    async result() {
      return { ...(await exited), stdout, stderr };
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}

async function fixture(
  kind: Kind,
  test: (f: {
    directory: string;
    lock: string;
    stateFile: string;
    start: (operation: string) => ReturnType<typeof writer>;
    committed: () => Promise<void>;
  }) => Promise<void>,
) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "findme-private-lock-")));
  const children: ReturnType<typeof writer>[] = [];
  const stateDirectory = kind === "batch" ? directory : path.join(directory, "frameworks");
  const start = (operation: string) => {
    const child = writer(kind, directory, operation);
    children.push(child);
    return child;
  };
  const committed = async () => {
    expect(await start("write").result()).toEqual({
      code: 0,
      signal: null,
      stdout: "COMMITTED\n",
      stderr: "",
    });
  };
  try {
    if (kind === "batch") {
      const { raw, manifest } = makeUnderstandingSourceData();
      await writeFile(path.join(directory, "raw.json"), JSON.stringify(raw));
      await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    }
    await committed();
    await test({
      directory,
      lock: path.join(stateDirectory, ".staging-lock"),
      stateFile: path.join(stateDirectory, "state.json"),
      start,
      committed,
    });
  } finally {
    await Promise.all(children.map((child) => child.stop()));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const kind of ["batch", "framework"] as const) {
  describe(`${kind}: independent process file locking`, () => {
    it("rejects a second live writer, preserves committed bytes, then permits a writer after release", async () => {
      await fixture(kind, async ({ lock, stateFile, start, committed }) => {
        const before = await readFile(stateFile, "utf8");
        const holder = start("hold");
        await holder.ready();
        expect(await readFile(path.join(lock, "pid"), "utf8")).toBe(String(holder.child.pid));
        const rejected = await start("write").result();
        expect(rejected).toEqual({
          code: 2,
          signal: null,
          stdout: "ERROR:BATCH_BUSY\n",
          stderr: "",
        });
        expect(await readFile(stateFile, "utf8")).toBe(before);
        expect(await readFile(path.join(lock, "pid"), "utf8")).toBe(String(holder.child.pid));
        holder.child.stdin.end("release\n");
        expect((await holder.result()).code).toBe(0);
        await expect(readFile(path.join(lock, "pid"))).rejects.toMatchObject({ code: "ENOENT" });
        const released = await readFile(stateFile, "utf8");
        expect(released).not.toBe(before);
        const releasedState = JSON.parse(released);
        expect(kind === "batch" ? releasedState.version : releasedState.state.revision).toBe(
          kind === "batch" ? 21 : 22,
        );
        await committed();
        const later = JSON.parse(await readFile(stateFile, "utf8"));
        expect(kind === "batch" ? later.version : later.state.revision).toBe(
          kind === "batch" ? 31 : 33,
        );
      });
    });

    it("recovers a killed owner without publishing its in-memory transaction", async () => {
      await fixture(kind, async ({ lock, stateFile, start, committed }) => {
        const before = await readFile(stateFile, "utf8");
        const holder = start("hold");
        await holder.ready();
        holder.child.kill("SIGKILL"); // Only a process created by this fixture.
        expect((await holder.result()).signal).toBe("SIGKILL");
        expect(await readFile(path.join(lock, "pid"), "utf8")).toBe(String(holder.child.pid));
        expect(await readFile(stateFile, "utf8")).toBe(before);
        await committed();
        const state = JSON.parse(await readFile(stateFile, "utf8"));
        expect(kind === "batch" ? state.version : state.state.revision).toBe(
          kind === "batch" ? 21 : 22,
        );
        await expect(readFile(path.join(lock, "pid"))).rejects.toMatchObject({ code: "ENOENT" });
      });
    });

    it("releases on a thrown transaction and never publishes partial state", async () => {
      await fixture(kind, async ({ lock, stateFile, start, committed }) => {
        const before = await readFile(stateFile, "utf8");
        expect(await start("fail").result()).toEqual({
          code: 2,
          signal: null,
          stdout: "ERROR:SYNTHETIC_TRANSACTION_FAILURE\n",
          stderr: "",
        });
        expect(await readFile(stateFile, "utf8")).toBe(before);
        await expect(readFile(path.join(lock, "pid"))).rejects.toMatchObject({ code: "ENOENT" });
        await committed();
      });
    });

    for (const pid of [null, "", "not-a-pid", "0", "-1", "1.5", "9007199254740992"]) {
      it(`fails closed for malformed lock PID ${JSON.stringify(pid)} without deleting it`, async () => {
        await fixture(kind, async ({ lock, stateFile, start }) => {
          const before = await readFile(stateFile, "utf8");
          await mkdir(lock);
          if (pid !== null) await writeFile(path.join(lock, "pid"), pid);
          expect(await start("write").result()).toEqual({
            code: 2,
            signal: null,
            stdout: "ERROR:BATCH_BUSY\n",
            stderr: "",
          });
          expect(await readFile(stateFile, "utf8")).toBe(before);
          if (pid === null)
            await expect(readFile(path.join(lock, "pid"))).rejects.toMatchObject({
              code: "ENOENT",
            });
          else expect(await readFile(path.join(lock, "pid"), "utf8")).toBe(pid);
          await expect(stat(`${lock}-recovery`)).rejects.toMatchObject({ code: "ENOENT" });
        });
      });
    }

    it("preserves a lock naming a live unrelated PID (the PID-reuse conservative case)", async () => {
      await fixture(kind, async ({ lock, stateFile, start }) => {
        const unrelated = start("unrelated");
        await unrelated.ready();
        const before = await readFile(stateFile, "utf8");
        await mkdir(lock);
        await writeFile(path.join(lock, "pid"), String(unrelated.child.pid));
        expect(await start("write").result()).toEqual({
          code: 2,
          signal: null,
          stdout: "ERROR:BATCH_BUSY\n",
          stderr: "",
        });
        expect(await readFile(path.join(lock, "pid"), "utf8")).toBe(String(unrelated.child.pid));
        expect(await readFile(stateFile, "utf8")).toBe(before);
        expect(unrelated.child.exitCode).toBeNull();
      });
    });

    it("bounds failure when a recovery directory already exists, without removing either lock", async () => {
      await fixture(kind, async ({ lock, stateFile, start }) => {
        const before = await readFile(stateFile, "utf8");
        await mkdir(lock);
        await writeFile(path.join(lock, "pid"), "malformed");
        await mkdir(`${lock}-recovery`);
        await writeFile(`${lock}-recovery/sentinel`, "retain");
        expect(await start("write").result()).toEqual({
          code: 2,
          signal: null,
          stdout: "ERROR:BATCH_BUSY\n",
          stderr: "",
        });
        expect(await readFile(`${lock}-recovery/sentinel`, "utf8")).toBe("retain");
        expect(await readFile(path.join(lock, "pid"), "utf8")).toBe("malformed");
        expect(await readFile(stateFile, "utf8")).toBe(before);
      });
    });
  });
}
