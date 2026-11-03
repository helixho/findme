import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { GatewayRequestError, type createGateway } from "../llm/gateway.js";
import type { FrameworkRepository } from "./schema.js";
export type FrameworkGateway = Pick<ReturnType<typeof createGateway>, "extract">;
export async function frameworkAttempt<T>(opts: {
  repository: FrameworkRepository;
  gateway: FrameworkGateway;
  job: string;
  execution: string;
  phase: "generation" | "audit";
  timeoutMs: number;
  system: string;
  text: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
}) {
  const id = randomUUID();
  await opts.repository.update((s) => {
    const job = s.jobs.find(
      (j) => j.id === opts.job && j.execution === opts.execution && j.status === "processing",
    );
    if (!job || job.calls_remaining < 1) throw new Error("ATTEMPT_RESERVATION_MISSING");
    job.calls_remaining--;
    s.u4_calls_reserved++;
    s.attempts.push({
      id,
      job_id: job.id,
      execution: opts.execution,
      phase: opts.phase,
      route: "extraction_model",
      model: null,
      reserved_at: new Date().toISOString(),
      completed_at: null,
      status: "reserved",
      usage: null,
      estimate: null,
      raw: null,
      error: null,
    });
  });
  const record = (
    fn: (a: Awaited<ReturnType<FrameworkRepository["read"]>>["attempts"][number]) => void,
  ) =>
    opts.repository.update((s) => {
      const a = s.attempts.find((a) => a.id === id);
      if (a) fn(a);
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observed = false;
  let closed = false;
  let error: string | null = null;
  try {
    const output = await Promise.race([
      opts.gateway.extract({
        route: "extraction_model",
        text: opts.text,
        system: opts.system,
        schema: opts.schema,
        controls: {
          retries: 0,
          timeoutMs: opts.timeoutMs,
          maxOutputTokens: 6500,
          captureRawOutput: (raw) =>
            record((a) => {
              a.raw = raw;
            }),
          observer: {
            beforeAttempt: async (info) => {
              if (closed || observed) throw new Error("EXTRA_PROVIDER_ATTEMPT_BLOCKED");
              observed = true;
              await record((a) => {
                a.route = info.route;
                a.model = info.model;
                a.estimate = { ...info.estimate };
              });
            },
            afterAttempt: (info) =>
              record((a) => {
                a.usage = info.usage ? { ...info.usage } : null;
              }),
          },
        },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          closed = true;
          reject(new Error("PROVIDER_TIMEOUT"));
        }, opts.timeoutMs);
      }),
    ]);
    const parsed = opts.schema.parse(output);
    await record((a) => {
      a.parsed = parsed;
    });
    return parsed;
  } catch (e) {
    error =
      e instanceof GatewayRequestError
        ? `PROVIDER_${e.kind.toUpperCase()}`
        : e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
          ? e.message
          : "PROVIDER_FAILED";
    throw new Error(error);
  } finally {
    closed = true;
    if (timer) clearTimeout(timer);
    await record((a) => {
      a.completed_at = new Date().toISOString();
      a.status = error ? "error" : "ok";
      a.error = error;
    });
  }
}
