import type { Db } from "@findme/db";
import { sql } from "drizzle-orm";
import type { CloudProcessingService } from "../cloud-diagnostic/processing.js";
import { withProfileTransaction } from "../cloud-diagnostic/scope.js";

/** The existing jobs table is the queue. No in-memory enqueue is authoritative. */
export function startLocalWorker(options: {
  db: Db;
  identityDb: Db;
  processing: Pick<CloudProcessingService, "resume" | "consume">;
  enabled: boolean;
  intervalMs?: number;
}) {
  let stopping = false;
  let lastPoll = 0;
  let active = false;
  let pending: Promise<void> | undefined;
  async function poll() {
    if (pending || stopping) return;
    pending = (async () => {
      try {
        const scopes = await options.identityDb.execute<{ tenant_id: string; subject_id: string }>(
          sql`select distinct tenant_id,subject_id from profile_memberships where status='active'`,
        );
        lastPoll = Date.now();
        if (!options.enabled) return;
        for (const scope of scopes) {
          if (stopping) break;
          const ctx = { tenantId: scope.tenant_id, subjectId: scope.subject_id };
          const jobs = await withProfileTransaction(options.db, ctx, (tx) =>
            tx.execute<{ id: string; status: string; call_cap: number }>(sql`
              select id,status,call_cap from cloud_diagnostic_jobs
              where tenant_id=${ctx.tenantId} and subject_id=${ctx.subjectId}
                and (status='queued' or (status='running' and lease_until < now()))
              order by created_at limit 1
            `),
          );
          for (const job of jobs) {
            active = true;
            try {
              // Preserve the original confirmed budget; never auto-retry failed/rejected jobs.
              if (job.status === "running")
                await options.processing.resume(ctx, job.id, { provider_call_cap: job.call_cap });
              await options.processing.consume({
                type: "cloud_diagnostic",
                job_id: job.id,
                tenant_id: ctx.tenantId,
                subject_id: ctx.subjectId,
              });
            } catch {
              console.error("[local worker] job deferred; inspect its persisted status");
            } finally {
              active = false;
              lastPoll = Date.now();
            }
          }
        }
      } catch {
        console.error("[local worker] database poll failed");
      }
    })();
    try {
      await pending;
    } finally {
      pending = undefined;
    }
  }
  const timer = setInterval(() => void poll(), options.intervalMs ?? 15000);
  timer.unref();
  void poll();
  return {
    wake: async () => {
      void poll();
    },
    healthy: () => active || Date.now() - lastPoll < 60000,
    state: () => ({ active, lastPoll, inferenceEnabled: options.enabled }),
    async stop() {
      stopping = true;
      clearInterval(timer);
      await pending;
    },
  };
}
