import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Db, coreSchema as c } from "@findme/db";
import { and, desc, eq, lte, notInArray, sql } from "drizzle-orm";
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
    asOf?: string;
  } = {},
): { tools: ToolDefinition[]; dependencies: () => PiArchiveDependency[] } {
  const asOf = options.asOf
    ? new Date(z.string().datetime({ offset: true }).parse(options.asOf))
    : undefined;
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
            asOf ? lte(c.sourceItems.capturedAt, asOf) : undefined,
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
              asOf ? lte(c.sourceItems.capturedAt, asOf) : undefined,
              options.withheldSourceIds?.length
                ? notInArray(c.sourceItems.id, options.withheldSourceIds)
                : undefined,
              options.currentMessageId
                ? sql`${c.sourceItems.id} <> ${options.currentMessageId}`
                : undefined,
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
  const discover = async (query?: string) =>
    withProfileTransaction(db, ctx, async (tx) => {
      const terms = query
        ? [...new Set(query.toLocaleLowerCase().split(/\s+/).filter(Boolean))].slice(0, 12)
        : [];
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
            query ? undefined : eq(c.sourceItems.authorKind, "subject"),
            !query && options.currentConversationId
              ? sql`coalesce(${c.sourceItems.sourceMeta}->>'exploration_id','') <> ${options.currentConversationId}`
              : undefined,
            ...terms.map((term) => sql`position(${term} in lower(${c.sourceItems.content}))>0`),
            asOf ? lte(c.sourceItems.capturedAt, asOf) : undefined,
            options.withheldSourceIds?.length
              ? notInArray(c.sourceItems.id, options.withheldSourceIds)
              : undefined,
            options.currentMessageId
              ? sql`${c.sourceItems.id} <> ${options.currentMessageId}`
              : undefined,
          ),
        )
        .orderBy(desc(c.sourceItems.capturedAt), desc(c.sourceItems.id))
        .limit(query ? 10 : 100);
      const deps = rows.length
        ? await capturePiDependencies(
            tx,
            ctx,
            rows.map((row) => row.id),
          )
        : [];
      const items = [];
      const groups = new Set<string>();
      const selected = new Set<string>();
      for (const row of rows) {
        const [source] = await tx
          .select()
          .from(c.sourceItems)
          .where(eq(c.sourceItems.id, row.id))
          .limit(1);
        if (!source || (asOf && source.capturedAt > asOf)) continue;
        const conversationId =
          typeof source.sourceMeta?.exploration_id === "string"
            ? source.sourceMeta.exploration_id
            : null;
        const namespace =
          typeof source.sourceMeta?.namespace === "string" ? source.sourceMeta.namespace : null;
        const group = conversationId ?? namespace ?? source.id;
        if (!query && groups.has(group)) continue;
        groups.add(group);
        selected.add(source.id);
        const expression =
          source.authorKind === "assistant" ? questionBackground(source.content) : source.content;
        items.push({
          id: source.id,
          source_id: source.id,
          conversation_id: conversationId,
          namespace,
          title: expression.slice(0, 80) || "原问题背景需展开查看",
          recorded_at: source.capturedAt.toISOString(),
          author: source.authorKind,
          stage: "discovery_only",
          current_conversation:
            !!options.currentConversationId && conversationId === options.currentConversationId,
        });
        if (items.length === 10) break;
      }
      collect(deps.filter((dep) => selected.has(dep.sourceId)));
      return {
        items,
        stage: "discovery_only",
        retrieval_kind: query ? "keyword_match" : "conversation_clues",
        query: query ?? null,
        content_as_of: options.asOf ?? null,
        exhaustive: false,
        relevance_instruction:
          "这些是定位线索，不是已采用的证据。需要原文时按需展开并说明用途和与当前问题的关系；找不到相关材料时可以说明未找到。线索相邻、近期或关键词相同都不能证明相关或同一机制。",
      };
    });
  const UseDeclaration = z.object({
    intended_use: z.enum(["fact_context", "analogy", "counterexample"]),
    relation: z.string().trim().min(1).max(600),
  });
  const useProperties = {
    intended_use: {
      type: "string",
      enum: ["fact_context", "analogy", "counterexample"],
      description: "本次展开预期用途：事实背景、类比或反例",
    },
    relation: {
      type: "string",
      description: "说明这段材料与当前问题的具体关系；此声明仍须复核，不证明相关性",
    },
  };
  const declared = <T>(value: T, input: z.infer<typeof UseDeclaration>) => ({
    ...value,
    use_declaration: { ...input, status: "proposed_not_verified" },
    adoption_instruction:
      "原文被读取不等于已支持当前结论。只按声明用途核对；类比不是本人事实或共同机制的证明。一般建议可独立给出，不以无关经历包装为个性化依据。",
  });
  const tools = [
    make(
      "search_history",
      "按关键词查找当前资料内的历史定位线索；零命中就是零命中，不自动混入近期原文。需要找回旧会话时可另用discover_conversations，再判断是否值得展开。",
      { query: { type: "string" } },
      ["query"],
      async (input) => {
        const { query } = z.object({ query: z.string().trim().min(1).max(240) }).parse(input);
        return discover(query);
      },
    ),
    make(
      "discover_conversations",
      "按需找回其他会话的有界线索：只返回来自合格本人原文的短标题、时间和编号，不返回正文，不声称相关。用于用户提及旧讨论但关键词无法定位时；可以找不到相关会话。",
      {},
      [],
      async () => discover(),
    ),
    make(
      "read_source",
      "读取来源的完整原文和表达归属；助手原文仅作对话背景。",
      { id: { type: "string" }, include_analysis: { type: "boolean" }, ...useProperties },
      ["id", "intended_use", "relation"],
      async (input) => {
        const args = z
          .object({ id: z.string().uuid(), include_analysis: z.boolean().optional() })
          .merge(UseDeclaration)
          .parse(input);
        return declared(
          await read(args.id, args.include_analysis ?? false),
          UseDeclaration.parse(args),
        );
      },
    ),
    make(
      "read_conversation",
      "展开原生会话，保留前后问答与后续纠正。",
      {
        id: { type: "string" },
        cursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 30 },
        ...useProperties,
        include_analysis: {
          type: "boolean",
          description: "仅当用户要求复核旧助手判断时启用；默认只读本人表达和必要问答背景。",
        },
      },
      ["id", "intended_use", "relation"],
      async (input) => {
        const args = z
          .object({
            id: z.string().uuid(),
            include_analysis: z.boolean().optional(),
            cursor: z.number().int().nonnegative().optional(),
            limit: z.number().int().min(1).max(30).optional(),
          })
          .merge(UseDeclaration)
          .parse(input);
        const result = await new NativeConversationReader(db).read(ctx, {
          asOf: options.asOf,
          conversationId: args.id,
          beforeSourceId:
            args.id === options.currentConversationId ? options.currentMessageId : undefined,
          includeAnalysis: args.include_analysis ?? false,
          cursor: args.cursor,
          limit: args.limit,
        });
        collect(result.dependencies);
        return declared(result, UseDeclaration.parse(args));
      },
    ),
  ];
  return {
    tools,
    dependencies: () =>
      [...dependencies].map(([sourceId, fingerprint]) => ({ sourceId, fingerprint })),
  };
}
