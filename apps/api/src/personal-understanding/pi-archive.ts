import { createHash } from "node:crypto";
import { type Db, coreSchema as c } from "@findme/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { type ProfileTransaction, withProfileTransaction } from "../cloud-diagnostic/scope.js";
import type { PiSessionArchive } from "./pi-runtime.js";

/** Database source identity; no source text is duplicated in dependency metadata. */
export type PiArchiveScope = { tenantId: string; subjectId: string };
export type PiArchiveDependency = {
  sourceId: string;
  /** Fingerprint covers content, assessment and usage status, not just the text. */
  fingerprint: string;
};
export type PiArchiveRevision = {
  scope: PiArchiveScope;
  conversationId: string;
  revision: number;
  fingerprint: string;
  dependencies: PiArchiveDependency[];
  archive: PiSessionArchive;
};

/**
 * Storage boundary, deliberately not a source_meta implementation. The database
 * adapter must run this callback under the Profile's transaction/RLS and lock
 * dependencies against concurrent exclusion, deletion or assessment changes.
 * Hard deletion must redact quotation-bearing archive bodies and request traces.
 * No production adapter is registered until schema and lifecycle propagation exist.
 */
export interface PiArchiveTransaction {
  current(conversationId: string, sessionId: string): Promise<PiArchiveRevision | null>;
  dependenciesCurrent(dependencies: readonly PiArchiveDependency[]): Promise<boolean>;
  /** CAS is required even if a transaction lock is also used. */
  insertRevision(record: PiArchiveRevision, expectedRevision: number): Promise<void>;
}
export interface PiArchiveDatabase {
  scoped<T>(scope: PiArchiveScope, work: (tx: PiArchiveTransaction) => Promise<T>): Promise<T>;
}

function sameScope(a: PiArchiveScope, b: PiArchiveScope) {
  return a.tenantId === b.tenantId && a.subjectId === b.subjectId;
}
function validateDependencies(input: readonly PiArchiveDependency[]) {
  const dependencies = structuredClone([...input]).sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId),
  );
  if (
    !dependencies.length ||
    new Set(dependencies.map((d) => d.sourceId)).size !== dependencies.length
  )
    throw new Error("PI_ARCHIVE_DEPENDENCIES_REQUIRED");
  if (dependencies.some((d) => !d.sourceId || !/^[a-f0-9]{64}$/.test(d.fingerprint)))
    throw new Error("PI_ARCHIVE_INVALID_DEPENDENCY");
  return dependencies;
}
/** JSONB preserves arrays but normalizes object key order; hash that semantic form. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    return item;
  });
}

export function piArchiveFingerprint(
  archive: PiSessionArchive,
  dependencies: readonly PiArchiveDependency[],
) {
  return createHash("sha256")
    .update(canonicalJson({ archive, dependencies: validateDependencies(dependencies) }))
    .digest("hex");
}

/** Validate the replay envelope before storing or restoring a source snapshot. */
export function validatePiArchive(archive: PiSessionArchive): void {
  if (
    !archive ||
    archive.format !== "findme-pi-session@1" ||
    typeof archive.sessionId !== "string" ||
    !archive.sessionId ||
    !Array.isArray(archive.entries)
  )
    throw new Error("PI_ARCHIVE_INVALID_FORMAT");
  const header = archive.entries[0];
  if (
    !header ||
    header.type !== "session" ||
    header.id !== archive.sessionId ||
    header.version !== 3
  )
    throw new Error("PI_ARCHIVE_INVALID_IDENTITY");
  const ids = new Set<string>();
  for (const entry of archive.entries.slice(1)) {
    if (
      !entry ||
      entry.type === "session" ||
      typeof entry.id !== "string" ||
      !entry.id ||
      ids.has(entry.id)
    )
      throw new Error("PI_ARCHIVE_INVALID_ENTRY");
    if (entry.parentId !== null && !ids.has(entry.parentId))
      throw new Error("PI_ARCHIVE_INVALID_PARENT");
    ids.add(entry.id);
  }
  if (archive.leafId !== null && !ids.has(archive.leafId))
    throw new Error("PI_ARCHIVE_LEAF_MISSING");
}

/** Idempotent revisions scoped by Profile, product conversation and pi session. */
export class PiArchiveRepository {
  constructor(private readonly database: PiArchiveDatabase) {}

  async save(input: {
    scope: PiArchiveScope;
    conversationId: string;
    expectedRevision: number;
    dependencies: readonly PiArchiveDependency[];
    archive: PiSessionArchive;
  }) {
    // Capture before awaiting to prevent callers mutating a different snapshot into the write.
    const args = structuredClone(input);
    if (
      !args.conversationId ||
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0
    )
      throw new Error("PI_ARCHIVE_INVALID_REVISION");
    validatePiArchive(args.archive);
    const dependencies = validateDependencies(args.dependencies);
    const fingerprint = piArchiveFingerprint(args.archive, dependencies);
    return this.database.scoped(args.scope, async (tx) => {
      const previous = await tx.current(args.conversationId, args.archive.sessionId);
      if (previous && !sameScope(previous.scope, args.scope))
        throw new Error("PI_ARCHIVE_SCOPE_MISMATCH");
      // Even an identical replay cannot revive sources that have become unavailable.
      if (!(await tx.dependenciesCurrent(dependencies)))
        throw new Error("PI_ARCHIVE_STALE_DEPENDENCY");
      if (previous?.fingerprint === fingerprint && previous.archive) return previous;
      if ((previous?.revision ?? 0) !== args.expectedRevision)
        throw new Error("PI_ARCHIVE_STALE_REVISION");
      const record: PiArchiveRevision = {
        scope: args.scope,
        conversationId: args.conversationId,
        revision: args.expectedRevision + 1,
        fingerprint,
        dependencies,
        archive: args.archive,
      };
      await tx.insertRevision(record, args.expectedRevision);
      return structuredClone(record);
    });
  }

  async restore(scope: PiArchiveScope, conversationId: string, sessionId: string) {
    const scoped = structuredClone(scope);
    return this.database.scoped(scoped, async (tx) => {
      const record = await tx.current(conversationId, sessionId);
      if (!record) return null;
      if (!record.archive)
        return {
          status: "rebuild_required" as const,
          reason: "source_changed_or_unavailable" as const,
        };
      if (
        !sameScope(record.scope, scoped) ||
        record.conversationId !== conversationId ||
        record.archive.sessionId !== sessionId
      )
        throw new Error("PI_ARCHIVE_SCOPE_MISMATCH");
      validatePiArchive(record.archive);
      if (piArchiveFingerprint(record.archive, record.dependencies) !== record.fingerprint)
        throw new Error("PI_ARCHIVE_CORRUPT");
      if (!(await tx.dependenciesCurrent(record.dependencies)))
        return {
          status: "rebuild_required" as const,
          reason: "source_changed_or_unavailable" as const,
        };
      return {
        status: "available" as const,
        revision: record.revision,
        archive: structuredClone(record.archive),
      };
    });
  }
}

// SQL implementation: every transaction is short and contains no model calls.

async function dependencyFingerprint(tx: ProfileTransaction, scope: PiArchiveScope, id: string) {
  const [source] = await tx
    .select()
    .from(c.sourceItems)
    .where(
      and(
        eq(c.sourceItems.id, id),
        eq(c.sourceItems.tenantId, scope.tenantId),
        eq(c.sourceItems.subjectId, scope.subjectId),
      ),
    )
    .for("share");
  if (!source || source.usageStatus !== "active") return null;
  const assessments = await tx
    .select()
    .from(c.sourceAssessments)
    .where(and(eq(c.sourceAssessments.sourceItemId, id), eq(c.sourceAssessments.isCurrent, true)))
    .for("share");
  const assessment = assessments[0];
  if (
    assessments.length !== 1 ||
    !assessment ||
    !["eligible", "context_only"].includes(assessment.eligibility)
  )
    return null;
  return createHash("sha256").update(canonicalJson({ source, assessment })).digest("hex");
}

export class SqlPiArchiveDatabase implements PiArchiveDatabase {
  constructor(private readonly db: Db) {}
  async captureDependencies(scope: PiArchiveScope, ids: readonly string[]) {
    return withProfileTransaction(this.db, scope, async (tx) => {
      const result: PiArchiveDependency[] = [];
      for (const sourceId of [...new Set(ids)].sort()) {
        const fingerprint = await dependencyFingerprint(tx, scope, sourceId);
        if (!fingerprint) throw new Error("PI_ARCHIVE_STALE_DEPENDENCY");
        result.push({ sourceId, fingerprint });
      }
      return validateDependencies(result);
    });
  }
  scoped<T>(scope: PiArchiveScope, work: (tx: PiArchiveTransaction) => Promise<T>) {
    const scoped = structuredClone(scope);
    return withProfileTransaction(this.db, scoped, async (tx) =>
      work({
        current: async (conversationId, sessionId) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([scoped.tenantId, scoped.subjectId, conversationId, sessionId])}, 0))`,
          );
          const [row] = await tx
            .select()
            .from(c.piSessionArchives)
            .where(
              and(
                eq(c.piSessionArchives.tenantId, scoped.tenantId),
                eq(c.piSessionArchives.subjectId, scoped.subjectId),
                eq(c.piSessionArchives.conversationId, conversationId),
                eq(c.piSessionArchives.sessionId, sessionId),
              ),
            )
            .orderBy(desc(c.piSessionArchives.revision))
            .limit(1);
          if (!row) return null;
          // Preserve latest revision for CAS even when its payload was invalidated.
          return {
            scope: scoped,
            conversationId,
            revision: row.revision,
            fingerprint: row.fingerprint,
            dependencies: row.dependencies,
            archive: row.archive as unknown as PiSessionArchive,
          };
        },
        dependenciesCurrent: async (dependencies) => {
          for (const dependency of [...dependencies].sort((a, b) =>
            a.sourceId.localeCompare(b.sourceId),
          ))
            if (
              (await dependencyFingerprint(tx, scoped, dependency.sourceId)) !==
              dependency.fingerprint
            )
              return false;
          return true;
        },
        insertRevision: async (record) => {
          await tx.insert(c.piSessionArchives).values({
            ...scoped,
            conversationId: record.conversationId,
            sessionId: record.archive.sessionId,
            revision: record.revision,
            fingerprint: record.fingerprint,
            dependencies: record.dependencies,
            archive: record.archive as unknown as Record<string, unknown>,
          });
        },
      }),
    );
  }
}
