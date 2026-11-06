import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Db, coreSchema as c } from "@findme/db";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { withProfileTransaction } from "../cloud-diagnostic/scope.js";
import type { PersonalContext } from "../core/exploration-types.js";
import {
  NativeConversationReader,
  questionBackground,
  questionBackgroundSpans,
} from "./native-conversations.js";
import { type PiArchiveDependency, capturePiDependencies } from "./pi-archive.js";

/** Reading tools own lineage collection; the model never supplies dependency ids. */
export function createPiReadTools(
  db: Db,
  ctx: PersonalContext,
  seed: readonly PiArchiveDependency[] = [],
  options: {
    currentMessageId?: string;
    currentConversationId?: string;
    withheldSourceIds?: string[];
  } = {},
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
  const read = async (id: string, includeAnalysis = false) =>
    withProfileTransaction(db, ctx, async (tx) => {
      if (options.withheldSourceIds?.includes(id)) throw new Error("SOURCE_NOT_AVAILABLE");
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
                content:
                  item.authorKind === "assistant" && !includeAnalysis
                    ? questionBackground(item.content) || null
                    : item.content,
                author: item.authorKind,
                background_spans:
                  item.authorKind === "assistant" && !includeAnalysis
                    ? questionBackgroundSpans(item.content)
                    : [],
                context_use:
                  item.authorKind === "assistant"
                    ? "past_question_background_not_current_task"
                    : "source_material",
                sequence: item.sourceMeta?.sequence,
              });
          }
        }
      }
      collect(deps);
      return {
        neighbors,
        id: source.id,
        content:
          source.authorKind === "assistant" && !includeAnalysis
            ? questionBackground(source.content) || null
            : source.content,
        author: source.authorKind,
        background_spans:
          source.authorKind === "assistant" && !includeAnalysis
            ? questionBackgroundSpans(source.content)
            : [],
        context_use:
          source.authorKind === "assistant" && !includeAnalysis
            ? "past_question_background_not_current_task"
            : "source_material",
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
      "按关键词搜索当前资料内的历史原文；零命中或仅命中当前会话时，额外返回最多10条其他会话近期本人原文作为 recent_fallback 候选，并非关键词匹配或已相关的证据。逐条判断相关性，必要时展开问答和纠正，不将近期出现当成支持。",
      { query: { type: "string" } },
      ["query"],
      async (input) => {
        const { query } = z.object({ query: z.string().trim().min(1).max(240) }).parse(input);
        const terms = [...new Set(query.toLocaleLowerCase().split(/\s+/).filter(Boolean))].slice(
          0,
          12,
        );
        return withProfileTransaction(db, ctx, async (tx) => {
          const findRows = (matchTerms: boolean, onlySubject: boolean) =>
            tx
              .select({
                id: c.sourceItems.id,
                conversationId: sql<string | null>`${c.sourceItems.sourceMeta}->>'exploration_id'`,
              })
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
                  ...(matchTerms
                    ? terms.map(
                        (term) => sql`position(${term} in lower(${c.sourceItems.content}))>0`,
                      )
                    : []),
                  onlySubject ? eq(c.sourceItems.authorKind, "subject") : undefined,
                  onlySubject && options.currentConversationId
                    ? sql`coalesce(${c.sourceItems.sourceMeta}->>'exploration_id', '') <> ${options.currentConversationId}`
                    : undefined,
                  options.withheldSourceIds?.length
                    ? notInArray(c.sourceItems.id, options.withheldSourceIds)
                    : undefined,
                  options.currentMessageId
                    ? sql`${c.sourceItems.id} <> ${options.currentMessageId}`
                    : undefined,
                ),
              )
              .orderBy(desc(c.sourceItems.capturedAt), desc(c.sourceItems.id))
              .limit(10);
          const keywordRows = await findRows(true, false);
          const onlyCurrentConversation =
            !!options.currentConversationId &&
            keywordRows.length > 0 &&
            keywordRows.every((row) => row.conversationId === options.currentConversationId);
          const recentRows =
            !keywordRows.length || onlyCurrentConversation ? await findRows(false, true) : [];
          const rows = [...keywordRows, ...recentRows];
          const fallbackIds = new Set(recentRows.map((row) => row.id));
          const retrievalKind = !keywordRows.length
            ? "recent_fallback"
            : onlyCurrentConversation
              ? "keyword_with_recent_fallback"
              : "keyword_match";
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
                retrieval_kind: fallbackIds.has(source.id) ? "recent_fallback" : "keyword_match",
                current_conversation:
                  source.sourceMeta?.exploration_id === options.currentConversationId,
                excerpt:
                  source.authorKind === "assistant"
                    ? questionBackground(source.content).slice(0, 1000) || null
                    : source.content.slice(0, 1000),
                author: source.authorKind,
                conversation_id: source.sourceMeta?.exploration_id ?? null,
                namespace: source.sourceMeta?.namespace ?? null,
              });
          }
          collect(deps);
          return {
            items: result,
            retrieval_kind: retrievalKind,
            query,
            keyword_match_count: keywordRows.length,
            recent_fallback_count: recentRows.length,
            exhaustive: false,
            relevance_instruction:
              retrievalKind !== "keyword_match"
                ? "关键词零命中或只命中当前会话；recent_fallback 仅为其他会话的近期本人原文候选，不是匹配结果。当前会话的重复问题不能算独立历史证据。须逐条判断与当前问题的关系，不能据此声称已发现跨场景模式或证据充分；不相关时说明未找到。"
                : "关键词匹配不等于语义支持，仍须核对表达归属、情境和后续纠正。",
          };
        });
      },
    ),
    make(
      "read_source",
      "读取来源的完整原文和表达归属；助手原文仅作对话背景。",
      { id: { type: "string" }, include_analysis: { type: "boolean" } },
      ["id"],
      async (input) => {
        const args = z
          .object({ id: z.string().uuid(), include_analysis: z.boolean().optional() })
          .parse(input);
        return read(args.id, args.include_analysis ?? false);
      },
    ),
    make(
      "read_conversation",
      "展开原生会话，保留前后问答与后续纠正。",
      {
        id: { type: "string" },
        cursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 30 },
        include_analysis: {
          type: "boolean",
          description: "仅当用户要求复核旧助手判断时启用；默认只读本人表达和必要问答背景。",
        },
      },
      ["id"],
      async (input) => {
        const args = z
          .object({
            id: z.string().uuid(),
            include_analysis: z.boolean().optional(),
            cursor: z.number().int().nonnegative().optional(),
            limit: z.number().int().min(1).max(30).optional(),
          })
          .parse(input);
        const result = await new NativeConversationReader(db).read(ctx, {
          conversationId: args.id,
          beforeSourceId:
            args.id === options.currentConversationId ? options.currentMessageId : undefined,
          includeAnalysis: args.include_analysis ?? false,
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
