import { spawn } from "node:child_process";

export function run(
  command,
  args,
  { env, cwd, signal, timeout = 600_000, capture = false, terminationGraceMs = 1000 } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      detached: process.platform !== "win32",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    let failure;
    let killTimer;
    child.stdout?.on("data", (data) => {
      output += data;
    });
    child.stderr?.on("data", (data) => {
      output += data;
    });
    function kill(sig) {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch (error) {
        if (error.code !== "ESRCH") failure ??= error;
      }
    }
    function stop(reason) {
      if (failure) return;
      failure = new Error(reason);
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), terminationGraceMs);
    }
    const abort = () => stop(`${command} interrupted`);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(`${command} exceeded ${timeout}ms`), timeout);
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (failure || code !== 0)
        reject(
          failure ??
            new Error(`${command} failed (${sig ?? code})${capture ? `: ${output.trim()}` : ""}`),
        );
      else resolve(output.trim());
    });
  });
}
