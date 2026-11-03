import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { createCodexGateway } from "../llm/codex-cli.js";
import {
  type GatewayAttemptInfo,
  type GatewayAttemptResult,
  GatewayRequestError,
} from "../llm/gateway.js";
import { fail } from "../shared/primitives.js";
import type { FeedbackState } from "./state.js";

type Gateway = Pick<ReturnType<typeof createCodexGateway>, "extract">;
type Update = <T>(fn: (s: FeedbackState) => Promise<T> | T) => Promise<T>;
/** Reservation precedes the call, including gateways without observer support. */
export async function providerAttempt<T>(opts: {
  gateway: Gateway;
  update: Update;
  budget: number;
  job: string;
  phase: FeedbackState["attempts"][number]["phase"];
  timeoutMs: number;
  system: string;
  text: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
}) {
  const id = randomUUID();
  await opts.update((s) => {
    if (s.calls_reserved >= opts.budget) fail("FEEDBACK_BUDGET_EXHAUSTED");
    s.calls_reserved++;
    s.attempts.push({
      id,
      job_id: opts.job,
      phase: opts.phase,
      route: "extraction_model",
      model: null,
      reserved_at: new Date().toISOString(),
      completed_at: null,
      status: "reserved",
      usage: null,
      raw: null,
      error: null,
    });
  });
  let open = true;
  let observed = false;
  let outcome: GatewayAttemptResult | null = null;
  const update = (fn: (a: FeedbackState["attempts"][number]) => void) =>
    !open
      ? Promise.resolve()
      : opts.update((s) => {
          const a = s.attempts.find((a) => a.id === id);
          if (
            open &&
            a?.status === "reserved" &&
            s.revisions.some((r) => r.id === opts.job && r.status === "processing")
          )
            fn(a);
        });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let error: string | null = null;
  try {
    const result = await Promise.race([
      opts.gateway.extract({
        route: "extraction_model",
        system: opts.system,
        text: opts.text,
        schema: opts.schema,
        controls: {
          retries: 0,
          timeoutMs: opts.timeoutMs,
          maxOutputTokens: 5200,
          captureRawOutput: (raw) =>
            update((a) => {
              a.raw = raw;
            }),
          observer: {
            beforeAttempt: async (info: GatewayAttemptInfo) => {
              if (!open || observed) fail("PROVIDER_EXTRA_ATTEMPT_BLOCKED");
              observed = true;
              await update((a) => {
                a.model = info.model;
                a.route = info.route;
              });
              if (!open) fail("PROVIDER_ATTEMPT_CLOSED");
            },
            afterAttempt: async (info) => {
              await update((a) => {
                outcome = info;
                a.usage = info.usage;
              });
            },
          },
        },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          open = false;
          reject(new Error("PROVIDER_TIMEOUT"));
        }, opts.timeoutMs);
      }),
    ]);
    return result;
  } catch (e) {
    error =
      e instanceof GatewayRequestError
        ? `PROVIDER_${e.kind.toUpperCase()}`
        : e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
          ? e.message
          : "PROVIDER_FAILED";
    throw new Error(error);
  } finally {
    open = false;
    if (timer) clearTimeout(timer);
    await opts.update((s) => {
      const a = s.attempts.find((a) => a.id === id);
      if (!a || a.status !== "reserved") return;
      a.status = error ? "error" : "ok";
      a.error = error ?? (outcome as GatewayAttemptResult | null)?.errorKind ?? null;
      a.completed_at = new Date().toISOString();
    });
  }
}
