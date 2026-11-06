import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { coreSchema, createDb } from "@findme/db";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { ProfileService } from "../src/auth/profiles.js";
import { invalidateCloudSources } from "../src/cloud-diagnostic/effects.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import {
  PiArchiveRepository,
  SqlPiArchiveDatabase,
  assertPiDependenciesCurrent,
  piArchiveFingerprint,
  validatePiArchive,
} from "../src/personal-understanding/pi-archive.js";

it("hashes JSONB-normalized object keys identically while preserving array order", () => {
  const archive = {
    format: "findme-pi-session@1" as const,
    sessionId: "s",
    leafId: null,
    entries: [
      {
        type: "session" as const,
        version: 3,
        id: "s",
        timestamp: "2026-11-06T00:00:00Z",
        cwd: "/findme",
      },
    ],
  };
  const reorder = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reorder)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, item]) => [key, reorder(item)]),
          )
        : value;
  const dependencies = [{ sourceId: "source-1", fingerprint: "a".repeat(64) }];
  expect(piArchiveFingerprint(archive, dependencies)).toBe(
    piArchiveFingerprint(
      reorder(archive) as typeof archive,
      reorder(dependencies) as typeof dependencies,
    ),
  );
  const first = {
    ...archive,
    entries: [...archive.entries, { ...archive.entries[0]!, id: "second" }],
  };
  expect(piArchiveFingerprint(first, dependencies)).not.toBe(
    piArchiveFingerprint({ ...first, entries: [...first.entries].reverse() }, dependencies),
  );
});

it("rejects mismatched session identity and missing leaf before writing", async () => {
  const archive = {
    format: "findme-pi-session@1" as const,
    sessionId: "s",
    leafId: null,
    entries: [
      {
        type: "session" as const,
        version: 3,
        id: "s",
        timestamp: "2026-11-06T00:00:00Z",
        cwd: "/findme",
      },
    ],
  };
  expect(() => validatePiArchive({ ...archive, sessionId: "other" })).toThrow(
    "PI_ARCHIVE_INVALID_IDENTITY",
  );
  expect(() => validatePiArchive({ ...archive, leafId: "missing" })).toThrow(
    "PI_ARCHIVE_LEAF_MISSING",
  );
  expect(() => validatePiArchive({ ...archive, format: "other" as typeof archive.format })).toThrow(
    "PI_ARCHIVE_INVALID_FORMAT",
  );
  let entered = false;
  const repository = new PiArchiveRepository({
    scoped: async () => {
      entered = true;
      throw new Error("unexpected DB access");
    },
  });
  await expect(
    repository.save({
      scope: { tenantId: "t", subjectId: "p" },
      conversationId: "c",
      expectedRevision: 0,
      dependencies: [{ sourceId: "source-1", fingerprint: "a".repeat(64) }],
      archive: { ...archive, sessionId: "other" },
    }),
  ).rejects.toThrow("PI_ARCHIVE_INVALID_IDENTITY");
  expect(entered).toBe(false);
});

it("archives pi sources idempotently, isolates Profiles, and clears every snapshot on source exclusion", async () => {
  const cfg = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const db = createDb(cfg.runtime_url);
  const identity = createDb(cfg.identity_url);
  try {
    const profiles = new ProfileService(identity.db);
    const ctx = await profiles.resolve({ provider: "pi-archive-test", principalId: randomUUID() });
    const other = await profiles.resolve({
      provider: "pi-archive-test",
      principalId: randomUUID(),
    });
    const source = await withProfileTransaction(db.db, ctx, async (tx) => {
      const [source] = await tx
        .insert(coreSchema.sourceItems)
        .values({
          ...ctx,
          sourceKind: "native_event",
          authorKind: "subject",
          content: "synthetic original",
        })
        .returning();
      await tx.insert(coreSchema.sourceAssessments).values({
        sourceItemId: source!.id,
        version: 1,
        attributionStatus: "confirmed_subject",
        contextCompleteness: "sufficient",
        temporalPrecision: "unknown",
        eligibility: "eligible",
        rationale: "synthetic",
      });
      return source!;
    });
    const sql = new SqlPiArchiveDatabase(db.db);
    const repository = new PiArchiveRepository(sql);
    const sessionId = randomUUID();
    const archive = {
      format: "findme-pi-session@1" as const,
      sessionId,
      leafId: null,
      entries: [
        {
          type: "session" as const,
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: "/findme",
        },
      ],
    };
    const native = await withProfileTransaction(db.db, ctx, async (tx) => {
      const [experience] = await tx
        .insert(coreSchema.experiences)
        .values({ ...ctx, summary: "synthetic topic" })
        .returning();
      const [conversation] = await tx
        .insert(coreSchema.explorations)
        .values({ ...ctx, experienceId: experience!.id })
        .returning();
      const [unaffected] = await tx
        .insert(coreSchema.explorations)
        .values({ ...ctx, experienceId: experience!.id })
        .returning();
      const [piTurn] = await tx
        .insert(coreSchema.explorationTurns)
        .values({
          explorationId: conversation!.id,
          role: "assistant",
          turnKind: "pi_reply",
          content: "quoted from excluded source",
        })
        .returning();
      await tx.insert(coreSchema.explorationTurns).values([
        {
          explorationId: conversation!.id,
          role: "assistant",
          turnKind: "reply",
          content: "legacy reply remains",
        },
        {
          explorationId: unaffected!.id,
          role: "assistant",
          turnKind: "pi_reply",
          content: "unrelated pi reply remains",
        },
      ]);
      const [operation] = await tx
        .insert(coreSchema.coreOperations)
        .values({
          ...ctx,
          explorationId: conversation!.id,
          idempotencyKey: randomUUID(),
          operationType: "exploration_reply",
          requestHash: "synthetic",
          status: "completed",
          responseStatus: 201,
          responseBody: {
            engine: "pi",
            message_source_id: source.id,
            reply: "quoted from excluded source",
          },
        })
        .returning();
      const [legacyOperation] = await tx
        .insert(coreSchema.coreOperations)
        .values({
          ...ctx,
          explorationId: conversation!.id,
          idempotencyKey: randomUUID(),
          operationType: "exploration_reply",
          requestHash: "synthetic",
          status: "completed",
          responseStatus: 201,
          responseBody: { reply: "legacy reply remains" },
        })
        .returning();
      return {
        conversationId: conversation!.id,
        unaffectedId: unaffected!.id,
        piTurnId: piTurn!.id,
        operationId: operation!.id,
        legacyOperationId: legacyOperation!.id,
      };
    });
    await withProfileTransaction(db.db, ctx, (tx) =>
      tx
        .update(coreSchema.sourceItems)
        .set({ sourceMeta: { exploration_id: native.conversationId } })
        .where(eq(coreSchema.sourceItems.id, source.id)),
    );
    const dependencies = await sql.captureDependencies(ctx, [source.id]);
    const input = {
      scope: ctx,
      conversationId: native.conversationId,
      expectedRevision: 0,
      dependencies,
      archive,
    };
    await expect(
      withProfileTransaction(db.db, ctx, async (tx) => {
        const bound = new PiArchiveRepository(SqlPiArchiveDatabase.forTransaction(tx, ctx));
        await bound.save(input);
        throw new Error("synthetic rollback");
      }),
    ).rejects.toThrow("synthetic rollback");
    expect(await repository.restore(ctx, input.conversationId, archive.sessionId)).toBeNull();
    await withProfileTransaction(db.db, ctx, async (tx) => {
      const bound = SqlPiArchiveDatabase.forTransaction(tx, ctx);
      await expect(bound.scoped(other, async () => null)).rejects.toThrow(
        "PI_ARCHIVE_SCOPE_MISMATCH",
      );
    });
    const first = await repository.save(input);
    expect(first.revision).toBe(1);
    expect((await repository.save(input)).revision).toBe(1);
    expect((await repository.restore(ctx, input.conversationId, archive.sessionId))?.status).toBe(
      "available",
    );
    expect(await repository.restore(other, input.conversationId, archive.sessionId)).toBeNull();
    await expect(sql.captureDependencies(other, [source.id])).rejects.toThrow(
      "PI_ARCHIVE_STALE_DEPENDENCY",
    );
    const changed = {
      ...archive,
      entries: [
        ...archive.entries,
        {
          type: "session_info" as const,
          id: "i1",
          parentId: null,
          timestamp: new Date().toISOString(),
          name: "new revision",
        },
      ],
    };
    await expect(repository.save({ ...input, archive: changed })).rejects.toThrow(
      "PI_ARCHIVE_STALE_REVISION",
    );
    expect(
      (await repository.save({ ...input, expectedRevision: 1, archive: changed })).revision,
    ).toBe(2);
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx
        .update(coreSchema.sourceItems)
        .set({
          sourceMeta: {
            reply_status: "replied",
            understanding_status: "pending",
            exploration_id: native.conversationId,
            reply: {
              engine: "pi",
              source_ids: [source.id],
              output: "synthetic reply",
              turn_id: native.piTurnId,
            },
          },
        })
        .where(eq(coreSchema.sourceItems.id, source.id));
    });
    expect(await sql.captureDependencies(ctx, [source.id])).toEqual(dependencies);
    expect((await repository.restore(ctx, input.conversationId, archive.sessionId))?.status).toBe(
      "available",
    );
    await withProfileTransaction(db.db, ctx, (tx) =>
      assertPiDependenciesCurrent(tx, ctx, dependencies),
    );
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx
        .update(coreSchema.sourceItems)
        .set({ content: "changed original" })
        .where(eq(coreSchema.sourceItems.id, source.id));
    });
    const stale = await repository.restore(ctx, input.conversationId, archive.sessionId);
    expect(stale?.status).toBe("rebuild_required");
    expect(stale?.revision).toBe(2);
    expect(stale?.dependencies).toEqual(dependencies);
    await expect(
      withProfileTransaction(db.db, ctx, (tx) =>
        assertPiDependenciesCurrent(tx, ctx, dependencies),
      ),
    ).rejects.toThrow("PI_ARCHIVE_STALE_DEPENDENCY");
    const refreshedDependencies = await sql.captureDependencies(ctx, [source.id]);
    expect(
      (
        await repository.save({
          ...input,
          dependencies: refreshedDependencies,
          expectedRevision: 2,
        })
      ).revision,
    ).toBe(3);
    await withProfileTransaction(db.db, ctx, async (tx) => {
      await tx
        .update(coreSchema.sourceItems)
        .set({ usageStatus: "excluded" })
        .where(eq(coreSchema.sourceItems.id, source.id));
      await invalidateCloudSources(tx, ctx, [source.id]);
    });
    expect((await repository.restore(ctx, input.conversationId, archive.sessionId))?.status).toBe(
      "rebuild_required",
    );
    await expect(repository.save(input)).rejects.toThrow("PI_ARCHIVE_STALE_DEPENDENCY");
    const rows = await withProfileTransaction(db.db, ctx, (tx) =>
      tx.select().from(coreSchema.piSessionArchives),
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.archive === null && row.status === "stale")).toBe(true);
    const afterInvalidation = await withProfileTransaction(db.db, ctx, async (tx) => ({
      turns: await tx.select().from(coreSchema.explorationTurns),
      conversations: await tx.select().from(coreSchema.explorations),
      operations: await tx.select().from(coreSchema.coreOperations),
      sources: await tx
        .select()
        .from(coreSchema.sourceItems)
        .where(eq(coreSchema.sourceItems.id, source.id)),
    }));
    expect(afterInvalidation.turns.find((t) => t.id === native.piTurnId)?.content).toBe("");
    expect(afterInvalidation.turns.some((t) => t.content === "legacy reply remains")).toBe(true);
    expect(afterInvalidation.turns.some((t) => t.content === "unrelated pi reply remains")).toBe(
      true,
    );
    expect(
      afterInvalidation.conversations.find((t) => t.id === native.conversationId)?.version,
    ).toBe(2);
    expect(afterInvalidation.conversations.find((t) => t.id === native.unaffectedId)?.version).toBe(
      1,
    );
    expect(afterInvalidation.sources[0]?.content).toBe("changed original");
    expect(afterInvalidation.sources[0]?.sourceMeta?.reply).toEqual({ redacted: true });
    expect(afterInvalidation.sources[0]?.sourceMeta?.reply_status).toBe("unavailable");
    const invalidatedOperation = afterInvalidation.operations.find(
      (op) => op.id === native.operationId,
    );
    expect(invalidatedOperation?.responseBody).toBeNull();
    expect(invalidatedOperation?.status).toBe("stale");
    expect(
      afterInvalidation.operations.find((op) => op.id === native.legacyOperationId)?.responseBody,
    ).toEqual({ reply: "legacy reply remains" });
  } finally {
    await Promise.all([db.sql.end(), identity.sql.end()]);
  }
});
