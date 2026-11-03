import { type Db, coreSchema, type specialistSchema } from "@findme/db";
import type { PersonalContext } from "../core/exploration-service.js";
import type { ReviewInput } from "./contracts.js";
type Trial = typeof specialistSchema.specialistTrials.$inferSelect;
/** Persist a self-report with attribution and evidence; this does not create a personal claim. */
export async function recordReviewSource(
  db: Db,
  ctx: PersonalContext,
  trial: Trial,
  body: ReviewInput,
  selfReportText: string,
  now: Date,
  relatedClaimId: string | null,
) {
  const reviewVersion = trial.version + 1;
  const [source] = await db
    .insert(coreSchema.sourceItems)
    .values({
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
      sourceKind: "action_trial_review",
      authorKind: "subject",
      content: selfReportText,
      // The review is captured now; when the trial was carried out is not stated.
      occurredAt: null,
      externalRef: `action-trial-review:${trial.id}:v${reviewVersion}`,
      sourceMeta: {
        record_kind: "action_trial_review",
        origin: "structured_self_report",
        trial_id: trial.id,
        prior_trial_version: trial.version,
        review_version: reviewVersion,
        reviewed_at: now.toISOString(),
        proposal_id: trial.proposalId,
        related_claim_revision_id: relatedClaimId,
        topic_linkage: "pending_user_selection",
      },
    })
    .returning();
  if (!source) throw new Error("ACTION_TRIAL_REVIEW_SOURCE_CREATE_FAILED");
  await db.insert(coreSchema.sourceAssessments).values({
    sourceItemId: source.id,
    version: 1,
    attributionStatus: "confirmed_subject",
    contextCompleteness: body.observation ? "sufficient" : "partial",
    temporalPrecision: "unknown",
    eligibility: "needs_review",
    rationale:
      "本人提交的 ActionTrial 回顾结构化记录；未执行与作用未知按原值保留，尚未关联专题或形成认识。",
  });
  await db.insert(coreSchema.evidenceSpans).values({
    sourceItemId: source.id,
    quote: selfReportText,
    locator: {
      kind: "structured_self_report",
      trial_id: trial.id,
      prior_trial_version: trial.version,
      review_version: reviewVersion,
      fields: ["execution", "outcome", "burden", "observation", "continue_trial"],
      verbatim: false,
    },
    authorKind: "subject",
    aboutSubject: true,
  });

  return source;
}
