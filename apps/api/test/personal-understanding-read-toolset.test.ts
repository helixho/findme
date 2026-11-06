import { describe, expect, it } from "vitest";
import {
  UNDERSTANDING_READ_TOOL_INPUTS,
  validateUnderstandingSummary,
} from "../src/personal-understanding/read-toolset.js";
const ctx = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  subjectId: "00000000-0000-4000-8000-000000000002",
};
const sourceId = "00000000-0000-4000-8000-000000000003";
const fingerprint = "a".repeat(64);
const input = {
  text: "一段有引用但尚未语义审核的摘要",
  dependencies: [{ id: sourceId, fingerprint }],
};
describe("read tool summary and boundary contracts", () => {
  it("does not return summary text after a source changes", async () => {
    const result = await validateUnderstandingSummary(
      { readSource: async () => ({ source: { id: sourceId, fingerprint: "b".repeat(64) } }) },
      ctx,
      input,
    );
    expect(result.status).toBe("unavailable");
    expect(result).not.toHaveProperty("text");
  });
  it("does not resurrect cached text when a source is excluded, deleted or inaccessible", async () => {
    for (const reason of ["excluded", "deleted", "wrong profile", "database unavailable"]) {
      const result = await validateUnderstandingSummary(
        {
          readSource: async () => {
            throw Error(reason);
          },
        },
        ctx,
        input,
      );
      expect(result).toEqual({
        status: "unavailable",
        reason: "source_changed_or_unavailable",
        rebuildRequired: true,
      });
    }
  });
  it("validates every dependency, not just one or all excluded", async () => {
    const second = "00000000-0000-4000-8000-000000000004";
    const result = await validateUnderstandingSummary(
      {
        readSource: async (_, args) => {
          if (args.id === second) throw Error("excluded");
          return { source: { id: args.id, fingerprint } };
        },
      },
      ctx,
      { ...input, dependencies: [...input.dependencies, { id: second, fingerprint }] },
    );
    expect(result.status).toBe("unavailable");
    expect(result).not.toHaveProperty("text");
  });
  it("valid dependencies qualify only as derived context, not a verified fact", async () => {
    const result = await validateUnderstandingSummary(
      {
        readSource: async (scope, args) => {
          expect(scope).toEqual(ctx);
          expect(args.id).toBe(sourceId);
          return { source: { id: sourceId, fingerprint } };
        },
      },
      ctx,
      input,
    );
    expect(result).toMatchObject({
      status: "available",
      qualification: "context_only",
      semanticVerification: "not_performed",
      text: input.text,
    });
  });
  it("rejects missing/duplicate dependencies and model-supplied tenant overrides", async () => {
    const reader = { readSource: async () => ({ source: { id: sourceId, fingerprint } }) };
    await expect(
      validateUnderstandingSummary(reader, ctx, { ...input, dependencies: [] }),
    ).rejects.toThrow();
    await expect(
      validateUnderstandingSummary(reader, ctx, {
        ...input,
        dependencies: [...input.dependencies, ...input.dependencies],
      }),
    ).rejects.toThrow("DUPLICATE");
    expect(() =>
      UNDERSTANDING_READ_TOOL_INPUTS.search_sources.parse({ query: "a", tenantId: ctx.tenantId }),
    ).toThrow();
    expect(() => UNDERSTANDING_READ_TOOL_INPUTS.search_sources.parse({ limit: 1000 })).toThrow();
  });
});
