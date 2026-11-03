import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDb, diagnosticSchema, platformSchema } from "@findme/db";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { ProfileService } from "../src/auth/profiles.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import { startLocalWorker } from "../src/standalone/worker.js";

it("discovers durable jobs after restart through restricted roles, preserving caps and failed jobs", async () => {
  const config = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const admin = createDb(process.env.DATABASE_URL_TEST!);
  const runtime = createDb(config.runtime_url);
  const identity = createDb(config.identity_url);
  const resumed: number[] = [];
  let worker: ReturnType<typeof startLocalWorker> | undefined;
  try {
    const principal = { provider: "standalone-test", principalId: randomUUID() };
    const scope = await new ProfileService(identity.db).resolve(principal);
    const run = randomUUID();
    await admin.db.insert(diagnosticSchema.diagnosticRuns).values({
      id: run,
      ...scope,
      domain: "test",
      question: "synthetic",
      idempotencyKey: run,
      requestHash: run,
    });
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [i, id] of ids.entries())
      await admin.db.insert(platformSchema.cloudJobs).values({
        id,
        ...scope,
        runId: run,
        basisVersion: 1,
        fingerprint: id,
        model: "test",
        input: {},
        status: ["queued", "running", "failed"][i],
        callCap: 4,
        callsUsed: i === 1 ? 1 : 0,
        leaseUntil: i === 1 ? new Date(0) : null,
      });
    const processing = {
      async resume(ctx: typeof scope, id: string, raw: unknown) {
        const cap = (raw as { provider_call_cap: number }).provider_call_cap;
        resumed.push(cap);
        await withProfileTransaction(runtime.db, ctx, (tx) =>
          tx.execute(sql`update cloud_diagnostic_jobs set status='queued' where id=${id}`),
        );
        return {} as never;
      },
      async consume(message: { job_id: string; tenant_id: string; subject_id: string }) {
        await withProfileTransaction(
          runtime.db,
          { tenantId: message.tenant_id, subjectId: message.subject_id },
          (tx) =>
            tx.execute(
              sql`update cloud_diagnostic_jobs set status='completed',lease_until=null where id=${message.job_id}`,
            ),
        );
      },
    };
    // Start/stop the scheduler first: queue ownership is the database, not this process.
    worker = startLocalWorker({
      db: runtime.db,
      identityDb: identity.db,
      processing,
      enabled: false,
      intervalMs: 20,
    });
    await expect.poll(() => worker!.healthy()).toBe(true);
    await worker.stop();
    worker = startLocalWorker({
      db: runtime.db,
      identityDb: identity.db,
      processing,
      enabled: true,
      intervalMs: 20,
    });
    await expect
      .poll(async () => {
        const rows =
          await admin.sql`select status from cloud_diagnostic_jobs where id in (${ids[0]},${ids[1]})`;
        return rows.every((r) => r.status === "completed");
      })
      .toBe(true);
    expect(resumed).toEqual([4]);
    expect(
      (await admin.sql`select status from cloud_diagnostic_jobs where id=${ids[2]}`)[0].status,
    ).toBe("failed");
  } finally {
    await worker?.stop();
    await Promise.all([admin.sql.end(), runtime.sql.end(), identity.sql.end()]);
  }
});
