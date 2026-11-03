import { UnderstandingType } from "@findme/core";
import { ReasoningStance } from "@findme/core";
import { AuthorKind } from "@findme/core";
import { z } from "zod";

/** Fallible semantic candidates; only an independent same-input audit enables use. */
export const UnderstandingQualification = z
  .object({
    notes: z
      .array(
        z
          .object({
            note_id: z.string().min(1).max(200),
            reason: z.string().min(1).max(2400),
            propositions: z
              .array(
                z
                  .object({
                    quote: z.string().min(1).max(2400),
                    start: z.number().int().nonnegative(),
                    end: z.number().int().positive(),
                    author: AuthorKind,
                    about: z.enum(["self", "project", "third_party", "unknown"]),
                    kind: z.enum([
                      "self_report",
                      "evaluation",
                      "choice",
                      "work_requirement",
                      "quotation",
                      "system_wrapper",
                      "unknown",
                    ]),
                    stance: ReasoningStance,
                    type: UnderstandingType,
                    purpose: z.enum([
                      "personal_expression",
                      "project_report",
                      "command_context",
                      "context_only",
                    ]),
                    proposition: z.string().min(1).max(2400),
                    scope: z.string().min(1).max(2400),
                    reason: z.string().min(1).max(2400),
                  })
                  .strict(),
              )
              .max(3),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export type UnderstandingQualification = z.infer<typeof UnderstandingQualification>;
