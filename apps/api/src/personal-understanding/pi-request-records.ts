import { randomUUID } from "node:crypto";
import { type Db, coreSchema as c } from "@findme/db";
import { and, eq } from "drizzle-orm";
import { lockPiProfileState, withProfileTransaction } from "../cloud-diagnostic/scope.js";
import type { PersonalContext } from "../core/exploration-types.js";
import { type PiArchiveDependency, assertPiDependenciesCurrent } from "./pi-archive.js";

type Event = {
  sequence: number;
  input?: unknown;
  payload?: unknown;
  output?: unknown;
  reservedUsd?: number;
};
const dollars = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
/** A reported total must carry provenance. SDK component estimates are not bills. */
export function piOutputCosts(output: unknown) {
  const usage = (output as { usage?: { cost?: Record<string, unknown> } } | null)?.usage;
  const cost = usage?.cost;
  const components = cost
    ? [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].map(dollars)
    : [];
  return {
    providerActualUsd: cost?.totalFromProvider === true ? dollars(cost.total) : null,
    estimatedCostUsd:
      components.length === 4 && components.every((x) => x !== null)
        ? components.reduce<number>((sum, x) => sum + (x ?? 0), 0)
        : null,
  };
}

/** New instance per execution attempt; a retried operation never overwrites its earlier spend. */
export class SqlPiRequestRecords {
  readonly attemptId = randomUUID();
  constructor(private readonly db: Db) {}
  async record(
    ctx: PersonalContext,
    operationId: string,
    conversationId: string,
    raw: unknown,
    dependencies: readonly PiArchiveDependency[],
  ) {
    const event = structuredClone(raw) as Event;
    if (!Number.isSafeInteger(event?.sequence) || event.sequence < 1)
      throw new Error("PI_REQUEST_RECORD_INVALID");
    if (event.input === undefined && event.payload === undefined && event.output === undefined)
      throw new Error("PI_REQUEST_RECORD_INVALID");
    const deps = structuredClone([...dependencies]);
    const staleAfterSettlement = await withProfileTransaction(this.db, ctx, async (tx) => {
      await lockPiProfileState(tx, ctx);
      const [operation] = await tx
        .select({ id: c.coreOperations.id })
        .from(c.coreOperations)
        .where(
          and(
            eq(c.coreOperations.id, operationId),
            eq(c.coreOperations.tenantId, ctx.tenantId),
            eq(c.coreOperations.subjectId, ctx.subjectId),
          ),
        )
        .limit(1);
      if (!operation) throw new Error("PI_REQUEST_OPERATION_NOT_AVAILABLE");
      const identity = and(
        eq(c.piRequestRecords.tenantId, ctx.tenantId),
        eq(c.piRequestRecords.subjectId, ctx.subjectId),
        eq(c.piRequestRecords.operationId, operationId),
        eq(c.piRequestRecords.attemptId, this.attemptId),
        eq(c.piRequestRecords.sequence, event.sequence),
      );
      const [previous] = await tx.select().from(c.piRequestRecords).where(identity).limit(1);
      let stale = previous?.status === "stale";
      try {
        await assertPiDependenciesCurrent(tx, ctx, deps);
      } catch (error) {
        if (error instanceof Error && error.message === "PI_ARCHIVE_STALE_DEPENDENCY") stale = true;
        else throw error;
      }
      if (stale) {
        // Settling a returned bill needs no personal text. Persist numbers while
        // still rejecting publication and preserving the cleared record body.
        if (previous && event.output !== undefined) {
          await tx.update(c.piRequestRecords).set(piOutputCosts(event.output)).where(identity);
          return true;
        }
        throw new Error("PI_ARCHIVE_STALE_DEPENDENCY");
      }
      const merged = new Map((previous?.dependencies ?? []).map((d) => [d.sourceId, d]));
      for (const dep of deps) {
        const old = merged.get(dep.sourceId);
        if (old && old.fingerprint !== dep.fingerprint)
          throw new Error("PI_ARCHIVE_STALE_DEPENDENCY");
        merged.set(dep.sourceId, dep);
      }
      const update = {
        dependencies: [...merged.values()],
        ...(event.input !== undefined ? { piInput: event.input } : {}),
        ...(event.payload !== undefined
          ? {
              providerPayload: event.payload,
              reservedUsd: dollars(event.reservedUsd),
              status: previous?.status === "completed" ? "completed" : "sent",
            }
          : {}),
        ...(event.output !== undefined
          ? { output: event.output, ...piOutputCosts(event.output), status: "completed" }
          : {}),
      };
      if (previous) await tx.update(c.piRequestRecords).set(update).where(identity);
      else
        await tx.insert(c.piRequestRecords).values({
          ...ctx,
          operationId,
          conversationId,
          attemptId: this.attemptId,
          sequence: event.sequence,
          status: "prepared",
          ...update,
        });
    });
    if (staleAfterSettlement) throw new Error("PI_ARCHIVE_STALE_DEPENDENCY");
  }
  async usage(ctx: PersonalContext, operationId: string) {
    return withProfileTransaction(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(c.piRequestRecords)
        .where(
          and(
            eq(c.piRequestRecords.tenantId, ctx.tenantId),
            eq(c.piRequestRecords.subjectId, ctx.subjectId),
            eq(c.piRequestRecords.operationId, operationId),
          ),
        );
      const dispatched = rows.filter((r) => r.reservedUsd !== null);
      const actual = dispatched.map((r) => r.providerActualUsd);
      const known = actual.reduce<number>((sum, x) => sum + (x ?? 0), 0);
      return {
        requests: dispatched.length,
        reservedUsd: dispatched.reduce((sum, r) => sum + (r.reservedUsd ?? 0), 0),
        providerActualUsd: dispatched.length && actual.every((x) => x !== null) ? known : null,
        knownProviderActualUsd: known,
        unknownActualRequests: actual.filter((x) => x === null).length,
        estimatedCostUsd:
          dispatched.length && dispatched.every((r) => r.estimatedCostUsd !== null)
            ? dispatched.reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0)
            : null,
      };
    });
  }
}
