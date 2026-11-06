import { createHash } from "node:crypto";
import { coreSchema as c } from "@findme/db";
import { and, eq } from "drizzle-orm";
import type { ProfileTransaction } from "../cloud-diagnostic/scope.js";
import type { PersonalContext } from "../core/exploration-types.js";
import { REASSESSMENT_FEEDBACK_TYPES, currentRevisionFeedback } from "../core/pending-feedback.js";
import { capturePiDependencies } from "./pi-archive.js";

export type PiRevisionDependency = { revisionId: string; fingerprint: string };

const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) => {
        if (item && typeof item === "object" && !Array.isArray(item))
          return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
        return item;
      }),
    )
    .digest("hex");

/** Revision status is independent of source status: withdrawal must invalidate a remembered claim. */
export async function capturePiRevisionDependency(
  tx: ProfileTransaction,
  ctx: PersonalContext,
  revisionId: string,
  requireCurrent = false,
): Promise<PiRevisionDependency> {
  const [row] = await tx
    .select({ revision: c.claimRevisions, claim: c.claims })
    .from(c.claimRevisions)
    .innerJoin(c.claims, eq(c.claims.id, c.claimRevisions.claimId))
    .where(
      and(
        eq(c.claimRevisions.id, revisionId),
        eq(c.claims.tenantId, ctx.tenantId),
        eq(c.claims.subjectId, ctx.subjectId),
      ),
    )
    .for("share");
  if (
    !row ||
    (requireCurrent &&
      (row.revision.status !== "current" || row.revision.evidenceStatus !== "valid"))
  )
    throw new Error("PI_REVISION_STALE_DEPENDENCY");
  const feedback = await currentRevisionFeedback(tx, ctx, [revisionId], true);
  if (requireCurrent && feedback.some((item) => REASSESSMENT_FEEDBACK_TYPES.has(item.type)))
    throw new Error("PI_REVISION_STALE_DEPENDENCY");
  const sources = feedback.length
    ? await capturePiDependencies(
        tx,
        ctx,
        feedback.map((item) => item.source.id),
      )
    : [];
  const feedbackState = feedback.map((item) => ({
    id: item.id,
    type: item.type,
    sourceId: item.source.id,
    sourceFingerprint: sources.find((source) => source.sourceId === item.source.id)?.fingerprint,
  }));
  return { revisionId, fingerprint: fingerprint({ ...row, feedback: feedbackState }) };
}

export async function assertPiRevisionsCurrent(
  tx: ProfileTransaction,
  ctx: PersonalContext,
  dependencies: readonly PiRevisionDependency[],
) {
  const unique = new Map(dependencies.map((d) => [d.revisionId, d.fingerprint]));
  if (
    unique.size !== dependencies.length ||
    dependencies.some((d) => !/^[a-f0-9]{64}$/.test(d.fingerprint))
  )
    throw new Error("PI_REVISION_STALE_DEPENDENCY");
  for (const dependency of [...dependencies].sort((a, b) =>
    a.revisionId.localeCompare(b.revisionId),
  )) {
    if (
      (await capturePiRevisionDependency(tx, ctx, dependency.revisionId)).fingerprint !==
      dependency.fingerprint
    )
      throw new Error("PI_REVISION_STALE_DEPENDENCY");
  }
}
