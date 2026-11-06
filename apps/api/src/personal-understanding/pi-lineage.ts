import { coreSchema as c } from "@findme/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ProfileTransaction } from "../cloud-diagnostic/scope.js";
import type { PersonalContext } from "../core/exploration-types.js";
import { type PiArchiveDependency, capturePiDependencies } from "./pi-archive.js";

/** pi replies carry the full transitive input set, including tool-read sources. */
export async function capturePiReplyLineage(
  tx: ProfileTransaction,
  ctx: PersonalContext,
  turnIds: readonly string[],
) {
  if (!turnIds.length)
    return { dependencies: [] as PiArchiveDependency[], unavailableTurnIds: [] as string[] };
  const rows = await tx
    .select({ meta: c.sourceItems.sourceMeta })
    .from(c.sourceItems)
    .where(
      and(
        eq(c.sourceItems.tenantId, ctx.tenantId),
        eq(c.sourceItems.subjectId, ctx.subjectId),
        sql`${c.sourceItems.sourceMeta}->'reply'->>'turn_id' in (${sql.join(
          turnIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    );
  const dependencies = new Map<string, PiArchiveDependency>();
  const unavailableTurnIds: string[] = [];
  for (const turnId of turnIds) {
    const owners = rows.filter(
      (row) => (row.meta?.reply as { turn_id?: unknown } | undefined)?.turn_id === turnId,
    );
    const reply = owners.length === 1 ? owners[0]?.meta?.reply : null;
    const parsed = z
      .object({ engine: z.literal("pi"), source_ids: z.array(z.string().uuid()).min(1) })
      .safeParse(reply);
    if (!parsed.success) {
      unavailableTurnIds.push(turnId);
      continue;
    }
    try {
      const captured = await capturePiDependencies(tx, ctx, parsed.data.source_ids);
      for (const dep of captured) dependencies.set(dep.sourceId, dep);
    } catch (error) {
      if (error instanceof Error && error.message === "PI_ARCHIVE_STALE_DEPENDENCY")
        unavailableTurnIds.push(turnId);
      else throw error;
    }
  }
  return { dependencies: [...dependencies.values()], unavailableTurnIds };
}
