import { z } from "zod";

const HttpsSourceUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:");

export const Confidence = z.enum([
  "high_consensus",
  "common_framework",
  "contested",
  "philosophy_lens",
]);

const CorpusProvenance = z.object({
  sourceId: z.string().min(1).optional(),
  sourceUrl: HttpsSourceUrl.optional(),
  licenseStatus: z
    .enum([
      "public_domain",
      "open_access",
      "official_public_page",
      "user_owned",
      "metadata_only",
      "unknown_do_not_use",
    ])
    .optional(),
  usableScope: z.string().min(1).optional(),
  evidenceRefs: z.array(z.string().min(1)).optional(),
  corpusGeneratedAt: z.string().min(1).optional(),
  reviewStatus: z.enum(["content_ready", "draft_ready", "needs_review", "do_not_use"]).optional(),
});

export const SeedMaterial = CorpusProvenance.extend({
  type: z.enum(["concept", "figure", "book"]),
  title: z.string().min(1),
  body: z.string().min(1),
  domain: z.string().min(1),
  lens: z.string().min(1),
  confidence: Confidence,
  hook: z.string().min(1),
  boundary: z.string().min(1),
  reflect: z.string().min(1),
  reflectPrompts: z.array(z.string().min(1)).min(1),
  entryPrompt: z.string().min(1),
  source: HttpsSourceUrl.optional(),
  linkedQuestionnaires: z.array(z.string().min(1)).optional(),
});

export const SeedQuestionItem = z.object({
  itemKey: z.string().min(1).optional(),
  prompt: z.string().min(1),
  format: z.enum(["single_choice", "multi_choice", "likert_scale", "free_text", "boolean"]),
  options: z.array(z.string()),
  evidenceRefs: z.array(z.string().min(1)).optional(),
});

export const SeedQuestionnaire = CorpusProvenance.extend({
  name: z.string().min(1),
  type: z.string().min(1),
  source: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  lens: z.string().min(1).optional(),
  intro: z.string().min(1).optional(),
  items: z.array(SeedQuestionItem).min(1),
});
