import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { coreSchema as c, createDb } from "@findme/db";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { ProfileService } from "../src/auth/profiles.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import { SqlPiArchiveDatabase } from "../src/personal-understanding/pi-archive.js";
import {
  SqlPiRequestRecords,
  piOutputCosts,
} from "../src/personal-understanding/pi-request-records.js";

it("distinguishes reported totals, component estimates, and unknown costs", () => {
  expect(
    piOutputCosts({
      usage: {
        cost: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.1,
          totalFromProvider: true,
        },
      },
    }),
  ).toEqual({ providerActualUsd: 0.1, estimatedCostUsd: 3 });
  expect(
    piOutputCosts({
      usage: { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } },
    }),
  ).toEqual({ providerActualUsd: null, estimatedCostUsd: 3 });
  expect(piOutputCosts({})).toEqual({ providerActualUsd: null, estimatedCostUsd: null });
});
it("records one request across preparation/send/completion and keeps unknown spend on failed attempts", async () => {
  const config = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const runtime = createDb(config.runtime_url);
  const identity = createDb(config.identity_url);
  try {
    const profiles = new ProfileService(identity.db);
    const ctx = await profiles.resolve({ provider: "request-ledger", principalId: randomUUID() });
    const other = await profiles.resolve({ provider: "request-ledger", principalId: randomUUID() });
    const fixture = await withProfileTransaction(runtime.db, ctx, async (tx) => {
      const [source] = await tx
        .insert(c.sourceItems)
        .values({ ...ctx, sourceKind: "native_event", authorKind: "subject", content: "synthetic" })
        .returning();
      if (!source) throw Error("fixture");
      await tx.insert(c.sourceAssessments).values({
        sourceItemId: source.id,
        version: 1,
        attributionStatus: "confirmed_subject",
        contextCompleteness: "sufficient",
        temporalPrecision: "unknown",
        eligibility: "eligible",
        rationale: "synthetic",
      });
      const [op] = await tx
        .insert(c.coreOperations)
        .values({
          ...ctx,
          idempotencyKey: randomUUID(),
          operationType: "exploration_reply",
          requestHash: "synthetic",
          status: "processing",
        })
        .returning();
      if (!op) throw Error("fixture");
      return { source, op };
    });
    const deps = await new SqlPiArchiveDatabase(runtime.db).captureDependencies(ctx, [
      fixture.source.id,
    ]);
    const ledger = new SqlPiRequestRecords(runtime.db);
    const op = fixture.op.id;
    const conv = randomUUID();
    await ledger.record(ctx, op, conv, { sequence: 1, input: { messages: ["synthetic"] } }, deps);
    expect((await ledger.usage(ctx, op)).providerActualUsd).toBeNull();
    await ledger.record(
      ctx,
      op,
      conv,
      { sequence: 1, payload: { model: "synthetic" }, reservedUsd: 0.05 },
      deps,
    );
    await ledger.record(
      ctx,
      op,
      conv,
      {
        sequence: 1,
        output: {
          usage: {
            cost: {
              input: 0.01,
              output: 0.02,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.001,
              totalFromProvider: true,
            },
          },
        },
      },
      deps,
    );
    expect(await ledger.usage(ctx, op)).toMatchObject({
      requests: 1,
      reservedUsd: 0.05,
      providerActualUsd: 0.001,
      unknownActualRequests: 0,
    });
    expect(
      await withProfileTransaction(runtime.db, ctx, (tx) => tx.select().from(c.piRequestRecords)),
    ).toHaveLength(1);
    expect((await ledger.usage(other, op)).requests).toBe(0);
    const retry = new SqlPiRequestRecords(runtime.db);
    await retry.record(ctx, op, conv, { sequence: 1, input: { messages: ["retry"] } }, deps);
    await retry.record(
      ctx,
      op,
      conv,
      { sequence: 1, payload: { model: "synthetic" }, reservedUsd: 0.05 },
      deps,
    );
    expect(await retry.usage(ctx, op)).toMatchObject({
      requests: 2,
      reservedUsd: 0.1,
      providerActualUsd: null,
      knownProviderActualUsd: 0.001,
      unknownActualRequests: 1,
    });
    await withProfileTransaction(runtime.db, ctx, (tx) =>
      tx
        .update(c.piRequestRecords)
        .set({ status: "stale", piInput: null, providerPayload: null, output: null })
        .where(eq(c.piRequestRecords.operationId, op)),
    );
    await expect(
      retry.record(
        ctx,
        op,
        conv,
        {
          sequence: 1,
          output: {
            content: "must not return",
            usage: { cost: { total: 0.002, totalFromProvider: true } },
          },
        },
        deps,
      ),
    ).rejects.toThrow("PI_ARCHIVE_STALE_DEPENDENCY");
    expect(await retry.usage(ctx, op)).toMatchObject({
      providerActualUsd: 0.003,
      unknownActualRequests: 0,
    });
    const redacted = await withProfileTransaction(runtime.db, ctx, (tx) =>
      tx.select().from(c.piRequestRecords),
    );
    expect(
      redacted.every(
        (row) => row.output === null && row.piInput === null && row.providerPayload === null,
      ),
    ).toBe(true);
  } finally {
    await Promise.all([runtime.sql.end(), identity.sql.end()]);
  }
});
