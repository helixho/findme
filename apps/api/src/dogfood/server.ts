import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { z } from "zod";
import { type DogfoodEngine, type GenerateOptions, batchView } from "./engine.js";
import { DogfoodError, FeedbackInput, hash, qualified } from "./model.js";
import type { BatchStore } from "./store.js";

const GenerateInput = z
  .object({
    operation: z.enum(["extract", "synthesize", "compare"]),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(1).max(160),
    maxCalls: z.number().int().min(1).max(4).default(1),
    session: z.string().max(160).optional(),
    limit: z.number().int().min(1).max(24).optional(),
    retryFailed: z.boolean().optional(),
  })
  .strict();
export function createDogfoodApp(options: {
  store: BatchStore;
  port: number;
  appDist?: string;
  engine: () => DogfoodEngine;
}) {
  const app = new Hono();
  const origin = `http://127.0.0.1:${options.port}`;
  const host = `127.0.0.1:${options.port}`;
  const nonce = randomBytes(32).toString("hex");
  app.use("*", async (c, next) => {
    if (c.req.header("host") !== host) return c.json({ error: "HOST_REJECTED" }, 403);
    const requestOrigin = c.req.header("origin");
    if (requestOrigin && requestOrigin !== origin) return c.json({ error: "ORIGIN_REJECTED" }, 403);
    if (!["GET", "HEAD"].includes(c.req.method)) {
      const provided = c.req.header("x-dogfood-nonce") ?? "";
      if (
        requestOrigin !== origin ||
        Buffer.byteLength(provided) !== Buffer.byteLength(nonce) ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(nonce))
      )
        return c.json({ error: "SESSION_REQUIRED" }, 403);
      if (!c.req.header("content-type")?.startsWith("application/json"))
        return c.json({ error: "JSON_REQUIRED" }, 415);
      if (Number(c.req.header("content-length") ?? 0) > 32000)
        return c.json({ error: "REQUEST_TOO_LARGE" }, 413);
    }
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    await next();
  });
  const view = async () => ({ nonce, ...batchView(await options.store.load()) });
  async function body(request: Request): Promise<unknown> {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > 32000) throw new DogfoodError("REQUEST_TOO_LARGE");
    try {
      return JSON.parse(text);
    } catch {
      throw new DogfoodError("INVALID_JSON");
    }
  }
  app.get("/api/dogfood/state", async (c) => c.json(await view()));
  app.post("/api/dogfood/review", async (c) => {
    await options.store.review(FeedbackInput.parse(await body(c.req.raw)));
    return c.json(await view());
  });
  app.post("/api/dogfood/generate", async (c) => {
    const input = GenerateInput.parse(await body(c.req.raw));
    const generation = await options.engine().generate({ ...input, live: true } as GenerateOptions);
    return c.json({ ...(await view()), generation });
  });
  app.get("/api/dogfood/export", async (c) => c.json(await reviewedPackage(options.store)));
  app.all("/api/*", (c) => c.json({ error: "NOT_FOUND" }, 404));
  const appDist = options.appDist;
  if (appDist) {
    app.use("/assets/*", serveStatic({ root: appDist }));
    app.get("/dogfood", async (c) =>
      c.html(await readFile(path.join(appDist, "index.html"), "utf8")),
    );
    app.get("/", (c) => c.redirect("/dogfood"));
  }
  app.onError((error, c) => {
    const code =
      error instanceof DogfoodError
        ? error.code
        : error instanceof z.ZodError
          ? "INVALID_REQUEST"
          : "WORKBENCH_FAILED";
    return c.json({ error: code }, code === "STALE_VERSION" ? 409 : 400);
  });
  return app;
}
export async function metadata(store: BatchStore) {
  const batch = await store.load();
  const view = batchView(batch);
  return {
    format: batch.manifest.format,
    version: batch.state.version,
    sessions: batch.manifest.sessions.length,
    dev: batch.manifest.sessions.filter((s) => s.split === "dev").length,
    holdout: view.holdoutCount,
    sources: batch.sources.length,
    candidates: batch.state.candidates.length,
    adopted: batch.state.candidates.filter((c) => c.status === "adopted").length,
    excluded: batch.state.candidates.filter((c) => c.status === "excluded").length,
    claims: batch.state.claims.length,
    reviewedClaims: batch.state.claims.filter((c) => c.status === "reviewed").length,
    pendingChunks: view.sources.flatMap((s) => s.processing).filter((p) => p.status !== "completed")
      .length,
    requests: batch.state.usage.attempts.length,
    reservedInput: batch.state.usage.reservedInput,
    independence: "unknown",
    holdoutValidation: "pending",
    ownerReview: "pending",
    shortage: batch.manifest.sampling?.shortage ?? null,
  };
}
export async function reviewedPackage(store: BatchStore) {
  const batch = await store.load();
  const claims = batch.state.claims.filter((c) => c.status === "reviewed");
  const dependencies = new Set(claims.flatMap((c) => [...c.evidence, ...c.counterevidence]));
  const evidence = batch.state.candidates.filter(
    (c) => c.status === "adopted" || dependencies.has(c.id),
  );
  const sourceIds = new Set([...evidence.map((c) => c.sourceId), ...dependencies]);
  return {
    format: "findme-reviewed-candidate-package@1",
    publication: "staging_only",
    officialCorePublished: false,
    batchId: batch.manifest.id,
    batchVersion: batch.state.version,
    sourceFingerprint: batch.manifest.sourceFingerprint,
    rawFingerprint: batch.state.rawFingerprint,
    manifestFingerprint: batch.state.manifestFingerprint,
    independence: "unknown",
    holdoutValidation: "pending",
    evidence: evidence.map((c) => ({
      ...c,
      eligibility: qualified(batch.state, c) ? "eligible" : "context_only",
      sourceReview: batch.state.sourceReviews[c.sourceId] ?? null,
    })),
    sources: batch.sources.filter((s) => s.split === "dev" && sourceIds.has(s.id)),
    claims,
    feedback: batch.state.feedback,
    lineage: batch.state.runs.map((r) => ({
      id: r.id,
      status: r.status,
      fingerprint: r.fingerprint,
      model: r.model,
      policy: r.policy,
      prompt: r.prompt,
      validator: r.validator,
      sourceIds: r.sourceIds,
      evidenceIds: r.evidenceIds ?? [],
      thinkingMode: r.thinkingMode ?? null,
      coverage: r.coverage ?? [],
      comparisonScope: r.comparisonScope ?? null,
      payloadFingerprint: r.payloadFingerprint ?? null,
      retryOf: r.retryOf ?? null,
    })),
  };
}
export async function exportPackage(store: BatchStore, destination: string) {
  const result = await reviewedPackage(store);
  try {
    await writeFile(destination, JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
  } catch {
    throw new DogfoodError("EXPORT_EXISTS_OR_UNAVAILABLE");
  }
  return {
    publication: "staging_only",
    claims: result.claims.length,
    evidence: result.evidence.length,
    fingerprint: hash(result),
  };
}
