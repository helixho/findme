import { createHash } from "node:crypto";
import { z } from "zod";
import { ConversationReplySchema } from "../core/llm.js";

export type ReviewSegment = { id: string; text: string; start: number; end: number };

/** Sentence targets keep line boundaries and all original separators untouched. */
export function reviewSegments(candidate: string): ReviewSegment[] {
  const segments: ReviewSegment[] = [];
  const sentences = new Intl.Segmenter("zh", { granularity: "sentence" });
  for (const line of candidate.matchAll(/[^\r\n]+/g)) {
    if (!line[0].trim()) continue;
    for (const sentence of sentences.segment(line[0])) {
      const text = sentence.segment.trimEnd();
      if (!text.trim()) continue;
      const start = line.index + sentence.index;
      segments.push({ id: `b${segments.length + 1}`, text, start, end: start + text.length });
    }
  }
  return segments;
}

const Basis = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("evidence") }).strict(),
  z
    .object({
      kind: z.literal("user_constraint"),
      quote: z.string().trim().min(1).max(1000),
      scope: z.enum(["current_turn", "ongoing_preference"]),
    })
    .strict(),
]);
const Shared = {
  target_id: z.string().regex(/^b[1-9]\d*$/),
  reason: z.string().trim().min(1).max(400),
  basis: Basis,
};
const Edit = z.discriminatedUnion("operation", [
  z
    .object({
      ...Shared,
      operation: z.literal("replace"),
      replacement: ConversationReplySchema.shape.reply.refine((value) => !!value.trim()),
    })
    .strict(),
  z.object({ ...Shared, operation: z.literal("delete") }).strict(),
]);
const Review = z.object({ edits: z.array(Edit).max(12) }).strict();
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");

/** Apply only validated edits. The returned audit describes executed changes, not model claims. */
export function decodePiReview(
  output: string,
  candidate: string,
  userText: { current: string; history: readonly string[] } = { current: "", history: [] },
) {
  try {
    const parsed = Review.parse(
      JSON.parse(
        output
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, ""),
      ),
    );
    const segments = reviewSegments(candidate);
    const seen = new Set<string>();
    const applied = parsed.edits.map((edit) => {
      const target = segments.find((segment) => segment.id === edit.target_id);
      if (!target || seen.has(edit.target_id)) throw new Error("unknown or repeated target");
      seen.add(edit.target_id);
      if (edit.basis.kind === "user_constraint") {
        const { quote, scope } = edit.basis;
        const originals =
          scope === "current_turn" ? [userText.current] : [...userText.history, userText.current];
        if (!originals.some((text) => text.includes(quote)))
          throw new Error("constraint quote absent from user input");
      }
      const after = edit.operation === "delete" ? "" : edit.replacement;
      if (after === target.text) throw new Error("edit has no effect");
      return {
        target_id: target.id,
        operation: edit.operation,
        start: target.start,
        end: target.end,
        before: target.text,
        after,
        reason: edit.reason,
        basis: edit.basis,
      };
    });
    let reply = candidate;
    for (const edit of [...applied].sort((a, b) => b.start - a.start))
      reply = reply.slice(0, edit.start) + edit.after + reply.slice(edit.end);
    ConversationReplySchema.shape.reply.parse(reply);
    if (!reply.trim()) throw new Error("invalid applied reply");
    return {
      reply,
      audit: {
        format: "findme-review-edits@1",
        candidate_sha256: fingerprint(candidate),
        result_sha256: fingerprint(reply),
        applied_edits: applied,
      },
    };
  } catch {
    throw new Error("PI_REPLY_FORMAT_INVALID");
  }
}
