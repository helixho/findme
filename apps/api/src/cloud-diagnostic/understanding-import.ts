import { UnderstandingImport } from "@findme/core";
import { type Db, coreSchema as c, platformSchema as p } from "@findme/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { requestHash } from "../core/operations.js";
import { withProfileTransaction } from "./scope.js";

function requiredEntry<T>(map: Map<string, T>, key: string): T {
  const value = map.get(key);
  if (value === undefined) throw new Error("IMPORT_REFERENCE_MISSING");
  return value;
}

export async function prepareUnderstandingImport(raw: unknown) {
  const parsed = UnderstandingImport.safeParse(raw);
  if (!parsed.success)
    throw new CoreError("UNDERSTANDING_IMPORT_INVALID", 422, "导入结构、引用或版本关系不符合要求", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    });
  const bundle = parsed.data;
  if (new TextEncoder().encode(JSON.stringify(bundle)).length > 2 * 1024 * 1024)
    throw new CoreError("FEEDBACK_INPUT_BOUND_EXCEEDED", 422, "导入内容超过上限，不能静默截断");
  const base = {
    sources: bundle.sources.length,
    insights: bundle.insights.length,
    revisions: bundle.insights.reduce((n, i) => n + i.revisions.length, 0),
    feedback: bundle.feedback.length,
    model_calls: 0,
    publication: "candidate_only" as const,
  };
  return {
    bundle,
    input_hash: await requestHash(bundle),
    // Version 1 receipts keep their original shape; version 2 adds only counts.
    summary:
      bundle.format === "findme-understanding-import@2"
        ? {
            ...base,
            format: bundle.format,
            experiences: bundle.experiences.length,
            answer_bindings: bundle.insights.reduce(
              (n, i) => n + i.revisions.filter((r) => r.answer_binding).length,
              0,
            ),
          }
        : base,
  };
}

type Revision = UnderstandingImport["insights"][number]["revisions"][number];
type Ref = Revision["origin"];

/** Explicit, model-free import of a fixed conversation and its existing analysis history. */
export class UnderstandingImportService {
  constructor(private db: Db) {}

  async commit(ctx: PersonalContext, raw: unknown, expectedHash: string) {
    const { bundle, input_hash, summary } = await prepareUnderstandingImport(raw);
    if (input_hash !== expectedHash)
      throw new CoreError("STALE_VERSION", 409, "导入内容与预览不一致");
    return withProfileTransaction(this.db, ctx, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ctx, bundle.namespace])}, 0))`,
      );
      // One namespace identifies one immutable import, so changed content cannot silently replace it.
      const [prior] = await tx
        .select()
        .from(p.importBatches)
        .where(
          and(
            eq(p.importBatches.tenantId, ctx.tenantId),
            eq(p.importBatches.subjectId, ctx.subjectId),
            sql`${p.importBatches.result}->>'understanding_namespace' = ${bundle.namespace}`,
          ),
        )
        .limit(1);
      if (prior) {
        if (prior.inputHash !== input_hash)
          throw new CoreError(
            "SOURCE_VERSION_CONFLICT",
            409,
            "此会话批次已导入不同内容，请明确修订，不能覆盖",
          );
        return { ...prior.result, id: prior.id, replayed: true };
      }
      const [batch] = await tx
        .insert(p.importBatches)
        .values({
          ...ctx,
          inputHash: input_hash,
          status: "committed",
          payload: {},
          committedAt: new Date(),
        })
        .returning();
      if (!batch) throw new Error("IMPORT_CREATE_FAILED");
      const sources = new Map<string, string>();
      const spans = new Map<string, string>();
      const sourceByKey = new Map(bundle.sources.map((s) => [s.key, s]));
      for (const source of bundle.sources) {
        const [saved] = await tx
          .insert(c.sourceItems)
          .values({
            ...ctx,
            sourceKind: "conversation_import",
            authorKind: source.role === "user" ? "subject" : "assistant",
            content: source.text,
            occurredAt: null,
            externalRef: `understanding:${bundle.namespace}:${source.key}`,
            sourceMeta: {
              import_batch: batch.id,
              namespace: bundle.namespace,
              external_id: source.key,
              sequence: source.sequence,
              role: source.role,
              message_kind:
                source.message_kind ?? (source.role === "user" ? "user" : "final_answer"),
              original_recorded_at: source.recorded_at,
              original_time_basis: source.time_basis,
              root_id: `understanding:${bundle.namespace}`,
              owner_confirmed: false,
              about: "unknown",
              stance: "unknown",
            },
          })
          .returning();
        if (!saved) throw new Error("SOURCE_CREATE_FAILED");
        sources.set(source.key, saved.id);
        await tx.insert(c.sourceAssessments).values({
          sourceItemId: saved.id,
          version: 1,
          attributionStatus: "ambiguous",
          contextCompleteness: "partial",
          temporalPrecision: "unknown",
          eligibility: "needs_review",
          rationale: "对话导入保留发言角色；引用、立场与个人判断尚未审核，不自动发布。",
        });
      }
      const saveSpan = async (ref: Ref) => {
        const token = `${ref.source_key}:${ref.start}:${ref.end}`;
        const existing = spans.get(token);
        if (existing) return existing;
        const [span] = await tx
          .insert(c.evidenceSpans)
          .values({
            sourceItemId: requiredEntry(sources, ref.source_key),
            quote: ref.quote,
            locator: { start: ref.start, end: ref.end, import_batch: batch.id },
            authorKind: sourceByKey.get(ref.source_key)?.role === "user" ? "subject" : "assistant",
            aboutSubject: false,
          })
          .returning();
        if (!span) throw new Error("SPAN_CREATE_FAILED");
        spans.set(token, span.id);
        return span.id;
      };
      const revisions = new Map<string, { id: string; refs: Ref[] }>();
      const claimIds: string[] = [];
      const revisionIds: string[] = [];
      const prefix = (await requestHash([bundle.namespace])).slice(0, 24);
      const experiences = new Map(
        bundle.format === "findme-understanding-import@2"
          ? bundle.experiences.map((e) => [e.key, e] as const)
          : [],
      );
      const groupOf = (ref: Ref) =>
        "experience_key" in ref && ref.experience_key
          ? `import:${prefix}:${ref.experience_key}`
          : `import:${prefix}`;
      const token = (ref: Pick<Ref, "source_key" | "start" | "end">) =>
        `${ref.source_key}:${ref.start}:${ref.end}`;
      // Answers chosen from the assistant's own options are elicited, never spontaneous.
      const elicited = new Set(
        bundle.insights.flatMap((i) =>
          i.revisions.flatMap((r) =>
            "answer_binding" in r && r.answer_binding ? [token(r.answer_binding.answer)] : [],
          ),
        ),
      );
      for (const insight of bundle.insights) {
        const [claim] = await tx
          .insert(c.claims)
          .values({
            ...ctx,
            claimKey: `import:${prefix}:${insight.key}`,
            claimKind: insight.kind,
          })
          .returning();
        if (!claim) throw new Error("CLAIM_CREATE_FAILED");
        claimIds.push(claim.id);
        let previousId: string | null = null;
        for (const revision of insight.revisions) {
          const inherited = revision.relations.flatMap(
            (link) => requiredEntry(revisions, `${link.target_key}@${link.target_version}`).refs,
          );
          const refs = [
            ...new Map(
              [revision.origin, ...revision.evidence, ...inherited].map((ref) => [
                JSON.stringify([
                  ref.source_key,
                  ref.start,
                  ref.end,
                  "relation" in ref ? ref.relation : "contextualizes",
                ]),
                ref,
              ]),
            ).values(),
          ];
          const [saved]: Array<typeof c.claimRevisions.$inferSelect> = await tx
            .insert(c.claimRevisions)
            .values({
              claimId: claim.id,
              version: revision.version,
              mode: insight.mode,
              text: revision.text,
              scope: revision.scope,
              status: revision.status,
              evidenceStatus: "stale",
              confidenceLevel: "low",
              confidenceBasis: "保存已有分析及修订历史；尚未核验为当前个人认识。",
              revisionReason: revision.reason,
              supersedesRevisionId: previousId,
              details: {
                schema_version:
                  bundle.format === "findme-understanding-import@2"
                    ? "personal-understanding@2"
                    : "personal-understanding@1",
                ...revision.dimensions,
                relations: revision.relations.map((link) => ({
                  target_revision_id: requiredEntry(
                    revisions,
                    `${link.target_key}@${link.target_version}`,
                  ).id,
                  kind: link.kind,
                })),
                ...(bundle.format === "findme-understanding-import@2"
                  ? {
                      ...("answer_binding" in revision && revision.answer_binding
                        ? {
                            text_basis: revision.answer_binding.text_basis,
                            answer_binding: revision.answer_binding,
                          }
                        : {}),
                      // Only the experiences this revision's evidence actually touches.
                      experiences: [...experiences.values()]
                        .filter((e) =>
                          refs.some(
                            (ref) => "experience_key" in ref && ref.experience_key === e.key,
                          ),
                        )
                        .map((e) => ({ ...e, independence_group: `import:${prefix}:${e.key}` })),
                    }
                  : {}),
              },
            })
            .returning();
          if (!saved) throw new Error("REVISION_CREATE_FAILED");
          const used = new Set<string>();
          // Inherited origins are lifecycle dependencies, not additional independent evidence.
          for (const ref of refs) {
            const id = await saveSpan(ref);
            const relation = "relation" in ref ? String(ref.relation) : "contextualizes";
            if (used.has(`${id}:${relation}`)) continue;
            used.add(`${id}:${relation}`);
            await tx.insert(c.claimEvidence).values({
              claimRevisionId: saved.id,
              evidenceSpanId: id,
              relation,
              directness: "direct",
              contribution: "low",
              independenceGroup: groupOf(ref),
              scopeMatch: "imported_unreviewed",
              rationale:
                relation !== "contextualizes" && elicited.has(token(ref))
                  ? "回答由助手提问引出（elicited_by），是对助手所给选项的选择，不是自发表达，不计为独立个人证据。"
                  : "导入关联，不把助手分析或同源复述计为独立个人证据。",
            });
          }
          revisions.set(`${insight.key}@${revision.version}`, { id: saved.id, refs });
          revisionIds.push(saved.id);
          previousId = saved.id;
        }
      }
      const feedbackIds: string[] = [];
      for (const f of bundle.feedback) {
        const [row] = await tx
          .insert(c.feedbackEvents)
          .values({
            ...ctx,
            targetType: f.target.type === "source" ? "source" : "claim_revision",
            targetId:
              f.target.type === "source"
                ? requiredEntry(sources, f.target.key)
                : requiredEntry(revisions, `${f.target.key}@${f.target.version}`).id,
            feedbackType: f.purpose,
            note: "",
            sourceItemId: requiredEntry(sources, f.source_key),
          })
          .returning();
        if (!row) throw new Error("FEEDBACK_CREATE_FAILED");
        feedbackIds.push(row.id);
      }
      const result = {
        ...summary,
        id: batch.id,
        understanding_namespace: bundle.namespace,
        // Opaque identifiers only; labels stay in redactable revision details.
        ...(bundle.format === "findme-understanding-import@2"
          ? {
              experience_groups: [...experiences.keys()].map((k) => ({
                key: k,
                independence_group: `import:${prefix}:${k}`,
              })),
            }
          : {}),
        source_ids: [...sources.values()],
        claim_ids: claimIds,
        revision_ids: revisionIds,
        feedback_ids: feedbackIds,
      };
      await tx.update(p.importBatches).set({ result }).where(eq(p.importBatches.id, batch.id));
      return { ...result, replayed: false };
    });
  }

  async read(ctx: PersonalContext, id: string) {
    return withProfileTransaction(this.db, ctx, async (tx) => {
      const [batch] = await tx
        .select()
        .from(p.importBatches)
        .where(
          and(
            eq(p.importBatches.id, id),
            eq(p.importBatches.tenantId, ctx.tenantId),
            eq(p.importBatches.subjectId, ctx.subjectId),
          ),
        )
        .limit(1);
      if (!batch?.result?.understanding_namespace)
        throw new CoreError("NOT_FOUND", 404, "导入不存在");
      const ids = (name: string) => (batch.result?.[name] ?? []) as string[];
      const sources = ids("source_ids").length
        ? await tx
            .select()
            .from(c.sourceItems)
            .where(
              and(
                inArray(c.sourceItems.id, ids("source_ids")),
                eq(c.sourceItems.tenantId, ctx.tenantId),
                eq(c.sourceItems.subjectId, ctx.subjectId),
              ),
            )
        : [];
      const revisions = ids("revision_ids").length
        ? await tx
            .select()
            .from(c.claimRevisions)
            .where(inArray(c.claimRevisions.id, ids("revision_ids")))
        : [];
      const evidence = revisions.length
        ? await tx
            .select({
              id: c.claimEvidence.id,
              claimRevisionId: c.claimEvidence.claimRevisionId,
              evidenceSpanId: c.claimEvidence.evidenceSpanId,
              sourceItemId: c.evidenceSpans.sourceItemId,
              locator: c.evidenceSpans.locator,
              relation: c.claimEvidence.relation,
              independenceGroup: c.claimEvidence.independenceGroup,
              rationale: c.claimEvidence.rationale,
            })
            .from(c.claimEvidence)
            .innerJoin(c.evidenceSpans, eq(c.evidenceSpans.id, c.claimEvidence.evidenceSpanId))
            .where(
              inArray(
                c.claimEvidence.claimRevisionId,
                revisions.map((r) => r.id),
              ),
            )
        : [];
      const feedback = ids("feedback_ids").length
        ? await tx
            .select()
            .from(c.feedbackEvents)
            .where(
              and(
                inArray(c.feedbackEvents.id, ids("feedback_ids")),
                eq(c.feedbackEvents.tenantId, ctx.tenantId),
                eq(c.feedbackEvents.subjectId, ctx.subjectId),
              ),
            )
        : [];
      return {
        id: batch.id,
        input_hash: batch.inputHash,
        sources: sources.sort(
          (a, b) => Number(a.sourceMeta?.sequence ?? 0) - Number(b.sourceMeta?.sequence ?? 0),
        ),
        revisions: revisions.sort(
          (a, b) => a.claimId.localeCompare(b.claimId) || a.version - b.version,
        ),
        evidence,
        feedback,
        publication: "candidate_only",
      };
    });
  }
}
