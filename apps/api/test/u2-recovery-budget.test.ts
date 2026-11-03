import { describe, expect, it } from "vitest";
import { parseUnderstandingArgs } from "../scripts/understanding-baseline.js";
const base = ["--batch", "/tmp/source", "--coverage", "/tmp/coverage", "--out", "/tmp/result"];
describe("U2 explicit recovery budget", () => {
  it("retains the default and requires explicit retry above it", () => {
    expect(parseUnderstandingArgs(base)).toMatchObject({ maxCalls: 40, live: false });
    expect(() => parseUnderstandingArgs([...base, "--max-calls", "41"])).toThrow(
      "RECOVERY_BUDGET_REQUIRES_EXPLICIT_RETRY",
    );
    expect(parseUnderstandingArgs([...base, "--max-calls", "48", "--retry-failed"])).toMatchObject({
      maxCalls: 48,
      retryFailed: true,
    });
    expect(parseUnderstandingArgs([...base, "--max-calls", "71", "--retry-failed"])).toMatchObject({
      maxCalls: 71,
    });
    expect(() => parseUnderstandingArgs([...base, "--max-calls", "72", "--retry-failed"])).toThrow(
      "MAX_CALLS_0_TO_71_REQUIRED",
    );
  });
});
