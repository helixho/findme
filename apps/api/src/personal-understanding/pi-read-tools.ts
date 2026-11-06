import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Db, coreSchema as c } from "@findme/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { withProfileTransaction } from "../cloud-diagnostic/scope.js";
import type { PersonalContext } from "../core/exploration-types.js";
import { NativeConversationReader } from "./native-conversations.js";
import { type PiArchiveDependency, capturePiDependencies } from "./pi-archive.js";

/** Reading tools own lineage collection; the model never supplies dependency ids. */
export function createPiReadTools(
  db: Db,
  ctx: PersonalContext,
  seed: readonly PiArchiveDependency[] = [],
): { tools: ToolDefinition[]; dependencies: () => PiArchiveDependency[] } {
  const dependencies = new Map(seed.map((d) => [d.sourceId, d.fingerprint]));
  const collect = (items: readonly PiArchiveDependency[]) => {
    for (const item of items) {
      const previous = dependencies.get(item.sourceId);
      if (previous && previous !== item.fingerprint)
        throw new Error("PI_SOURCE_CHANGED_DURING_RUN");
      dependencies.set(item.sourceId, item.fingerprint);
    }
  };
  const read = async (id: string) =>
    withProfileTransaction(db, ctx, async (tx) => {
      const deps = await capturePiDependencies(tx, ctx, [id]);
      const [source] = await tx
        .select()
        .from(c.sourceItems)
        .where(
          and(
            eq(c.sourceItems.id, id),
            eq(c.sourceItems.tenantId, ctx.tenantId),
            eq(c.sourceItems.subjectId, ctx.subjectId),
          ),
        )
        .limit(1);
      if (!source) throw new Error("SOURCE_NOT_AVAILABLE");
      const neighbors: unknown[] = [];
      const namespace = source.sourceMeta?.namespace;
      const sequence = Number(source.sourceMeta?.sequence);
      if (typeof namespace === "string" && Number.isSafeInteger(sequence)) {
        const nearby = await tx
          .select({ id: c.sourceItems.id })
          .from(c.sourceItems)
          .innerJoin(
            c.sourceAssessments,
            and(
              eq(c.sourceAssessments.sourceItemId, c.sourceItems.id),
              eq(c.sourceAssessments.isCurrent, true),
            ),
          )
          .where(
            and(
              eq(c.sourceItems.tenantId, ctx.tenantId),
              eq(c.sourceItems.subjectId, ctx.subjectId),
              eq(c.sourceItems.usageStatus, "active"),
              sql`${c.sourceAssessments.eligibility} in ('eligible','context_only')`,
              sql`${c.sourceItems.sourceMeta}->>'namespace'=${namespace}`,
              sql`case when (${c.sourceItems.sourceMeta}->>'sequence') ~ '^[0-9]+$' then (${c.sourceItems.sourceMeta}->>'sequence')::integer between ${Math.max(0, sequence - 2)} and ${sequence + 2} else false end`,
            ),
          )
          .limit(5);
        if (nearby.length) {
          const extra = await capturePiDependencies(
            tx,
            ctx,
            nearby.map((row) => row.id),
          );
          collect(extra);
          for (const row of nearby) {
            const [item] = await tx
              .select()
              .from(c.sourceItems)
              .where(eq(c.sourceItems.id, row.id))
              .limit(1);
            if (item)
              neighbors.push({
                id: item.id,
                content: item.content,
                author: item.authorKind,
                sequence: item.sourceMeta?.sequence,
              });
          }
        }
      }
      collect(deps);
      return {
        neighbors,
        id: source.id,
        content: source.content,
        author: source.authorKind,
        source_kind: source.sourceKind,
        qualification: "source_expression_not_automatic_evidence",
        // Only context identifiers, never arbitrary sourceMeta prompts or old generated text.
        conversation_id: source.sourceMeta?.exploration_id ?? null,
        namespace: source.sourceMeta?.namespace ?? null,
        sequence: source.sourceMeta?.sequence ?? null,
      };
    });
  const make = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    run: (input: unknown) => Promise<unknown>,
  ): ToolDefinition => ({
    name,
    label: name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    } as unknown as ToolDefinition["parameters"],
    execute: async (_id, input) => ({
      content: [{ type: "text", text: JSON.stringify(await run(input)) }],
      details: {},
    }),
  });
  const tools = [
    make(
      "search_history",
      "按关键词搜索当前资料内的历史原文；未命中不代表不存在，可改词后重试。",
      { query: { type: "string" } },
      ["query"],
      async (input) => {
        const { query } = z.object({ query: z.string().trim().min(1).max(240) }).parse(input);
        return withProfileTransaction(db, ctx, async (tx) => {
          const rows = await tx
            .select({ id: c.sourceItems.id })
            .from(c.sourceItems)
            .innerJoin(
              c.sourceAssessments,
              and(
                eq(c.sourceAssessments.sourceItemId, c.sourceItems.id),
                eq(c.sourceAssessments.isCurrent, true),
              ),
            )
            .where(
              and(
                eq(c.sourceItems.tenantId, ctx.tenantId),
                eq(c.sourceItems.subjectId, ctx.subjectId),
                eq(c.sourceItems.usageStatus, "active"),
                sql`${c.sourceAssessments.eligibility} in ('eligible','context_only')`,
                sql`position(${query.toLowerCase()} in lower(${c.sourceItems.content}))>0`,
              ),
            )
            .orderBy(desc(c.sourceItems.capturedAt), desc(c.sourceItems.id))
            .limit(10);
          const deps = rows.length
            ? await capturePiDependencies(
                tx,
                ctx,
                rows.map((row) => row.id),
              )
            : [];
          // Read after dependency locks, not before, so text and fingerprint are one version.
          const result = [];
          for (const row of rows) {
            const [source] = await tx
              .select()
              .from(c.sourceItems)
              .where(eq(c.sourceItems.id, row.id))
              .limit(1);
            if (source)
              result.push({
                id: source.id,
                excerpt: source.content.slice(0, 1000),
                author: source.authorKind,
                conversation_id: source.sourceMeta?.exploration_id ?? null,
                namespace: source.sourceMeta?.namespace ?? null,
              });
          }
          collect(deps);
          return { items: result, exhaustive: false };
        });
      },
    ),
    make(
      "read_source",
      "读取来源的完整原文和表达归属；助手原文仅作对话背景。",
      { id: { type: "string" } },
      ["id"],
      async (input) => read(z.object({ id: z.string().uuid() }).parse(input).id),
    ),
    make(
      "read_conversation",
      "展开原生会话，保留前后问答与后续纠正。",
      {
        id: { type: "string" },
        cursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
      ["id"],
      async (input) => {
        const args = z
          .object({
            id: z.string().uuid(),
            cursor: z.number().int().nonnegative().optional(),
            limit: z.number().int().min(1).max(30).optional(),
          })
          .parse(input);
        const result = await new NativeConversationReader(db).read(ctx, {
          conversationId: args.id,
          cursor: args.cursor,
          limit: args.limit,
        });
        collect(result.dependencies);
        return result;
      },
    ),
  ];
  return {
    tools,
    dependencies: () =>
      [...dependencies].map(([sourceId, fingerprint]) => ({ sourceId, fingerprint })),
  };
}
