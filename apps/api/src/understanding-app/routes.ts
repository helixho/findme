import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { PrivateUnderstandingRepository } from "./repository.js";

export function understandingRoutes(
  repository: PrivateUnderstandingRepository,
  token: string,
  frameworkStatus?: () => Promise<
    "not_run" | "in_progress" | "needs_review" | "completed" | "abandoned"
  >,
) {
  if (!token.trim()) throw new Error("OWNER_TOKEN_REQUIRED");
  const app = new Hono();
  app.use("*", async (c, next) => {
    const actual = Buffer.from(c.req.header("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 12000,
      onError: (c) => c.json({ error: { code: "BODY_TOO_LARGE" } }, 413),
    }),
  );
  app.onError((err, c) => {
    const code = /^[A-Z0-9_]+$/.test(err.message) ? err.message : "UNDERSTANDING_INTEGRITY_ERROR";
    const status =
      code === "FEEDBACK_PROCESSING_DISABLED"
        ? 403
        : [
              "STALE_REPORT_VERSION",
              "STALE_SOURCE_LIFECYCLE",
              "SOURCE_LIFECYCLE_CONFLICT",
              "IDEMPOTENCY_CONFLICT",
              "REVISION_SOURCE_RACE",
              "STALE_OVERALL_DEPENDENCY",
              "STALE_EXPLORATION_CONTEXT",
              "FEEDBACK_PROCESSING_BUSY",
              "EXPLICIT_RECOVERY_REQUIRED",
              "SEMANTIC_REJECTION_REQUIRES_CHANGE",
              "FEEDBACK_NOT_PENDING",
            ].includes(code)
          ? 409
          : [
                "IDEMPOTENCY_KEY_REQUIRED",
                "FINDING_NOT_FOUND",
                "FEEDBACK_NOT_PROCESSABLE",
                "OVERALL_REEVALUATION_PENDING",
              ].includes(code)
            ? 400
            : 422;
    return c.json({ error: { code } }, status);
  });
  app.get("/", async (c) => {
    const view = await repository.read();
    const human3 = frameworkStatus ? await frameworkStatus() : view.frameworks.human_3;
    return c.json({ ...view, frameworks: { ...view.frameworks, human_3: human3 } });
  });
  app.get("/history", async (c) =>
    c.json(
      await repository.history(c.req.query("domain") ?? "", Number(c.req.query("limit") ?? 30)),
    ),
  );
  app.get("/version", async (c) =>
    c.json(await repository.version(c.req.query("domain") ?? "", c.req.query("version") ?? "")),
  );
  app.post("/sources/retire", async (c) =>
    c.json(await repository.retireSource(await c.req.json())),
  );
  // A private host has no authenticated Core source-fetch bridge. Client supplied text is never trusted.
  app.post("/sources/rebind", (c) => c.json({ error: { code: "SOURCE_REBIND_UNAVAILABLE" } }, 403));
  app.post("/topics/recover", async (c) => {
    const body = await c.req.json();
    return c.json(await repository.recoverTopic(body.domain, body.version, body.recovery ?? {}));
  });
  app.get("/evidence/batch", async (c) =>
    c.json(
      await repository.evidences(
        c.req.query("domain") ?? "",
        c.req.query("version") ?? "",
        c.req.queries("id") ?? [],
      ),
    ),
  );
  app.get("/evidence", async (c) =>
    c.json(
      await repository.evidence(
        c.req.query("domain") ?? "",
        c.req.query("version") ?? "",
        c.req.query("id") ?? "",
      ),
    ),
  );
  app.post("/feedback", async (c) =>
    c.json(await repository.save(await c.req.json(), c.req.header("Idempotency-Key") ?? ""), 201),
  );
  // Explicit invocation only. Client cannot choose or increase the server's budget.
  app.post("/feedback/:id/process", async (c) => {
    const raw = await c.req.text();
    return c.json(await repository.process(c.req.param("id"), raw.trim() ? JSON.parse(raw) : {}));
  });
  app.post("/overall/process", async (c) => {
    const body = await c.req.json();
    return c.json(await repository.processOverall(body.request, body.recovery ?? {}));
  });
  return app;
}
