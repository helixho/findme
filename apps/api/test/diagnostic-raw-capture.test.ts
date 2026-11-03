import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCodexGateway } from "../src/llm/codex-cli.js";
import type { GatewayAttemptResult } from "../src/llm/gateway.js";

const config = {
  binary: "unused-test-binary",
  version: "test-only",
  model: "mock-model",
  effort: "medium",
};
const usage = {
  inputTokens: 100,
  outputTokens: 9,
  totalTokens: 109,
  cacheInputTokens: 0,
  cacheOutputTokens: null,
};
describe("explicit private raw output capture", () => {
  it("captures malformed JSON before parse rejection and preserves usage", async () => {
    const raw = '{"message":"truncated';
    const captured: string[] = [];
    const ledger: GatewayAttemptResult[] = [];
    const gateway = createCodexGateway(config, async () => ({ text: raw, usage }));
    await expect(
      gateway.extract({
        route: "observation_model",
        text: "synthetic input",
        schema: z.object({ message: z.string() }),
        controls: {
          captureRawOutput: (text) => {
            captured.push(text);
          },
          observer: {
            beforeAttempt: async () => {},
            afterAttempt: async (result) => {
              ledger.push(result);
            },
          },
        },
      }),
    ).rejects.toMatchObject({ kind: "json_parse" });
    expect(captured).toEqual([raw]);
    expect(ledger[0]?.usage).toEqual(usage);
    expect(ledger[0]?.status).toBe("error");
  });
  it("captures schema-invalid output but never returns it as accepted", async () => {
    let captured = "";
    const gateway = createCodexGateway(config, async () => ({ text: '{"message":123}', usage }));
    await expect(
      gateway.extract({
        route: "observation_model",
        text: "synthetic input",
        schema: z.object({ message: z.string() }),
        controls: {
          captureRawOutput: (text) => {
            captured = text;
          },
        },
      }),
    ).rejects.toMatchObject({ kind: "schema_validation" });
    expect(captured).toBe('{"message":123}');
  });
  it("preserves ordinary extraction without adding any capture requirement", async () => {
    const gateway = createCodexGateway(config, async () => ({ text: '{"message":"ok"}', usage }));
    await expect(
      gateway.extract({
        route: "observation_model",
        text: "synthetic input",
        schema: z.object({ message: z.string() }),
      }),
    ).resolves.toEqual({ message: "ok" });
  });
});
