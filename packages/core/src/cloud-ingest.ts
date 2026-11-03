import { z } from "zod";
import { AuthorKind, SourceKind } from "./model.js";
export const CoreImportSource = z
  .object({
    external_id: z.string().min(1).max(160),
    version: z.number().int().positive(),
    root_id: z.string().min(1).max(160),
    text: z.string().min(1).max(50000),
    author: AuthorKind,
    kind: SourceKind,
    reported_at: z.string().datetime({ offset: true }),
    occurred_at: z.string().datetime({ offset: true }).nullable(),
    split: z.enum(["dev", "holdout"]),
    excluded: z.boolean().default(false),
    about: z.enum(["self", "project", "third_party", "unknown"]),
    stance: z.enum(["endorsed", "not_endorsed", "opposed", "reported", "unknown"]),
    spans: z
      .array(
        z
          .object({
            start: z.number().int().nonnegative(),
            end: z.number().int().positive(),
            quote: z.string().min(1).max(50000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((s, ctx) => {
    for (const e of s.spans) {
      if (e.end <= e.start || s.text.slice(e.start, e.end) !== e.quote || e.end > s.text.length)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid exact source span" });
    }
  });
export const CoreImportEnvelope = z
  .object({
    format: z.literal("findme-core-ingest@1"),
    namespace: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9._-]+$/),
    sources: z.array(CoreImportSource).min(1).max(100),
    historical_reports: z
      .array(
        z
          .object({
            external_id: z.string().min(1).max(200),
            body: z.record(z.unknown()),
            status: z.literal("candidate"),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = v.sources.map((s) => `${s.external_id}@${s.version}`);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate source version" });
  });
export type CoreImportEnvelope = z.infer<typeof CoreImportEnvelope>;
