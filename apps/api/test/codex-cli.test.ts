import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type CodexConfig,
  codexArgs,
  createCodexGateway,
  processRunner,
} from "../src/llm/codex-cli.js";

const config: CodexConfig = {
  binary: "codex",
  version: "synthetic-cli",
  model: "synthetic-model",
  effort: "medium",
};
const schema = z.object({ ok: z.boolean() }).strict();
const usage = {
  inputTokens: 12000,
  outputTokens: 80,
  totalTokens: 12080,
  cacheInputTokens: 10000,
  cacheOutputTokens: null,
};
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((f) => rm(f, { recursive: true, force: true })));
});
async function binary(script: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "findme-codex-test-"));
  folders.push(directory);
  const target = path.join(directory, "fake-codex");
  await writeFile(target, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  await chmod(target, 0o700);
  return { ...config, binary: target };
}
const finalEvents = [
  { type: "thread.started" },
  { type: "item.completed", item: { type: "reasoning", text: "PRIVATE_REASONING_DO_NOT_STORE" } },
  { type: "item.completed", item: { type: "agent_message", text: '{"ok":true}' } },
  {
    type: "turn.completed",
    usage: { input_tokens: 12000, cached_input_tokens: 10000, output_tokens: 80 },
  },
];

describe("Codex local M-X2 adapter", () => {
  it("disables contextual memory, tools, hooks and reused sessions in an empty directory", () => {
    const args = codexArgs(config, "/tmp/isolated");
    const text = args.join(" ");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--output-schema");
    expect(args).toContain("read-only");
    expect(text).toContain("project_doc_max_bytes=0");
    expect(text).toContain("memories.use_memories=false");
    expect(text).toContain("features.hooks=false");
    expect(text).toContain("features.shell_tool=false");
    expect(text).toContain("features.plugins=false");
    expect(text).toContain("features.view_image=false");
    expect(text).toContain('web_search="disabled"');
    expect(args).not.toContain("resume");
    expect(args.at(-1)).toBe("-");
  });
  it("meters one CLI execution and reports advisory output cap instead of API billing", async () => {
    const runner = vi.fn().mockResolvedValue({ text: '{"ok":true}', usage });
    const beforeAttempt = vi.fn();
    const afterAttempt = vi.fn();
    const gateway = createCodexGateway(config, runner);
    expect(
      await gateway.extract({
        route: "extraction_model",
        text: "synthetic",
        schema,
        controls: { retries: 5, maxOutputTokens: 2500, observer: { beforeAttempt, afterAttempt } },
      }),
    ).toEqual({ ok: true });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(beforeAttempt).toHaveBeenCalledTimes(1);
    expect(afterAttempt.mock.calls[0]?.[0]).toMatchObject({
      status: "ok",
      usage,
      execution: {
        provider: "codex_cli",
        requestUnit: "cli_execution",
        internalRequests: "not_observable",
        outputTokenLimit: "advisory",
      },
    });
    expect(afterAttempt.mock.calls[0]?.[0].thinkingMode).toBeUndefined();
    expect(gateway.describe("observation_model").model).toContain("synthetic-model:medium");
    expect(beforeAttempt.mock.calls[0]?.[0].estimate.estimatedInputTokens).toBeGreaterThan(16000);
  });
  it("generates strict required offset hints without SDK optional-field warnings", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runner = vi
        .fn()
        .mockResolvedValue({ text: '{"spans":[{"quote":"原文","start":0,"end":2}]}', usage });
      const input = z
        .object({
          spans: z.array(
            z
              .object({
                quote: z.string(),
                start: z.number().optional(),
                end: z.number().optional(),
              })
              .strict(),
          ),
        })
        .strict()
        .transform((value) => value);
      await createCodexGateway(config, runner).extract({
        route: "extract",
        text: "原文",
        schema: input,
      });
      const wire = runner.mock.calls[0]?.[0].schema;
      expect(wire.properties.spans.items.required).toEqual(["quote", "start", "end"]);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
  it("reserves before executing and does not consume a request on denied budget", async () => {
    const runner = vi.fn();
    const afterAttempt = vi.fn();
    await expect(
      createCodexGateway(config, runner).extract({
        route: "extract",
        text: "test",
        schema,
        controls: {
          observer: {
            beforeAttempt: async () => {
              throw new Error("BUDGET");
            },
            afterAttempt,
          },
        },
      }),
    ).rejects.toThrow("BUDGET");
    expect(runner).not.toHaveBeenCalled();
    expect(afterAttempt).not.toHaveBeenCalled();
  });
  it("retains actual usage for invalid JSON and exact schema failures without hidden retry", async () => {
    for (const [text, errorKind] of [
      ["not json", "json_parse"],
      ['{"ok":"wrong"}', "schema_validation"],
    ]) {
      const runner = vi.fn().mockResolvedValue({ text, usage });
      const afterAttempt = vi.fn();
      await expect(
        createCodexGateway(config, runner).extract({
          route: "extract",
          text: "test",
          schema,
          controls: { observer: { beforeAttempt: async () => {}, afterAttempt } },
        }),
      ).rejects.toThrow(errorKind);
      expect(runner).toHaveBeenCalledTimes(1);
      expect(afterAttempt.mock.calls[0]?.[0]).toMatchObject({ errorKind, usage, status: "error" });
    }
  });
  it("classifies a provider usage-limit event without exposing its message", async () => {
    const events = [
      { type: "thread.started" },
      { type: "turn.started" },
      { type: "error", message: "You’ve hit your usage limit. Purchase more credits." },
      { type: "turn.failed", error: { message: "You’ve hit your usage limit." } },
    ];
    const cfg = await binary(
      `process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(events.map((x) => JSON.stringify(x)).join("\n"))}));`,
    );
    await expect(
      processRunner(cfg)({ prompt: "synthetic", schema: {}, timeoutMs: 3000 }),
    ).rejects.toThrow(/^Gateway request failed \(quota\)$/);
  });
  it("does not invent token counts on a transport failure or echo raw errors", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("private source and secret provider"));
    const afterAttempt = vi.fn();
    await expect(
      createCodexGateway(config, runner).extract({
        route: "extract",
        text: "test",
        schema,
        controls: { observer: { beforeAttempt: async () => {}, afterAttempt } },
      }),
    ).rejects.toThrow(/^Gateway request failed \(provider\)$/);
    expect(afterAttempt.mock.calls[0]?.[0]).toMatchObject({
      usage: null,
      status: "error",
      errorKind: "provider",
    });
  });
  it("parses the final JSON event, discards reasoning, and preserves Unicode chunk boundaries", async () => {
    const events = finalEvents.map((e) =>
      e.type === "item.completed" && e.item?.type === "agent_message"
        ? { ...e, item: { type: "agent_message", text: '{"text":"中文🙂"}' } }
        : e,
    );
    const script = `process.stdin.resume();process.stdin.on('end',()=>{const b=Buffer.from(${JSON.stringify(`${events.map((x) => JSON.stringify(x)).join("\n")}\n`)});let i=0;const t=setInterval(()=>{if(i>=b.length){clearInterval(t);return;}process.stdout.write(b.subarray(i,i+1));i++;},1);});`;
    const cfg = await binary(script);
    const result = await processRunner(cfg)({
      prompt: "quoted $(not executed)",
      schema: {},
      timeoutMs: 5000,
    });
    expect(result.text).toBe('{"text":"中文🙂"}');
    expect(result.usage).toEqual(usage);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REASONING");
  });
  it("rejects tool events rather than accepting a result produced from unscoped tools", async () => {
    const events = [
      { type: "item.started", item: { type: "command_execution", command: "synthetic only" } },
      ...finalEvents,
    ];
    const cfg = await binary(
      `process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(events.map((x) => JSON.stringify(x)).join("\n"))}));`,
    );
    await expect(
      processRunner(cfg)({ prompt: "synthetic", schema: {}, timeoutMs: 3000 }),
    ).rejects.toThrow("provider");
  });
  it("rejects malformed but parseable event shapes without crashing the host", async () => {
    for (const event of [
      null,
      { type: 7 },
      { type: "item.completed", item: null },
      { type: "item.completed", item: { type: "agent_message", text: { not: "text" } } },
    ]) {
      const cfg = await binary(
        `process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify(event))}));`,
      );
      await expect(
        processRunner(cfg)({ prompt: "synthetic", schema: {}, timeoutMs: 3000 }),
      ).rejects.toThrow("provider");
    }
  });
  it("times out the owned CLI process without indefinite waiting", async () => {
    const cfg = await binary("process.stdin.resume();setInterval(()=>{},1000);");
    await expect(
      processRunner(cfg)({ prompt: "synthetic", schema: {}, timeoutMs: 100 }),
    ).rejects.toThrow("timeout");
  });
  it("uses null when a successful CLI did not expose usage", async () => {
    const events = finalEvents.map((e) =>
      e.type === "turn.completed" ? { type: "turn.completed" } : e,
    );
    const cfg = await binary(
      `process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(events.map((x) => JSON.stringify(x)).join("\n"))}));`,
    );
    expect(
      (await processRunner(cfg)({ prompt: "synthetic", schema: {}, timeoutMs: 3000 })).usage,
    ).toBeNull();
  });
});
