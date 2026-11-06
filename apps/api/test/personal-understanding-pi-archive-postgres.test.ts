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
    const dependencies = await sql.captureDependencies(ctx, [source.id]);
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
    const input = {
      scope: ctx,
      conversationId: randomUUID(),
      expectedRevision: 0,
      dependencies,
      archive,
    };
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
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.archive === null && row.status === "stale")).toBe(true);
  } finally {
    await Promise.all([db.sql.end(), identity.sql.end()]);
  }
});
