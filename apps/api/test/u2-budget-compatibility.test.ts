import { expect, it } from "vitest";
import { parseUnderstandingArgs } from "../scripts/understanding-baseline.js";
import { codexPatchCompatible } from "../src/understanding-baseline/jobs.js";
it("preserves explicit recovery parser capability without selecting or granting a larger budget", () => {
  const base = [
    "--batch",
    "/synthetic/batch",
    "--coverage",
    "/synthetic/u1",
    "--out",
    "/synthetic/u2",
  ];
  const normal = parseUnderstandingArgs([...base, "--preflight"], {});
  expect(normal).toMatchObject({
    maxCalls: 40,
    requestedBudget: undefined,
    live: false,
    provider: "deepseek",
  });
  expect(parseUnderstandingArgs([...base, "--provider", "ds", "--preflight"], {})).toMatchObject({
    provider: "deepseek",
  });
  expect(parseUnderstandingArgs([...base, "--provider", "api", "--preflight"], {})).toMatchObject({
    provider: "deepseek",
  });
  expect(parseUnderstandingArgs([...base, "--provider", "codex", "--preflight"], {})).toMatchObject(
    {
      provider: "codex",
    },
  );
  expect(
    parseUnderstandingArgs([...base, "--preflight"], { FINDME_UNDERSTANDING_PROVIDER: "codex" }),
  ).toMatchObject({
    provider: "codex",
  });
  expect(() => parseUnderstandingArgs([...base, "--provider", "other", "--preflight"], {})).toThrow(
    "INVALID_PROVIDER",
  );
  expect(parseUnderstandingArgs([...base, "--migrate-provider"], {})).toMatchObject({
    provider: "deepseek",
    migrateProvider: true,
    live: false,
  });
  expect(() => parseUnderstandingArgs([...base, "--migrate-provider", "--live"], {})).toThrow(
    "PROVIDER_MIGRATION_MUST_BE_SEPARATE_FROM_LIVE",
  );
  expect(() => parseUnderstandingArgs([...base, "--live"], {})).toThrow(
    "PROVIDER_CALL_CAP_REQUIRED_FOR_LIVE",
  );
  expect(parseUnderstandingArgs([...base, "--live", "--provider-call-cap", "1"], {})).toMatchObject(
    { live: true, providerCallCap: 1 },
  );
  expect(() =>
    parseUnderstandingArgs([...base, "--live", "--provider-call-cap", "21"], {}),
  ).toThrow("PROVIDER_CALL_CAP_0_TO_20_REQUIRED");
  expect(() => parseUnderstandingArgs([...base, "--max-calls", "71"])).toThrow(
    "RECOVERY_BUDGET_REQUIRES_EXPLICIT_RETRY",
  );
  expect(
    parseUnderstandingArgs([...base, "--max-calls", "71", "--retry-failed", "--preflight"]),
  ).toMatchObject({ requestedBudget: 71, live: false });
  expect(() => parseUnderstandingArgs([...base, "--max-calls", "72", "--retry-failed"])).toThrow(
    "MAX_CALLS_0_TO_71_REQUIRED",
  );
  const oldModel = "codex-cli:codex-cli 0.160.0:gpt-6.1-sol:high:codex-cli-gateway@1";
  expect(
    codexPatchCompatible(
      oldModel,
      "codex-cli:codex-cli 0.160.1:gpt-6.1-sol:high:codex-cli-gateway@1",
    ),
  ).toBe(true);
  expect(
    codexPatchCompatible(
      oldModel,
      "codex-cli:codex-cli 0.161.0:gpt-6.1-sol:high:codex-cli-gateway@1",
    ),
  ).toBe(false);
  expect(
    codexPatchCompatible(
      oldModel,
      "codex-cli:codex-cli 0.160.1:gpt-6.1-sol:medium:codex-cli-gateway@1",
    ),
  ).toBe(false);
  expect(
    codexPatchCompatible(
      oldModel,
      "codex-cli:codex-cli 0.160.1:gpt-6.2-sol:high:codex-cli-gateway@1",
    ),
  ).toBe(false);
});
