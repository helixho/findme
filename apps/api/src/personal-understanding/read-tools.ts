import { type Db, coreSchema as c, platformSchema as p } from "@findme/db";
import { and, desc, eq, inArray, lte, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type ProfileTransaction,
  lockPiProfileState,
  withProfileTransaction,
} from "../cloud-diagnostic/scope.js";
import type { PersonalContext } from "../core/exploration-types.js";
import { REASSESSMENT_FEEDBACK_TYPES, currentRevisionFeedback } from "../core/pending-feedback.js";
import { lexicalScores } from "../diagnostic-reasoning/ranking.js";
import { questionBackgroundSpans } from "./choice-context.js";
import { type ContextTask, type InteractionPreference, applicablePreferences } from "./context.js";
import { capturePiDependencies } from "./pi-archive.js";
import { capturePiRevisionDependency } from "./revision-dependencies.js";

const MAX_PAGE = 50;
const MAX_SOURCE_TEXT = 4000;
type Source = typeof c.sourceItems.$inferSelect;
type Assessment = typeof c.sourceAssessments.$inferSelect;
type Claim = typeof c.claims.$inferSelect;
type Revision = typeof c.claimRevisions.$inferSelect;
export type UnderstandingReadOptions = { asOf?: string; withheldSourceIds?: readonly string[] };
const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turn"), id: z.string().uuid() }),
  z.object({ kind: z.literal("conversation"), id: z.string().min(1) }),
  z.object({ kind: z.literal("topic"), id: z.string().min(1) }),
  z.object({ kind: z.literal("task"), id: z.string().min(1) }),
  z.object({ kind: z.literal("default"), explicitlyLongTerm: z.literal(true) }),
]);
export const StoredInteractionPreference = z
  .object({
    explicit: z.literal(true),
    source_id: z.string().uuid(),
    original_text: z.string().trim().min(1).max(4000),
    scope: scopeSchema,
    scope_quote: z.string().trim().min(1).optional(),
    source_assessment_version: z.number().int().positive().optional(),
  })
  .passthrough();
const limit = (n = 20) => {
  if (!Number.isSafeInteger(n) || n < 1) throw Error("INVALID_LIMIT");
  return Math.min(n, MAX_PAGE);
};
const offset = (n = 0) => {
  if (!Number.isSafeInteger(n) || n < 0) throw Error("INVALID_CURSOR");
  return n;
};
const safeAssessment = (a: Assessment | null) =>
  a
    ? {
        version: a.version,
        attribution: a.attributionStatus,
        context: a.contextCompleteness,
        time_precision: a.temporalPrecision,
        eligibility: a.eligibility,
      }
    : null;
const readable = (s: Source, a: Assessment | null) =>
  s.usageStatus === "active" && !!a && ["eligible", "context_only"].includes(a.eligibility);
function clip(text: string, requestedStart: number, requestedEnd: number) {
  let start = requestedStart;
  let end = requestedEnd;
  if (
    start > 0 &&
    /[\uDC00-\uDFFF]/.test(text[start] ?? "") &&
    /[\uD800-\uDBFF]/.test(text[start - 1] ?? "")
  )
    start++;
  if (
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(text[end] ?? "")
  )
    end--;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > text.length ||
    end - start > MAX_SOURCE_TEXT
  )
    throw Error("INVALID_SOURCE_WINDOW");
  return {
    text: text.slice(start, end),
    start,
    end,
    offset_unit: "UTF-16" as const,
    total_length: text.length,
    truncated: start > 0 || end < text.length,
  };
}
function exactSpanMatches(source: string, locator: Record<string, unknown>, quote: string) {
  const start = Number(locator.start);
  const end = Number(locator.end);
  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= source.length
  )
    return source.slice(start, end) === quote;
  const first = source.indexOf(quote);
  return first >= 0 && source.indexOf(quote, first + 1) < 0;
}

/** Current qualification and historical content cutoff are checked separately. */
export class UnderstandingReadTools {
  private readonly asOf?: Date;
  constructor(
    private readonly db: Db,
    private readonly options: UnderstandingReadOptions = {},
  ) {
    this.asOf = options.asOf
      ? new Date(z.string().datetime({ offset: true }).parse(options.asOf))
      : undefined;
  }
  private scoped<T>(ctx: PersonalContext, work: (tx: ProfileTransaction) => Promise<T>) {
    return withProfileTransaction(this.db, ctx, async (tx) => {
      await lockPiProfileState(tx, ctx);
      return work(tx);
    });
  }
  private sourceWhere(ctx: PersonalContext) {
    return and(
      eq(c.sourceItems.tenantId, ctx.tenantId),
      eq(c.sourceItems.subjectId, ctx.subjectId),
      this.asOf ? lte(c.sourceItems.capturedAt, this.asOf) : undefined,
      this.options.withheldSourceIds?.length
        ? notInArray(c.sourceItems.id, [...this.options.withheldSourceIds])
        : undefined,
    );
  }
  private revisionWhere(ctx: PersonalContext) {
    return and(
      eq(c.claims.tenantId, ctx.tenantId),
      eq(c.claims.subjectId, ctx.subjectId),
      this.asOf ? lte(c.claimRevisions.createdAt, this.asOf) : undefined,
    );
  }
  private async sources(tx: ProfileTransaction, ctx: PersonalContext, ids?: readonly string[]) {
    if (ids && !ids.length) return [];
    const sources = await tx
      .select()
      .from(c.sourceItems)
      .where(and(this.sourceWhere(ctx), ids ? inArray(c.sourceItems.id, [...ids]) : undefined))
      .orderBy(c.sourceItems.id)
      .for("share");
    if (!sources.length) return [];
    const assessments = await tx
      .select()
      .from(c.sourceAssessments)
      .where(
        and(
          inArray(
            c.sourceAssessments.sourceItemId,
            sources.map((source) => source.id),
          ),
          eq(c.sourceAssessments.isCurrent, true),
        ),
      )
      .orderBy(c.sourceAssessments.sourceItemId)
      .for("share");
    return sources.map((source) => ({
      source,
      assessment: assessments.find((assessment) => assessment.sourceItemId === source.id) ?? null,
    }));
  }
  async searchSources(
    ctx: PersonalContext,
    input: { query?: string; cursor?: number; limit?: number } = {},
  ) {
    const take = limit(input.limit);
    const skip = offset(input.cursor);
    const query = input.query?.trim() ?? "";
    if (query.length > 240) throw Error("QUERY_TOO_LONG");
    return this.scoped(ctx, async (tx) => {
      const terms = [...new Set(query.toLocaleLowerCase().split(/\s+/).filter(Boolean))];
      const rows = await tx
        .select({ source: c.sourceItems, assessment: c.sourceAssessments })
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
            this.sourceWhere(ctx),
            eq(c.sourceItems.usageStatus, "active"),
            inArray(c.sourceAssessments.eligibility, ["eligible", "context_only"]),
            ...terms.map((t) => sql`position(${t} in lower(${c.sourceItems.content}))>0`),
          ),
        )
        .orderBy(desc(c.sourceItems.capturedAt), desc(c.sourceItems.id))
        .limit(take + 1)
        .offset(skip)
        .for("share");
      const page = rows.slice(0, take);
      const dependencies = page.length
        ? await capturePiDependencies(
            tx,
            ctx,
            page.map((r) => r.source.id),
          )
        : [];
      return {
        items: page.map(({ source: s, assessment: a }) => ({
          id: s.id,
          source_kind: s.sourceKind,
          author: s.authorKind,
          occurred_at: s.occurredAt?.toISOString() ?? null,
          recorded_at: s.capturedAt.toISOString(),
          assessment: safeAssessment(a),
          fingerprint: dependencies.find((d) => d.sourceId === s.id)?.fingerprint,
          excerpt: clip(s.content, 0, Math.min(s.content.length, 1000)),
        })),
        dependencies,
        next_cursor: rows.length > take ? skip + take : null,
        query,
        limit: take,
        exhaustive: false,
        omission_note: "检索仅涵盖当前资格与时间范围内的来源；未命中不表示不存在。",
      };
    });
  }
  async readSource(
    ctx: PersonalContext,
    input: { id: string; start?: number; end?: number; includeAnalysis?: boolean },
  ) {
    return this.scoped(ctx, async (tx) => {
      const [row] = await this.sources(tx, ctx, [input.id]);
      if (!row || !readable(row.source, row.assessment)) throw Error("SOURCE_NOT_AVAILABLE");
      const dependencies = await capturePiDependencies(tx, ctx, [row.source.id]);
      const meta = row.source.sourceMeta ?? {};
      const sourceMeta = Object.fromEntries(
        [
          "namespace",
          "external_id",
          "sequence",
          "role",
          "message_kind",
          "original_recorded_at",
          "original_time_basis",
          "answer_binding",
          "exploration_id",
        ]
          .filter((k) => Object.hasOwn(meta, k))
          .map((k) => [k, meta[k]]),
      );
      return {
        source: {
          id: row.source.id,
          source_kind: row.source.sourceKind,
          author: row.source.authorKind,
          occurred_at: row.source.occurredAt?.toISOString() ?? null,
          recorded_at: row.source.capturedAt.toISOString(),
          source_meta: sourceMeta,
          assessment: safeAssessment(row.assessment),
          fingerprint: dependencies[0]?.fingerprint ?? "",
        },
        background_spans:
          row.source.authorKind === "assistant" && !input.includeAnalysis
            ? questionBackgroundSpans(row.source.content)
            : [],
        qualification:
          row.source.authorKind === "assistant"
            ? "assistant_context_not_personal_evidence"
            : "source_expression",
        excerpt:
          row.source.authorKind === "assistant" && !input.includeAnalysis
            ? null
            : clip(
                row.source.content,
                input.start ?? 0,
                input.end ??
                  Math.min(row.source.content.length, (input.start ?? 0) + MAX_SOURCE_TEXT),
              ),
        dependencies,
      };
    });
  }
  async listUnderstandings(
    ctx: PersonalContext,
    input: { cursor?: number; limit?: number; includeHistory?: boolean; claimId?: string } = {},
  ) {
    const take = limit(input.limit);
    const skip = offset(input.cursor);
    return this.scoped(ctx, async (tx) => {
      const rows = await tx
        .select({ revision: c.claimRevisions, claim: c.claims })
        .from(c.claimRevisions)
        .innerJoin(c.claims, eq(c.claims.id, c.claimRevisions.claimId))
        .where(
          and(
            this.revisionWhere(ctx),
            input.claimId ? eq(c.claims.id, z.string().uuid().parse(input.claimId)) : undefined,
            input.includeHistory
              ? undefined
              : inArray(c.claimRevisions.status, ["current", "candidate", "contested"]),
          ),
        )
        .orderBy(desc(c.claimRevisions.createdAt), desc(c.claimRevisions.id))
        .limit(take + 1)
        .offset(skip)
        .for("share");
      const items = [];
      for (const row of rows.slice(0, take)) {
        const projected = await this.projectRevision(
          tx,
          ctx,
          row.claim,
          row.revision,
          input.includeHistory ?? false,
        );
        items.push({
          ...projected,
          text: projected.text?.slice(0, 180) ?? null,
          text_truncated: (projected.text?.length ?? 0) > 180,
          details: null,
          revision_reason: null,
          feedback: {
            items: [],
            total_available: projected.feedback.total_available,
            omitted_unavailable: projected.feedback.omitted_unavailable,
            read_revision_for_feedback: true,
          },
          evidence: projected.evidence.map((e) => ({
            source_id: e.source_id,
            span_id: e.span_id,
            qualification: e.qualification,
            relation: e.relation,
          })),
          index_only: true,
        });
      }
      return {
        items,
        next_cursor: rows.length > take ? skip + take : null,
        limit: take,
        exhaustive: false,
        omission_note: "认识索引只用于定位；需展开修订与证据才能采用。",
      };
    });
  }
  async readRevision(
    ctx: PersonalContext,
    input: {
      id: string;
      includeHistory?: boolean;
      feedbackCursor?: number;
      feedbackLimit?: number;
    },
  ) {
    return this.scoped(ctx, async (tx) => {
      const [row] = await tx
        .select({ revision: c.claimRevisions, claim: c.claims })
        .from(c.claimRevisions)
        .innerJoin(c.claims, eq(c.claims.id, c.claimRevisions.claimId))
        .where(and(this.revisionWhere(ctx), eq(c.claimRevisions.id, input.id)))
        .limit(1)
        .for("share");
      if (!row) throw Error("REVISION_NOT_AVAILABLE");
      return this.projectRevision(
        tx,
        ctx,
        row.claim,
        row.revision,
        input.includeHistory ?? false,
        input,
      );
    });
  }
  private async projectRevision(
    tx: ProfileTransaction,
    ctx: PersonalContext,
    claim: Claim,
    revision: Revision,
    includeHistory: boolean,
    feedbackPage: { feedbackCursor?: number; feedbackLimit?: number } = {},
  ) {
    if (!includeHistory && ["withdrawn", "superseded"].includes(revision.status))
      throw Error("REVISION_NOT_AVAILABLE");
    const revisionDependency = await capturePiRevisionDependency(tx, ctx, revision.id);
    const allCurrentFeedback = await currentRevisionFeedback(tx, ctx, [revision.id], true);
    const availableFeedback = allCurrentFeedback.filter(
      (item) =>
        (!this.asOf || (item.createdAt <= this.asOf && item.source.capturedAt <= this.asOf)) &&
        !this.options.withheldSourceIds?.includes(item.source.id),
    );
    const feedbackStart = offset(feedbackPage.feedbackCursor);
    const feedbackTake = Math.min(limit(feedbackPage.feedbackLimit ?? 10), 20);
    const selectedFeedback = availableFeedback.slice(feedbackStart, feedbackStart + feedbackTake);
    const [feedbackCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(c.feedbackEvents)
      .where(
        and(
          eq(c.feedbackEvents.tenantId, ctx.tenantId),
          eq(c.feedbackEvents.subjectId, ctx.subjectId),
          eq(c.feedbackEvents.targetType, "claim_revision"),
          eq(c.feedbackEvents.targetId, revision.id),
          this.asOf ? lte(c.feedbackEvents.createdAt, this.asOf) : undefined,
        ),
      );
    const feedbackDependencies = selectedFeedback.length
      ? await capturePiDependencies(
          tx,
          ctx,
          selectedFeedback.map((item) => item.source.id),
        )
      : [];
    const requiresReassessment =
      revision.status === "current" &&
      allCurrentFeedback.some((item) => REASSESSMENT_FEEDBACK_TYPES.has(item.type));
    const edges = await tx
      .select({ edge: c.claimEvidence, span: c.evidenceSpans })
      .from(c.claimEvidence)
      .innerJoin(c.evidenceSpans, eq(c.evidenceSpans.id, c.claimEvidence.evidenceSpanId))
      .where(eq(c.claimEvidence.claimRevisionId, revision.id));
    const sources = await this.sources(
      tx,
      ctx,
      edges.map((e) => e.span.sourceItemId),
    );
    const available = edges.flatMap(({ edge, span }) => {
      const row = sources.find((r) => r.source.id === span.sourceItemId);
      return row &&
        readable(row.source, row.assessment) &&
        exactSpanMatches(row.source.content, span.locator ?? {}, span.quote)
        ? [{ edge, span, ...row }]
        : [];
    });
    const dependencies = available.length
      ? await capturePiDependencies(
          tx,
          ctx,
          available.map((r) => r.source.id),
        )
      : [];
    const supported = available.filter(
      ({ edge, span, source, assessment }) =>
        edge.relation === "supports" &&
        assessment?.eligibility === "eligible" &&
        assessment.attributionStatus === "confirmed_subject" &&
        source.authorKind === "subject" &&
        span.authorKind === "subject" &&
        span.aboutSubject,
    );
    const supportedIds = new Set(supported.map((e) => e.edge.id));
    const complete = edges.length > 0 && available.length === edges.length;
    const qualified =
      !requiresReassessment &&
      complete &&
      supported.length > 0 &&
      revision.status === "current" &&
      revision.evidenceStatus === "valid";
    const historical = includeHistory && ["withdrawn", "superseded"].includes(revision.status);
    const show =
      qualified ||
      (complete &&
        revision.status === "current" &&
        revision.evidenceStatus === "valid" &&
        supported.length > 0 &&
        requiresReassessment) ||
      (complete && ["candidate", "contested"].includes(revision.status)) ||
      (historical && complete);
    return {
      claim_id: claim.id,
      claim_kind: claim.claimKind,
      revision_id: revision.id,
      version: revision.version,
      mode: revision.mode,
      status: revision.status,
      evidence_status: revision.evidenceStatus,
      scope: show ? revision.scope : null,
      confidence_level: revision.confidenceLevel,
      created_at: revision.createdAt.toISOString(),
      qualified,
      qualification: qualified
        ? "current_understanding"
        : show && revision.status === "current" && requiresReassessment
          ? "contested_current_understanding"
          : show
            ? historical
              ? "historical_not_current_premise"
              : "candidate_not_current"
            : "unavailable_understanding",
      text: show ? revision.text : null,
      details: show ? revision.details : null,
      revision_reason: show ? revision.revisionReason : null,
      supersedes_revision_id: show ? revision.supersedesRevisionId : null,
      requires_reassessment: requiresReassessment,
      feedback: {
        items: selectedFeedback.map((item) => ({
          id: item.id,
          type: item.type,
          recorded_at: item.createdAt.toISOString(),
          source_id: item.source.id,
          author: "subject",
          qualification: "subject_feedback_not_independent_support",
          source_expression: clip(
            item.source.content,
            0,
            Math.min(item.source.content.length, MAX_SOURCE_TEXT),
          ),
        })),
        next_cursor:
          feedbackStart + feedbackTake < availableFeedback.length
            ? feedbackStart + feedbackTake
            : null,
        total_available: availableFeedback.length,
        omitted_unavailable: Math.max(0, (feedbackCount?.n ?? 0) - availableFeedback.length),
        omission_note:
          "仅返回当前合格本人来源及本次时间范围内的反馈原文；反馈不是独立支持，无来源note不进入模型。",
      },
      evidence: available.map(({ edge, span, source, assessment }) => ({
        span_id: span.id,
        quote: span.quote,
        locator: span.locator,
        relation: edge.relation,
        directness: edge.directness,
        contribution: edge.contribution,
        independence_group: edge.independenceGroup,
        rationale: edge.rationale,
        source_id: source.id,
        source_fingerprint: dependencies.find((d) => d.sourceId === source.id)?.fingerprint,
        qualification:
          edge.relation === "contextualizes"
            ? "context_only"
            : supportedIds.has(edge.id)
              ? "eligible_support"
              : "needs_review",
        assessment_version: assessment?.version,
      })),
      omitted_evidence: edges.length - available.length,
      dependencies: [
        ...new Map(
          [...dependencies, ...feedbackDependencies].map((dependency) => [
            dependency.sourceId,
            dependency,
          ]),
        ).values(),
      ],
      revision_dependencies: [revisionDependency],
      reason: show
        ? qualified
          ? null
          : "线索或历史修订，不作为当前结论。"
        : "部分依据已失效或资格不足；只返回仍可用依据，隐藏认识正文及附加文本。",
    };
  }
  async interactionPreferences(
    ctx: PersonalContext,
    task: ContextTask,
    page: { cursor?: number; limit?: number } = {},
  ) {
    const take = limit(page.limit);
    const skip = offset(page.cursor);
    return this.scoped(ctx, async (tx) => {
      const criteria = and(
        this.revisionWhere(ctx),
        eq(c.claimRevisions.status, "current"),
        sql`${c.claimRevisions.details} ? 'interaction_preference'`,
        sql`(
              (${c.claimRevisions.details}->'interaction_preference'->'scope'->>'kind'='turn' AND ${c.claimRevisions.details}->'interaction_preference'->'scope'->>'id'=${task.inputSourceId ?? ""}) OR
              (${c.claimRevisions.details}->'interaction_preference'->'scope'->>'kind'='conversation' AND ${c.claimRevisions.details}->'interaction_preference'->'scope'->>'id'=${task.conversationId}) OR
              (${c.claimRevisions.details}->'interaction_preference'->'scope'->>'kind'='task' AND ${c.claimRevisions.details}->'interaction_preference'->'scope'->>'id'=${task.taskType}) OR
              (${c.claimRevisions.details}->'interaction_preference'->'scope'->>'kind'='topic' AND ${c.claimRevisions.details}->'interaction_preference'->'scope'->>'id'=${task.topicId ?? ""}) OR
              ${c.claimRevisions.details}->'interaction_preference'->'scope'->>'kind'='default'
            )`,
      );
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(c.claimRevisions)
        .innerJoin(c.claims, eq(c.claims.id, c.claimRevisions.claimId))
        .where(criteria);
      const totalCandidates = count?.n ?? 0;
      const rows = await tx
        .select({ revision: c.claimRevisions, claim: c.claims })
        .from(c.claimRevisions)
        .innerJoin(c.claims, eq(c.claims.id, c.claimRevisions.claimId))
        .where(criteria)
        .orderBy(
          sql`case ${c.claimRevisions.details}->'interaction_preference'->'scope'->>'kind' when 'turn' then 0 when 'conversation' then 1 when 'task' then 2 when 'topic' then 3 else 4 end`,
          desc(c.claimRevisions.createdAt),
          desc(c.claimRevisions.id),
        )
        .limit(take + 1)
        .offset(skip)
        .for("share");
      const items = [];
      let processed = 0;
      let chars = 0;
      for (const row of rows.slice(0, take)) {
        processed++;
        const view = await this.projectRevision(tx, ctx, row.claim, row.revision, false);
        const parsed = StoredInteractionPreference.safeParse(view.details?.interaction_preference);
        if (!view.qualified || !parsed.success) continue;
        const preference = parsed.data;
        const evidence = view.evidence.find(
          (e) =>
            e.source_id === preference.source_id &&
            e.qualification === "eligible_support" &&
            e.directness === "direct",
        );
        const source = await this.readSourceInTransaction(tx, ctx, preference.source_id);
        if (!evidence || !source || !source.source.content.includes(preference.original_text))
          continue;
        if (
          preference.source_assessment_version !== undefined &&
          preference.source_assessment_version !== source.assessment?.version
        )
          continue;
        if (
          preference.scope.kind === "default" &&
          (!preference.scope_quote || !source.source.content.includes(preference.scope_quote))
        )
          continue;
        const value: InteractionPreference = {
          id: row.revision.id,
          version: row.revision.version,
          text: preference.original_text,
          sourceId: preference.source_id,
          explicit: true,
          status: "current",
          sourceValid: true,
          scope: preference.scope,
        };
        if (applicablePreferences(task, [value]).length) {
          if (chars + value.text.length > 8000) {
            processed--;
            break;
          }
          chars += value.text.length;
          items.push({
            preference: value,
            dependencies: view.dependencies,
            revision_dependencies: view.revision_dependencies,
          });
        }
      }
      const more = processed > 0 && skip + processed < totalCandidates;
      return {
        items,
        next_cursor: more ? skip + processed : null,
        exhaustive: !more,
        omitted: Math.max(0, totalCandidates - skip - processed),
        omission_basis: "scoped_candidates_before_source_qualification",
        total_scoped_candidates: totalCandidates,
      };
    });
  }
  private async readSourceInTransaction(tx: ProfileTransaction, ctx: PersonalContext, id: string) {
    const [row] = await this.sources(tx, ctx, [id]);
    return row && readable(row.source, row.assessment) ? row : undefined;
  }
  async initialContext(ctx: PersonalContext, task: ContextTask) {
    const [index, prefs] = await Promise.all([
      this.listUnderstandings(ctx, { limit: 50 }),
      this.interactionPreferences(ctx, task, { limit: 8 }),
    ]);
    const scores = lexicalScores(
      task.input,
      index.items
        .filter((i) => i.qualified && i.text)
        .map((i) => ({ id: i.revision_id, quote: `${i.text}\n${i.scope ?? ""}` })),
    );
    const selected = index.items
      .filter((i) => i.qualified && (scores.get(i.revision_id)?.score ?? 0) > 0)
      .slice(0, 12);
    const used = [...selected, ...prefs.items];
    const sourceDependencies = new Map<string, (typeof used)[number]["dependencies"][number]>();
    const revisionDependencies = new Map<
      string,
      (typeof used)[number]["revision_dependencies"][number]
    >();
    for (const item of used) {
      for (const dependency of item.dependencies) {
        const prior = sourceDependencies.get(dependency.sourceId);
        if (prior && prior.fingerprint !== dependency.fingerprint)
          throw new Error("PI_SOURCE_CHANGED_DURING_RUN");
        sourceDependencies.set(dependency.sourceId, dependency);
      }
      for (const dependency of item.revision_dependencies) {
        const prior = revisionDependencies.get(dependency.revisionId);
        if (prior && prior.fingerprint !== dependency.fingerprint)
          throw new Error("PI_REVISION_STALE_DEPENDENCY");
        revisionDependencies.set(dependency.revisionId, dependency);
      }
    }
    return {
      understandingIndex: selected.map((i) => ({
        id: i.revision_id,
        version: i.version,
        title: i.text?.slice(0, 160) ?? "",
        status: i.status,
      })),
      preferences: prefs.items.map((i) => i.preference),
      dependencies: [...sourceDependencies.values()],
      revision_dependencies: [...revisionDependencies.values()],
      omitted: { understanding_index: index.next_cursor !== null, preferences: prefs.omitted },
      qualification: "indexes_and_scoped_preferences_not_new_evidence",
    };
  }
  async readConversation(
    ctx: PersonalContext,
    input: { namespace: string; cursor?: number; limit?: number; includeAnalysis?: boolean },
  ) {
    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(input.namespace)) throw Error("INVALID_NAMESPACE");
    const take = limit(input.limit);
    const skip = offset(input.cursor);
    return this.scoped(ctx, async (tx) => {
      const [batch] = await tx
        .select()
        .from(p.importBatches)
        .where(
          and(
            eq(p.importBatches.tenantId, ctx.tenantId),
            eq(p.importBatches.subjectId, ctx.subjectId),
            sql`${p.importBatches.result}->>'understanding_namespace'=${input.namespace}`,
            eq(p.importBatches.status, "committed"),
            this.asOf ? lte(p.importBatches.committedAt, this.asOf) : undefined,
          ),
        )
        .limit(1);
      if (!batch) throw Error("IMPORT_NOT_AVAILABLE");
      const ids = z.array(z.string().uuid()).parse(batch.result?.source_ids ?? []);
      const rows = (await this.sources(tx, ctx, ids))
        .filter((r) => readable(r.source, r.assessment))
        .sort(
          (a, b) =>
            Number(a.source.sourceMeta?.sequence ?? 0) -
              Number(b.source.sourceMeta?.sequence ?? 0) || a.source.id.localeCompare(b.source.id),
        );
      const page = rows.slice(skip, skip + take);
      const dependencies = page.length
        ? await capturePiDependencies(
            tx,
            ctx,
            page.map((r) => r.source.id),
          )
        : [];
      return {
        namespace: input.namespace,
        batch_id: batch.id,
        sources: page.map(({ source, assessment }) => ({
          id: source.id,
          external_id: source.sourceMeta?.external_id,
          sequence: source.sourceMeta?.sequence,
          role: source.sourceMeta?.role,
          message_kind: source.sourceMeta?.message_kind,
          recorded_at: source.sourceMeta?.original_recorded_at,
          time_basis: source.sourceMeta?.original_time_basis,
          assessment: safeAssessment(assessment),
          excerpt:
            source.authorKind === "assistant" && !input.includeAnalysis
              ? null
              : clip(source.content, 0, Math.min(source.content.length, 1000)),
          background_spans:
            source.authorKind === "assistant" && !input.includeAnalysis
              ? questionBackgroundSpans(source.content)
              : [],
          qualification:
            source.authorKind === "assistant"
              ? "assistant_context_not_personal_evidence"
              : "source_expression",
          fingerprint: dependencies.find((d) => d.sourceId === source.id)?.fingerprint,
        })),
        dependencies,
        next_cursor: skip + take < rows.length ? skip + take : null,
        limit: take,
        exhaustive: skip + take >= rows.length,
        source_total_in_import: ids.length,
        active_source_total: rows.length,
        excluded_or_unavailable: ids.length - rows.length,
        omission_note:
          skip + take < rows.length || rows.length < ids.length
            ? "存在不可用来源或分页；结果不代表完整历史。"
            : null,
      };
    });
  }
  async coverage(ctx: PersonalContext) {
    return this.scoped(ctx, async (tx) => {
      const sources = await this.sources(tx, ctx);
      const counts: Record<string, number> = { active: 0, excluded: 0, deleted: 0 };
      for (const { source } of sources)
        if (source.usageStatus in counts)
          counts[source.usageStatus] = (counts[source.usageStatus] ?? 0) + 1;
      const revisions = await tx
        .select({ status: c.claimRevisions.status })
        .from(c.claimRevisions)
        .innerJoin(c.claims, eq(c.claims.id, c.claimRevisions.claimId))
        .where(this.revisionWhere(ctx));
      return {
        coverage: {
          ...counts,
          readable_sources: sources.filter((r) => readable(r.source, r.assessment)).length,
          understandings: {
            current: revisions.filter((r) => r.status === "current").length,
            candidate: revisions.filter((r) => r.status === "candidate").length,
            contested: revisions.filter((r) => r.status === "contested").length,
            retired: revisions.filter((r) => ["withdrawn", "superseded"].includes(r.status)).length,
          },
        },
        total_sources: sources.length,
        content_as_of: this.options.asOf ?? null,
        exhaustive: true,
        omission_note:
          "仅为当前时间范围内的数据库对象计数，不代表生活领域完整覆盖，也不代表已阅读。",
      };
    });
  }
}
