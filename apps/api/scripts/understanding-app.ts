import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { human3Draft } from "../src/framework-runtime/definitions/human3-draft.js";
import { FrameworkService } from "../src/framework-runtime/service.js";
import { PrivateFrameworkRepository } from "../src/framework-runtime/state.js";
import { codexConfig, createCodexGateway } from "../src/llm/codex-cli.js";
import { createPrivateUnderstandingHost } from "../src/understanding-app/host.js";
import { validatePaths } from "../src/understanding-app/read.js";
import { PrivateUnderstandingRepository } from "../src/understanding-app/repository.js";
import { noLinks } from "../src/understanding-baseline/io.js";

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(
      "understanding-app --repo-root ABS --batch ABS --coverage ABS --baseline-dir ABS --state-dir ABS --app-build ABS [--port 8798] [--enable-provider --feedback-max-calls N]\nOwner bearer: FINDME_U3_OWNER_TOKEN env (never printed). Host is 127.0.0.1 only; serves the existing App at / and /api/understanding. GET is read-only. Saving never calls a model. Default U3 cumulative feedback budget 0; real processing requires BOTH flags and explicit POST /api/understanding/feedback/:id/process. No U2 completion or budget mutation. Build must be outside apps/app/dist. Native Core exploration unavailable in this private host. U4 catalog is at /api/understanding/frameworks; drafts require --allow-draft-frameworks. U4 model processing separately requires --enable-framework-provider --framework-max-calls N; default disabled/0. No U2 or U3 ledger is reset or reused for U4.",
    );
    return;
  }
  const values: Record<string, string> = {};
  let enable = false;
  let enableFramework = false;
  let allowDraftFrameworks = false;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i] ?? "";
    if (k === "--enable-provider" && !enable) {
      enable = true;
      continue;
    }
    if (k === "--enable-framework-provider" && !enableFramework) {
      enableFramework = true;
      continue;
    }
    if (k === "--allow-draft-frameworks" && !allowDraftFrameworks) {
      allowDraftFrameworks = true;
      continue;
    }
    if (
      ![
        "--repo-root",
        "--batch",
        "--coverage",
        "--baseline-dir",
        "--state-dir",
        "--app-build",
        "--port",
        "--feedback-max-calls",
        "--framework-max-calls",
      ].includes(k) ||
      values[k] !== undefined
    )
      throw new Error("UNKNOWN_OR_DUPLICATE_FLAG");
    const v = argv[++i];
    if (!v || v.startsWith("--")) throw new Error("FLAG_VALUE_REQUIRED");
    values[k] = v;
  }
  const required = (k: string) => {
    const v = values[k];
    if (!v || !path.isAbsolute(v)) throw new Error("ABSOLUTE_PATH_REQUIRED");
    return v;
  };
  const options = {
    repoRoot: required("--repo-root"),
    batch: required("--batch"),
    coverage: required("--coverage"),
    baselineDir: required("--baseline-dir"),
    stateDir: required("--state-dir"),
  };
  const build = required("--app-build");
  await validatePaths(options);
  await noLinks(build);
  if (build === path.join(options.repoRoot, "apps/app/dist"))
    throw new Error("SHARED_DIST_NOT_ALLOWED");
  const port = Number(values["--port"] ?? 8798);
  const budget = Number(values["--feedback-max-calls"] ?? 0);
  const frameworkBudget = Number(values["--framework-max-calls"] ?? 0);
  if (!Number.isSafeInteger(frameworkBudget) || frameworkBudget < 0)
    throw new Error("INVALID_FRAMEWORK_BUDGET");
  if (enableFramework && (!values["--framework-max-calls"] || frameworkBudget <= 0))
    throw new Error("EXPLICIT_FRAMEWORK_BUDGET_REQUIRED");
  if (!enableFramework && frameworkBudget !== 0) throw new Error("FRAMEWORK_PROVIDER_DISABLED");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT_INVALID");
  if (enable && (!values["--feedback-max-calls"] || budget <= 0))
    throw new Error("EXPLICIT_FEEDBACK_BUDGET_REQUIRED");
  if (!enable && budget !== 0) throw new Error("PROVIDER_DISABLED");
  const token = process.env.FINDME_U3_OWNER_TOKEN ?? "";
  const repository = new PrivateUnderstandingRepository({
    ...options,
    feedbackMaxCalls: budget,
    gateway: enable ? createCodexGateway(codexConfig()) : undefined,
  });
  const frameworkOwner = "private-understanding-owner";
  const frameworks = new FrameworkService({
    repository: new PrivateFrameworkRepository(options.stateDir, frameworkOwner),
    ownerKey: frameworkOwner,
    definitions: [human3Draft],
    allowInternalDraft: allowDraftFrameworks,
    gateway: enableFramework ? createCodexGateway(codexConfig()) : undefined,
    u4CallBudget: frameworkBudget,
  });
  const app = await createPrivateUnderstandingHost(repository, token, build, frameworks);
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  console.log(`FindMe private understanding host listening on 127.0.0.1:${port}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error("PRIVATE_UNDERSTANDING_HOST_FAILED");
    process.exitCode = 1;
  });
