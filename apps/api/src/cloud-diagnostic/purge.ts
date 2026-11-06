import {
  type Db,
  archiveSchema as a,
  coreSchema as c,
  diagnosticSchema as d,
  knowledgeSchema as k,
  platformSchema as p,
  specialistSchema as s,
} from "@findme/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import { requestHash } from "../core/operations.js";
import { digest } from "../shared/primitives.js";
import type { BlobStore } from "./blobs.js";
import { withProfileTransaction } from "./scope.js";
/** Explicit whole-profile erasure. Keeps login, profile identity and aggregate spend counters. */
export class ProfilePurgeService {
  constructor(
    private db: Db,
    private blobs?: BlobStore,
  ) {}
  async purge(ctx: PersonalContext, key: string, confirm: boolean) {
    if (!confirm || !key.trim() || key.length > 200)
      throw new Error("PROFILE_DELETE_CONFIRMATION_REQUIRED");
    const requestHashValue = await requestHash({ ctx, operation: "erase-profile-data@1" });
    const intent = await withProfileTransaction(
      this.db,
      ctx,
      async (tx) => {
        const [prior] = await tx
          .select()
          .from(p.lifecycleActions)
          .where(
            and(
              eq(p.lifecycleActions.tenantId, ctx.tenantId),
              eq(p.lifecycleActions.subjectId, ctx.subjectId),
              eq(p.lifecycleActions.idempotencyKey, key),
            ),
          )
          .limit(1);
        if (prior) {
          if (prior.requestHash !== requestHashValue) throw new Error("IDEMPOTENCY_KEY_REUSED");
          if (prior.result.completed)
            return { completed: true, objects: [] as { id: string; objectKey: string }[] };
        }
        const [subject] = await tx
          .select()
          .from(c.subjects)
          .where(and(eq(c.subjects.id, ctx.subjectId), eq(c.subjects.tenantId, ctx.tenantId)))
          .limit(1)
          .for("update");
        if (!subject) throw new Error("PROFILE_NOT_FOUND");
        if (subject.ext?.deleting && subject.ext.deletion_key !== key)
          throw new Error("PROFILE_DELETE_ALREADY_PENDING");
        const objects = await tx
          .select()
          .from(d.sourceBlobs)
          .where(
            and(
              eq(d.sourceBlobs.tenantId, ctx.tenantId),
              eq(d.sourceBlobs.subjectId, ctx.subjectId),
            ),
          );
        if (objects.some((o) => o.status !== "deleted") && !this.blobs)
          throw new Error("BLOB_STORE_REQUIRED_FOR_ERASURE");
        await tx
          .update(c.subjects)
          .set({ ext: { ...subject.ext, deleting: true, deletion_key: key } })
          .where(eq(c.subjects.id, ctx.subjectId));
        await tx
          .update(p.cloudJobs)
          .set({
            status: "cancelled",
            execution: null,
            leaseUntil: null,
            error: "PROFILE_DATA_DELETION",
          })
          .where(
            and(eq(p.cloudJobs.tenantId, ctx.tenantId), eq(p.cloudJobs.subjectId, ctx.subjectId)),
          );
        await tx
          .update(d.sourceBlobs)
          .set({ status: "delete_pending" })
          .where(
            and(
              eq(d.sourceBlobs.tenantId, ctx.tenantId),
              eq(d.sourceBlobs.subjectId, ctx.subjectId),
              ne(d.sourceBlobs.status, "deleted"),
            ),
          );
        if (!prior)
          await tx.insert(p.lifecycleActions).values({
            ...ctx,
            idempotencyKey: key,
            requestHash: requestHashValue,
            kind: "profile_erase",
            result: { completed: false },
          });
        return {
          completed: false,
          objects: objects
            .filter((o) => o.status !== "deleted")
            .map((o) => ({ id: o.id, objectKey: o.objectKey })),
        };
      },
      { allowDeleting: true },
    );
    if (intent.completed) return { completed: true, replayed: true };
    const failures: string[] = [];
    for (const object of intent.objects) {
      try {
        if (!this.blobs) throw new Error("BLOB_STORE_REQUIRED");
        await this.blobs.delete(object.objectKey);
      } catch {
        failures.push(object.id);
      }
    }
    if (failures.length)
      return {
        completed: false,
        blocked: true,
        reason: "OBJECT_DELETE_PENDING",
        remaining_objects: failures.length,
        resume_key: key,
      };
    return withProfileTransaction(
      this.db,
      ctx,
      async (tx) => {
        const [subject] = await tx
          .select()
          .from(c.subjects)
          .where(and(eq(c.subjects.id, ctx.subjectId), eq(c.subjects.tenantId, ctx.tenantId)))
          .limit(1)
          .for("update");
        if (!subject?.ext?.deleting || subject.ext.deletion_key !== key)
          throw new Error("PROFILE_DELETE_STATE_CHANGED");
        await tx
          .delete(k.knowledgeProcessingRecords)
          .where(
            and(
              eq(k.knowledgeProcessingRecords.tenantId, ctx.tenantId),
              eq(k.knowledgeProcessingRecords.subjectId, ctx.subjectId),
            ),
          );
        // Archive parts reference batches; erase both in this same owner-scoped transaction.
        await tx
          .delete(a.processedChunks)
          .where(
            and(
              eq(a.processedChunks.tenantId, ctx.tenantId),
              eq(a.processedChunks.subjectId, ctx.subjectId),
            ),
          );
        await tx
          .delete(a.processedBatches)
          .where(
            and(
              eq(a.processedBatches.tenantId, ctx.tenantId),
              eq(a.processedBatches.subjectId, ctx.subjectId),
            ),
          );
        const sources = await tx
          .select({ id: c.sourceItems.id })
          .from(c.sourceItems)
          .where(
            and(
              eq(c.sourceItems.tenantId, ctx.tenantId),
              eq(c.sourceItems.subjectId, ctx.subjectId),
            ),
          );
        const sourceIds = sources.map((s) => s.id);
        const claims = await tx
          .select({ id: c.claims.id })
          .from(c.claims)
          .where(and(eq(c.claims.tenantId, ctx.tenantId), eq(c.claims.subjectId, ctx.subjectId)));
        if (claims.length) {
          const revisions = await tx
            .select({ id: c.claimRevisions.id })
            .from(c.claimRevisions)
            .where(
              inArray(
                c.claimRevisions.claimId,
                claims.map((x) => x.id),
              ),
            );
          if (revisions.length)
            await tx.delete(c.claimEvidence).where(
              inArray(
                c.claimEvidence.claimRevisionId,
                revisions.map((x) => x.id),
              ),
            );
          await tx.delete(c.claimRevisions).where(
            inArray(
              c.claimRevisions.claimId,
              claims.map((x) => x.id),
            ),
          );
          await tx.delete(c.claims).where(
            inArray(
              c.claims.id,
              claims.map((x) => x.id),
            ),
          );
        }
        const es = await tx
          .select({ id: c.explorations.id, experienceId: c.explorations.experienceId })
          .from(c.explorations)
          .where(
            and(
              eq(c.explorations.tenantId, ctx.tenantId),
              eq(c.explorations.subjectId, ctx.subjectId),
            ),
          );
        const ids = es.map((e) => e.id);
        await tx
          .delete(c.feedbackEvents)
          .where(
            and(
              eq(c.feedbackEvents.tenantId, ctx.tenantId),
              eq(c.feedbackEvents.subjectId, ctx.subjectId),
            ),
          );
        await tx
          .delete(c.piSessionArchives)
          .where(
            and(
              eq(c.piSessionArchives.tenantId, ctx.tenantId),
              eq(c.piSessionArchives.subjectId, ctx.subjectId),
            ),
          );
        await tx
          .delete(c.coreOperations)
          .where(
            and(
              eq(c.coreOperations.tenantId, ctx.tenantId),
              eq(c.coreOperations.subjectId, ctx.subjectId),
            ),
          );
        if (ids.length) {
          await tx.delete(c.explorationSteps).where(inArray(c.explorationSteps.explorationId, ids));
          await tx.delete(c.explorationTurns).where(inArray(c.explorationTurns.explorationId, ids));
          await tx
            .delete(c.explorationQuestions)
            .where(inArray(c.explorationQuestions.explorationId, ids));
          await tx.delete(c.knowledgeGaps).where(inArray(c.knowledgeGaps.explorationId, ids));
          await tx.delete(c.explorations).where(inArray(c.explorations.id, ids));
        }
        const experiences = await tx
          .select({ id: c.experiences.id })
          .from(c.experiences)
          .where(
            and(
              eq(c.experiences.tenantId, ctx.tenantId),
              eq(c.experiences.subjectId, ctx.subjectId),
            ),
          );
        if (experiences.length) {
          await tx.delete(c.experienceEvidence).where(
            inArray(
              c.experienceEvidence.experienceId,
              experiences.map((e) => e.id),
            ),
          );
          await tx.delete(c.experiences).where(
            inArray(
              c.experiences.id,
              experiences.map((e) => e.id),
            ),
          );
        }
        await tx
          .delete(d.diagnosticReportSources)
          .where(
            and(
              eq(d.diagnosticReportSources.tenantId, ctx.tenantId),
              eq(d.diagnosticReportSources.subjectId, ctx.subjectId),
            ),
          );
        await tx
          .delete(d.diagnosticResponses)
          .where(
            and(
              eq(d.diagnosticResponses.tenantId, ctx.tenantId),
              eq(d.diagnosticResponses.subjectId, ctx.subjectId),
            ),
          );
        await tx
          .delete(d.diagnosticReportRevisions)
          .where(
            and(
              eq(d.diagnosticReportRevisions.tenantId, ctx.tenantId),
              eq(d.diagnosticReportRevisions.subjectId, ctx.subjectId),
            ),
          );
        await tx
          .delete(p.cloudAttempts)
          .where(
            and(
              eq(p.cloudAttempts.tenantId, ctx.tenantId),
              eq(p.cloudAttempts.subjectId, ctx.subjectId),
            ),
          );
        await tx
          .delete(p.sourceQualifications)
          .where(
            and(
              eq(p.sourceQualifications.tenantId, ctx.tenantId),
              eq(p.sourceQualifications.subjectId, ctx.subjectId),
            ),
          );
        await tx
          .delete(p.cloudJobs)
          .where(
            and(eq(p.cloudJobs.tenantId, ctx.tenantId), eq(p.cloudJobs.subjectId, ctx.subjectId)),
          );
        await tx
          .delete(k.knowledgeProcessingRecords)
          .where(
            and(
              eq(k.knowledgeProcessingRecords.tenantId, ctx.tenantId),
              eq(k.knowledgeProcessingRecords.subjectId, ctx.subjectId),
            ),
          );
        await tx
          .delete(s.specialistTrials)
          .where(
            and(
              eq(s.specialistTrials.tenantId, ctx.tenantId),
              eq(s.specialistTrials.subjectId, ctx.subjectId),
            ),
          );
        await tx
          .delete(s.specialistProposals)
          .where(
            and(
              eq(s.specialistProposals.tenantId, ctx.tenantId),
              eq(s.specialistProposals.subjectId, ctx.subjectId),
            ),
          );
        await tx
          .delete(s.specialistSessions)
          .where(
            and(
              eq(s.specialistSessions.tenantId, ctx.tenantId),
              eq(s.specialistSessions.subjectId, ctx.subjectId),
            ),
          );
        await tx
          .delete(d.diagnosticRuns)
          .where(
            and(
              eq(d.diagnosticRuns.tenantId, ctx.tenantId),
              eq(d.diagnosticRuns.subjectId, ctx.subjectId),
            ),
          );
        // Originals and session contexts reference their sources; remove them first.
        await tx
          .delete(d.sourceBlobs)
          .where(
            and(
              eq(d.sourceBlobs.tenantId, ctx.tenantId),
              eq(d.sourceBlobs.subjectId, ctx.subjectId),
            ),
          );
        if (sourceIds.length) {
          await tx.delete(c.sourceLinks).where(inArray(c.sourceLinks.sourceItemId, sourceIds));
          await tx
            .delete(c.sourceAssessments)
            .where(inArray(c.sourceAssessments.sourceItemId, sourceIds));
          await tx.delete(c.evidenceSpans).where(inArray(c.evidenceSpans.sourceItemId, sourceIds));
          await tx.delete(c.sourceItems).where(inArray(c.sourceItems.id, sourceIds));
        }
        await tx
          .delete(p.importBatches)
          .where(
            and(
              eq(p.importBatches.tenantId, ctx.tenantId),
              eq(p.importBatches.subjectId, ctx.subjectId),
            ),
          );
        const [framework] = await tx
          .select()
          .from(p.frameworkStates)
          .where(
            and(
              eq(p.frameworkStates.tenantId, ctx.tenantId),
              eq(p.frameworkStates.subjectId, ctx.subjectId),
            ),
          )
          .limit(1);
        if (framework) {
          const state = {
            format: "u4-framework-state@1",
            owner_key: `${ctx.tenantId}/${ctx.subjectId}`,
            revision: framework.version + 1,
            u4_calls_reserved: framework.state.u4_calls_reserved ?? 0,
            runs: [],
            jobs: [],
            attempts: [],
            actions: [],
          };
          await tx
            .update(p.frameworkStates)
            .set({ state, contentHash: digest(state), version: framework.version + 1 })
            .where(
              and(
                eq(p.frameworkStates.tenantId, ctx.tenantId),
                eq(p.frameworkStates.subjectId, ctx.subjectId),
              ),
            );
        }
        const result = {
          completed: true,
          sources_erased: sourceIds.length,
          objects_erased: intent.objects.length,
          account_preserved: true,
          aggregate_billing_preserved: true,
          external_downloads_recalled: false,
        };
        await tx
          .delete(p.lifecycleActions)
          .where(
            and(
              eq(p.lifecycleActions.tenantId, ctx.tenantId),
              eq(p.lifecycleActions.subjectId, ctx.subjectId),
              sql`${p.lifecycleActions.idempotencyKey} <> ${key}`,
            ),
          );
        await tx
          .update(p.lifecycleActions)
          .set({ result })
          .where(
            and(
              eq(p.lifecycleActions.tenantId, ctx.tenantId),
              eq(p.lifecycleActions.subjectId, ctx.subjectId),
              eq(p.lifecycleActions.idempotencyKey, key),
            ),
          );
        await tx
          .update(c.subjects)
          .set({ ext: { deletion_generation: Number(subject.ext.deletion_generation ?? 0) + 1 } })
          .where(eq(c.subjects.id, ctx.subjectId));
        return result;
      },
      { allowDeleting: true },
    );
  }
}
