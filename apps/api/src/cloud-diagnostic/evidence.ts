import type { CloudEvidenceBinding } from "@findme/core";
import { coreSchema as core, diagnosticSchema as tables } from "@findme/db";
import { and, eq } from "drizzle-orm";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { requestHash } from "../core/operations.js";
import { qualificationProof } from "./provenance.js";
import type { ProfileTransaction } from "./scope.js";
const dependencies = tables.diagnosticReportSources;
export async function cloudSourceHash(source: typeof core.sourceItems.$inferSelect) {
  return requestHash({
    content: source.content,
    author_kind: source.authorKind,
    source_kind: source.sourceKind,
    occurred_at: source.occurredAt?.toISOString() ?? null,
    reported_at: source.capturedAt.toISOString(),
    external_ref: source.externalRef,
    source_meta: source.sourceMeta,
    usage_status: source.usageStatus,
  });
}
export async function evidenceFor(
  tx: ProfileTransaction,
  ctx: PersonalContext,
  ref: CloudEvidenceBinding,
) {
  const [source] = await tx
    .select()
    .from(core.sourceItems)
    .where(
      and(
        eq(core.sourceItems.id, ref.source_id),
        eq(core.sourceItems.tenantId, ctx.tenantId),
        eq(core.sourceItems.subjectId, ctx.subjectId),
      ),
    )
    .limit(1)
    .for("share");
  const fail = () => {
    throw new CoreError("DIAGNOSTIC_SOURCE_STALE", 409, "报告依据已变化或不可用");
  };
  if (!source || source.usageStatus !== "active") return fail();
  if ((await cloudSourceHash(source)) !== ref.source_hash) return fail();
  const [assessment] = await tx
    .select()
    .from(core.sourceAssessments)
    .where(
      and(
        eq(core.sourceAssessments.sourceItemId, source.id),
        eq(core.sourceAssessments.isCurrent, true),
        eq(core.sourceAssessments.version, ref.assessment_version),
      ),
    )
    .limit(1)
    .for("share");
  if (!assessment || assessment.eligibility === "excluded") return fail();
  const [span] = await tx
    .select()
    .from(core.evidenceSpans)
    .where(
      and(eq(core.evidenceSpans.id, ref.span_id), eq(core.evidenceSpans.sourceItemId, source.id)),
    )
    .limit(1)
    .for("share");
  if (!span || !span.quote) return fail();
  const locator = span.locator ?? {};
  const wholeSource = locator.whole_source === true;
  const storedStart =
    locator.content_scope === "quote_excerpt"
      ? locator.stored_start
      : wholeSource
        ? 0
        : locator.start;
  const storedEnd =
    locator.content_scope === "quote_excerpt"
      ? locator.stored_end
      : wholeSource
        ? source.content.length
        : locator.end;
  // Existing Core whole_source anchors require exact full-text equality, never substring search.
  if (
    typeof storedStart !== "number" ||
    typeof storedEnd !== "number" ||
    !Number.isSafeInteger(storedStart) ||
    !Number.isSafeInteger(storedEnd) ||
    storedStart < 0 ||
    storedEnd <= storedStart ||
    storedEnd > source.content.length ||
    source.content.slice(storedStart, storedEnd) !== span.quote
  )
    return fail();
  const excerpt = locator.content_scope === "quote_excerpt";
  const originalStart = excerpt ? locator.original_start : storedStart;
  const originalEnd = excerpt ? locator.original_end : storedEnd;
  if (
    typeof originalStart !== "number" ||
    typeof originalEnd !== "number" ||
    !Number.isSafeInteger(originalStart) ||
    !Number.isSafeInteger(originalEnd) ||
    originalStart < 0 ||
    originalEnd - originalStart !== span.quote.length ||
    (excerpt && locator.offset_unit !== "utf16")
  )
    return fail();
  let qualifiedFact: Awaited<ReturnType<typeof qualificationProof>>["facts"][number] | undefined;
  if (typeof span.locator?.qualification_job === "string") {
    const proof = await qualificationProof(tx, ctx, span.locator.qualification_job).catch(
      () => null,
    );
    if (!proof) return fail();
    const original = proof.input.sources.find((s) => s.id === source.id);
    qualifiedFact = proof.facts.find((f) => f.id === ref.evidence_id && f.source_id === source.id);
    if (
      original?.hash !== ref.source_hash ||
      original.assessment_version !== ref.assessment_version ||
      !qualifiedFact ||
      qualifiedFact.quote !== span.quote ||
      qualifiedFact.start !== storedStart ||
      qualifiedFact.end !== storedEnd ||
      qualifiedFact.content_author !== span.authorKind ||
      (qualifiedFact.about === "self") !== span.aboutSubject
    )
      return fail();
  } else if (!["eligible", "context_only"].includes(assessment.eligibility)) return fail();
  const eligibility = qualifiedFact
    ? qualifiedFact.use === "context"
      ? "context_only"
      : "eligible"
    : assessment.eligibility;
  return {
    qualified_fact: qualifiedFact,
    evidence_id: ref.evidence_id,
    source_id: source.id,
    span_id: span.id,
    quote: span.quote,
    start: originalStart,
    end: originalEnd,
    stored_start: storedStart,
    stored_end: storedEnd,
    content_scope: excerpt ? "quote_excerpt" : "full_source",
    original_source_id:
      typeof locator.original_source_id === "string" ? locator.original_source_id : null,
    source_ids: Array.isArray(locator.original_source_ids)
      ? locator.original_source_ids.filter((x): x is string => typeof x === "string")
      : [source.id],
    session_id:
      typeof locator.original_session_id === "string" ? locator.original_session_id : null,
    message_id:
      typeof locator.original_message_id === "string" ? locator.original_message_id : null,
    original_position: excerpt
      ? { start: originalStart, end: originalEnd, offset_unit: "utf16" as const }
      : null,
    qualifier: excerpt && typeof locator.qualifier === "string" ? locator.qualifier : null,
    about:
      qualifiedFact?.about ??
      (excerpt && typeof locator.original_about === "string"
        ? locator.original_about
        : (source.sourceMeta?.about ?? "unknown")),
    stance:
      qualifiedFact?.stance ??
      (excerpt && typeof locator.original_stance === "string"
        ? locator.original_stance
        : (source.sourceMeta?.stance ?? "unknown")),
    scope: excerpt && typeof locator.original_scope === "string" ? locator.original_scope : null,
    content_author: qualifiedFact?.content_author ?? span.authorKind,
    eligibility,
    assessment_version: assessment.version,
    reported_at: excerpt
      ? typeof locator.original_report_time === "string"
        ? locator.original_report_time
        : null
      : source.capturedAt.toISOString(),
    occurred_at: source.occurredAt?.toISOString() ?? null,
  };
}
export function reference(row: typeof dependencies.$inferSelect): CloudEvidenceBinding {
  return {
    evidence_id: row.evidenceId,
    source_id: row.sourceId,
    span_id: row.spanId,
    assessment_version: row.assessmentVersion,
    source_hash: row.sourceHash,
  };
}
