import { createRequire } from "node:module";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { zodResponseFormat } from "openai/helpers/zod";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const require = createRequire(import.meta.url);

// Backport of the leading upper-size gate in colinhacks/zod@a0ebf97.
// No artificial cap is added to schemas that have no upper bound.
describe("Zod3 constrained collection backport", () => {
  for (const [entry, api] of [
    ["ESM", z],
    ["CommonJS", require("zod").z],
  ] as const) {
    it(`${entry}: rejects oversized arrays before visiting elements or outer refinements`, async () => {
      let visits = 0;
      const element = api.preprocess((value: unknown) => {
        visits++;
        return value;
      }, api.string());
      const schema = api.object({ items: api.array(element).max(2, "too many") });
      const input = { items: Array(10000).fill(0) };
      for (const result of [schema.safeParse(input), await schema.safeParseAsync(input)]) {
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toHaveLength(1);
          expect(result.error.issues).toEqual([
            {
              code: "too_big",
              maximum: 2,
              type: "array",
              inclusive: true,
              exact: false,
              message: "too many",
              path: ["items"],
            },
          ]);
        }
      }
      let refined = 0;
      expect(
        api
          .array(element)
          .length(2)
          .refine(() => {
            refined++;
            return true;
          })
          .safeParse(["a", "b", "c"]).success,
      ).toBe(false);
      expect([visits, refined]).toEqual([0, 0]);
      // A sparse array must also be rejected without spreading/walking its length.
      expect(api.array(element).max(2).safeParse(new Array(1000000)).success).toBe(false);
    });

    it(`${entry}: rejects oversized sets before parsing their contents, including async`, async () => {
      let visits = 0;
      const schema = api
        .set(
          api.string().refine(() => {
            visits++;
            return true;
          }),
        )
        .max(1);
      for (const result of [
        schema.safeParse(new Set([1, 2])),
        await schema.safeParseAsync(new Set([1, 2])),
      ]) {
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.issues).toHaveLength(1);
      }
      expect(visits).toBe(0);
    });
  }

  it("preserves bounded values, transforms, error fields and stored JSON", () => {
    const schema = z.object({
      items: z.array(z.string().trim()).min(1).max(2),
      revision: z.literal(1),
    });
    const historical = '{"items":["a","b"],"revision":1}';
    expect(JSON.stringify(schema.parse(JSON.parse(historical)))).toBe(historical);
    expect(schema.parse({ items: [" a "], revision: 1 })).toEqual({ items: ["a"], revision: 1 });
    const result = schema.safeParse({ items: [1], revision: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        {
          code: "invalid_type",
          expected: "string",
          received: "number",
          path: ["items", 0],
          message: "Expected string, received number",
        },
      ]);
      expect(result.error.flatten()).toEqual({
        formErrors: [],
        fieldErrors: { items: ["Expected string, received number"] },
      });
    }
    expect(z.array(z.string()).length(2).safeParse(["a"]).success).toBe(false);
    expect(z.array(z.number()).parse([1, 2, 3])).toEqual([1, 2, 3]);
    expect(z.map(z.string(), z.number()).parse(new Map([["a", 1]]))).toEqual(new Map([["a", 1]]));
    expect(z.array(z.string()).max(0).safeParse(["a"]).success).toBe(false);
    expect(z.array(z.string()).length(0).parse([])).toEqual([]);
    expect(z.set(z.string()).max(0).parse(new Set())).toEqual(new Set());
  });

  it("keeps HTTP validator response and OpenAI structured-output schema shapes", async () => {
    const schema = z.object({ items: z.array(z.string()).max(2) });
    const app = new Hono().post("/", zValidator("json", schema), (c) =>
      c.json(c.req.valid("json")),
    );
    const good = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"items":["a"]}',
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ items: ["a"] });
    const bad = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"items":[1]}',
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      success: false,
      error: { name: "ZodError", issues: [{ code: "invalid_type", path: ["items", 0] }] },
    });
    expect(JSON.parse(JSON.stringify(zodResponseFormat(schema, "bounded")))).toEqual({
      type: "json_schema",
      json_schema: {
        name: "bounded",
        strict: true,
        schema: {
          type: "object",
          properties: { items: { type: "array", items: { type: "string" }, maxItems: 2 } },
          required: ["items"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      },
    });
  });
});
