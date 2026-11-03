import { UpdateSourceAssessmentInput } from "@findme/core";
import { type Db, coreSchema } from "@findme/db";
import { and, eq } from "drizzle-orm";
import { CoreError } from "./errors.js";
import type { PersonalContext } from "./exploration-service.js";
import { completeCoreOperation } from "./operations.js";
import {
  invalidateCoreSourceUnderstanding,
  lockCoreSourceExplorations,
} from "./source-invalidation.js";

export async function updateSourceAssessment(
  db: Db,
  ctx: PersonalContext,
  input: unknown,
  operationId?: string,
) {
  const parsed = UpdateSourceAssessmentInput.parse(input);

  const [source] = await db
    .select()
    .from(coreSchema.sourceItems)
    .where(
      and(
        eq(coreSchema.sourceItems.id, parsed.source_id),
        eq(coreSchema.sourceItems.tenantId, ctx.tenantId),
        eq(coreSchema.sourceItems.subjectId, ctx.subjectId),
      ),
    )
    .limit(1);
  if (!source) throw new CoreError("SOURCE_VERSION_CONFLICT", 409, "来源不存在或不可修改");

  const [currentAssessment] = await db
    .select()
    .from(coreSchema.sourceAssessments)
    .where(
      and(
        eq(coreSchema.sourceAssessments.sourceItemId, source.id),
        eq(coreSchema.sourceAssessments.isCurrent, true),
      ),
    )
    .limit(1);
  if (!currentAssessment) {
    throw new CoreError("SOURCE_VERSION_CONFLICT", 409, "来源当前评估不存在");
  }
  if (currentAssessment.version !== parsed.expected_assessment_version) {
    throw new CoreError("SOURCE_VERSION_CONFLICT", 409, "来源评估已经发生变化", {
      current_version: currentAssessment.version,
    });
  }

  return db.transaction(async (tx) => {
    await lockCoreSourceExplorations(tx, ctx, [source.id]);
    const [retired] = await tx
      .update(coreSchema.sourceAssessments)
      .set({ isCurrent: false })
      .where(
        and(
          eq(coreSchema.sourceAssessments.id, currentAssessment.id),
          eq(coreSchema.sourceAssessments.version, parsed.expected_assessment_version),
          eq(coreSchema.sourceAssessments.isCurrent, true),
        ),
      )
      .returning({ id: coreSchema.sourceAssessments.id });
    if (!retired) {
      throw new CoreError("SOURCE_VERSION_CONFLICT", 409, "来源评估已经发生变化");
    }

    const [assessment] = await tx
      .insert(coreSchema.sourceAssessments)
      .values({
        sourceItemId: source.id,
        version: currentAssessment.version + 1,
        attributionStatus: parsed.assessment.attribution_status,
        contextCompleteness: parsed.assessment.context_completeness,
        temporalPrecision: parsed.assessment.temporal_precision,
        eligibility: parsed.assessment.eligibility,
        rationale: parsed.assessment.rationale,
        isCurrent: true,
        supersedesId: currentAssessment.id,
      })
      .returning();
    if (!assessment) throw new Error("source_assessment_create_failed");

    const affected = await invalidateCoreSourceUnderstanding(
      tx,
      ctx,
      [source.id],
      `source_assessment:${assessment.id}`,
    );

    const response = {
      source_id: source.id,
      assessment_version: assessment.version,
      eligibility: assessment.eligibility,
      attribution_status: assessment.attributionStatus,
      ...affected,
    };
    if (operationId) {
      await completeCoreOperation(tx, operationId, 200, response);
    }
    return response;
  });
}
