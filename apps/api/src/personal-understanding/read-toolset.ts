import { z } from "zod";
import type { PersonalContext } from "../core/exploration-service.js";
import type { ContextTask } from "./context.js";
import { METHOD_NAMES, type UnderstandingMethods } from "./methods.js";
import type { UnderstandingReadTools } from "./read-tools.js";

const id = z.string().uuid();
const page = {
  cursor: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(50).optional(),
};
const noArgs = z.object({}).strict();
const method = z.enum(METHOD_NAMES);
const summary = z
  .object({
    text: z.string().min(1).max(8000),
    dependencies: z
      .array(z.object({ id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
      .min(1)
      .max(50),
  })
  .strict();

/** Tool names and their validation are application-owned, independent of a harness SDK. */
export const UNDERSTANDING_READ_TOOL_INPUTS = {
  search_sources: z.object({ query: z.string().trim().max(240).optional(), ...page }).strict(),
  read_source: z
    .object({
      id,
      start: z.number().int().nonnegative().optional(),
      end: z.number().int().positive().optional(),
      includeAnalysis: z.boolean().optional(),
    })
    .strict(),
  browse_understandings: z
    .object({ ...page, claimId: id.optional(), includeHistory: z.boolean().optional() })
    .strict(),
  read_revision: z
    .object({
      id,
      includeHistory: z.boolean().optional(),
      feedbackCursor: z.number().int().nonnegative().optional(),
      feedbackLimit: z.number().int().min(1).max(20).optional(),
    })
    .strict(),
  read_conversation: z
    .object({
      namespace: z.string().min(1).max(160),
      includeAnalysis: z.boolean().optional(),
      ...page,
    })
    .strict(),
  coverage: noArgs,
  read_applicable_preferences: z.object(page).strict(),
  list_methods: noArgs,
  read_method: z.object({ name: method }).strict(),
  read_method_reference: z
    .object({ name: method, file: z.string().regex(/^[a-zA-Z0-9_-]+\.md$/) })
    .strict(),
  validate_summary: summary,
} as const;
export type UnderstandingReadToolName = keyof typeof UNDERSTANDING_READ_TOOL_INPUTS;

type SummaryReader = {
  readSource(
    ctx: PersonalContext,
    input: { id: string; start?: number; end?: number },
  ): Promise<{ source: { id: string; fingerprint: string } }>;
};

/** A summary is caller-supplied derived text; this checks its dependencies, never its semantic truth. */
export async function validateUnderstandingSummary(
  reader: SummaryReader,
  ctx: PersonalContext,
  raw: unknown,
) {
  const input = summary.parse(raw);
  const unique = new Map(input.dependencies.map((d) => [d.id, d.fingerprint]));
  if (unique.size !== input.dependencies.length) throw new Error("DUPLICATE_SUMMARY_DEPENDENCY");
  for (const dependency of input.dependencies) {
    try {
      const result = await reader.readSource(ctx, { id: dependency.id });
      if (
        result.source.id !== dependency.id ||
        result.source.fingerprint !== dependency.fingerprint
      )
        return {
          status: "unavailable" as const,
          reason: "source_changed_or_unavailable",
          rebuildRequired: true,
        };
    } catch {
      // No stale cached text, cross-profile ids or distinction between absent and inaccessible sources leaks out.
      return {
        status: "unavailable" as const,
        reason: "source_changed_or_unavailable",
        rebuildRequired: true,
      };
    }
  }
  return {
    status: "available" as const,
    kind: "derived_summary" as const,
    qualification: "context_only" as const,
    semanticVerification: "not_performed" as const,
    text: input.text,
    dependencies: input.dependencies,
  };
}

/** ctx is resolved by the authenticated task boundary, never accepted from model tool arguments. */
export class UnderstandingReadToolset {
  private readonly ctx: PersonalContext;
  constructor(
    private readonly reader: UnderstandingReadTools,
    ctx: PersonalContext,
    private readonly methods: UnderstandingMethods,
    private readonly task?: ContextTask,
  ) {
    this.ctx = structuredClone(ctx);
  }

  async call(name: UnderstandingReadToolName, raw: unknown) {
    if (!Object.hasOwn(UNDERSTANDING_READ_TOOL_INPUTS, name))
      throw new Error("UNKNOWN_UNDERSTANDING_READ_TOOL");
    let result: unknown;
    switch (name) {
      case "search_sources":
        result = await this.reader.searchSources(
          this.ctx,
          UNDERSTANDING_READ_TOOL_INPUTS[name].parse(raw),
        );
        break;
      case "read_source":
        result = await this.reader.readSource(
          this.ctx,
          UNDERSTANDING_READ_TOOL_INPUTS[name].parse(raw),
        );
        break;
      case "browse_understandings":
        result = await this.reader.listUnderstandings(
          this.ctx,
          UNDERSTANDING_READ_TOOL_INPUTS[name].parse(raw),
        );
        break;
      case "read_revision":
        result = await this.reader.readRevision(
          this.ctx,
          UNDERSTANDING_READ_TOOL_INPUTS[name].parse(raw),
        );
        break;
      case "read_conversation":
        result = await this.reader.readConversation(
          this.ctx,
          UNDERSTANDING_READ_TOOL_INPUTS[name].parse(raw),
        );
        break;
      case "coverage":
        UNDERSTANDING_READ_TOOL_INPUTS[name].parse(raw);
        result = await this.reader.coverage(this.ctx);
        break;
      case "read_applicable_preferences":
        if (!this.task) throw new Error("TASK_CONTEXT_NOT_SET");
        result = await this.reader.interactionPreferences(
          this.ctx,
          this.task,
          UNDERSTANDING_READ_TOOL_INPUTS[name].parse(raw),
        );
        break;
      case "list_methods":
        UNDERSTANDING_READ_TOOL_INPUTS[name].parse(raw);
        result = await this.methods.catalog();
        break;
      case "read_method":
        result = await this.methods.load(UNDERSTANDING_READ_TOOL_INPUTS[name].parse(raw).name);
        break;
      case "read_method_reference": {
        const args = UNDERSTANDING_READ_TOOL_INPUTS[name].parse(raw);
        result = await this.methods.reference(args.name, args.file);
        break;
      }
      case "validate_summary":
        result = await validateUnderstandingSummary(this.reader, this.ctx, raw);
        break;
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024)
      throw new Error("UNDERSTANDING_TOOL_OUTPUT_TOO_LARGE");
    return result;
  }
}
