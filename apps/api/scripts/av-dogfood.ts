import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { DogfoodEngine } from "../src/dogfood/engine.js";
import { freeze } from "../src/dogfood/freeze.js";
import { DogfoodError, FeedbackInput } from "../src/dogfood/model.js";
import { createDogfoodApp, exportPackage, metadata } from "../src/dogfood/server.js";
import { BatchStore, outsideRepo } from "../src/dogfood/store.js";
import { codexConfig, createCodexGateway } from "../src/llm/codex-cli.js";
import { createGateway } from "../src/llm/gateway.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const args = process.argv.slice(2);
const command = args.shift();
const flags = new Map<string, string>();
try {
  while (args.length) {
    const flag = args.shift();
    if (!flag) throw new DogfoodError("INVALID_ARGUMENT");
    if (!flag.startsWith("--") || flags.has(flag)) throw new DogfoodError("INVALID_ARGUMENT");
    if (flag === "--live" || flag === "--retry-failed") flags.set(flag, "true");
    else {
      const value = args.shift();
      if (!value || value.startsWith("--")) throw new DogfoodError("ARGUMENT_VALUE_REQUIRED");
      flags.set(flag, value);
    }
  }
  const known = [
    "--provider",
    "--db",
    "--out",
    "--sessions",
    "--holdout",
    "--seed",
    "--before",
    "--batch",
    "--live",
    "--retry-failed",
    "--max-calls",
    "--session",
    "--limit",
    "--port",
    "--version",
    "--key",
    "--target",
    "--action",
    "--author",
    "--about",
    "--kind",
    "--note",
  ];
  if ([...flags.keys()].some((k) => !known.includes(k))) throw new DogfoodError("UNKNOWN_ARGUMENT");
  const requireFlag = (name: string) => {
    const value = flags.get(name);
    if (!value) throw new DogfoodError("ARGUMENT_REQUIRED");
    return value;
  };
  const number = (name: string, fallback?: number) => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw new DogfoodError("INTEGER_REQUIRED");
    return Number(raw);
  };
  const absolute = (name: string) => {
    const value = requireFlag(name);
    if (!path.isAbsolute(value)) throw new DogfoodError("ABSOLUTE_PATH_REQUIRED");
    return value;
  };
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (!command || command === "help" || command === "--help") {
    output({
      commands: [
        "freeze --db <AV.sqlite> --out <outside-repo-batch> --sessions 24 --holdout 6 --before <ISO-time>",
        "status --batch <batch>",
        "extract --batch <batch> [--session <id>] [--max-calls 4] [--live] [--retry-failed]",
        "synthesize|compare --batch <batch> [--live] [--retry-failed]",
        "serve --batch <batch> --port 8795",
        "review --batch <batch> --version <n> --key <unique> --target <id> --action <action>",
        "export --batch <batch> --out <outside-repo-file>",
      ],
      defaults:
        "No model calls without --live; staging only; use --provider codex for the existing ChatGPT-authenticated Codex CLI, or --provider api for existing API configuration.",
    });
  } else if (command === "freeze") {
    const manifest = await freeze({
      db: absolute("--db"),
      out: absolute("--out"),
      sessions: number("--sessions", 24) ?? 24,
      holdout: number("--holdout", 6) ?? 6,
      seed: flags.get("--seed") ?? "fixed",
      before: flags.get("--before"),
      repoRoot,
    });
    output({
      frozen: true,
      sessions: manifest.sessions.length,
      holdout: manifest.sessions.filter((s) => s.split === "holdout").length,
      sampling: manifest.sampling,
      independence: "unknown",
    });
  } else {
    const store = new BatchStore(await outsideRepo(absolute("--batch"), repoRoot));
    const provider = flags.get("--provider") ?? process.env.FINDME_DOGFOOD_PROVIDER ?? "api";
    if (!["api", "codex"].includes(provider)) throw new DogfoodError("INVALID_PROVIDER");
    const gateway = () => {
      if (provider === "codex") return createCodexGateway(codexConfig());
      const deepseekKey = process.env.DEEPSEEK_API_KEY;
      const mx2BaseUrl = process.env.M_X2_BASE_URL ?? process.env.DEEPSEEK_BASE_URL;
      const deepseekModel = process.env.DEEPSEEK_MODEL;
      if (!deepseekKey || !mx2BaseUrl || !deepseekModel)
        throw new DogfoodError("M_X2_CONFIGURATION_REQUIRED");
      try {
        const url = new URL(mx2BaseUrl);
        if (!["https:", "http:"].includes(url.protocol)) throw new Error();
      } catch {
        throw new DogfoodError("M_X2_CONFIGURATION_INVALID");
      }
      return createGateway({ deepseekKey, mx2BaseUrl, deepseekModel });
    };
    if (command === "inspect" || command === "status") output(await metadata(store));
    else if (command === "extract" || command === "synthesize" || command === "compare") {
      const live = flags.has("--live");
      // Dry runs require neither credentials nor a provider client.
      const modelOnly = {
        describe: () => ({ route: "observation_model", model: "dry-run" }),
        extract: async () => {
          throw new DogfoodError("LIVE_REQUIRED");
        },
      };
      const engine = new DogfoodEngine(
        store,
        live ? gateway() : (modelOnly as ReturnType<typeof createGateway>),
      );
      output(
        await engine.generate({
          operation: command,
          live,
          maxCalls: number("--max-calls"),
          retryFailed: flags.has("--retry-failed"),
          session: flags.get("--session"),
          limit: number("--limit"),
        }),
      );
    } else if (command === "review" || command === "feedback") {
      const review = FeedbackInput.parse({
        expectedVersion: number("--version"),
        idempotencyKey: requireFlag("--key"),
        targetId: requireFlag("--target"),
        action: requireFlag("--action"),
        author: flags.get("--author"),
        about: flags.get("--about"),
        kind: flags.get("--kind"),
        note: flags.get("--note"),
      });
      output({ version: await store.review(review), saved: true });
    } else if (command === "export") {
      const destination = absolute("--out");
      await outsideRepo(path.dirname(destination), repoRoot);
      output(await exportPackage(store, destination));
    } else if (command === "serve") {
      const port = number("--port", 8795) ?? 8795;
      if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
        throw new DogfoodError("INVALID_PORT");
      await store.recover();
      const app = createDogfoodApp({
        store,
        port,
        appDist: path.join(repoRoot, "apps/app/dist"),
        engine: () => new DogfoodEngine(store, gateway()),
      });
      const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
      server.on("error", () => {
        process.stderr.write("LOCAL_SERVER_FAILED\n");
        process.exitCode = 1;
      });
      output({
        serving: `http://127.0.0.1:${port}/dogfood`,
        staging: true,
        liveOnlyOnExplicitGeneration: true,
        provider,
      });
    } else throw new DogfoodError("UNKNOWN_COMMAND");
  }
} catch (error) {
  // Never echo filesystem paths, source content, environment values or provider errors.
  process.stderr.write(
    `${error instanceof DogfoodError ? error.code : "DOGFOOD_COMMAND_FAILED"}\n`,
  );
  process.exitCode = 1;
}
