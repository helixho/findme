import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import type { FrameworkService } from "./service.js";

/** No Node dependency: caller supplies the existing host owner authorization. */
export function frameworkRoutes(
  service: FrameworkService,
  options: {
    authorize: (request: Request) => boolean | Promise<boolean>;
  },
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (!(await options.authorize(c.req.raw)))
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 56000,
      onError: (c) => c.json({ error: { code: "BODY_TOO_LARGE" } }, 413),
    }),
  );
  app.onError((e, c) => {
    const code =
      e instanceof ZodError || e instanceof SyntaxError
        ? "INVALID_INPUT"
        : /^[A-Z0-9_]+$/.test(e.message)
          ? e.message
          : "FRAMEWORK_INTEGRITY_ERROR";
    const status = ["RUN_NOT_FOUND", "DEFINITION_NOT_FOUND", "SOURCE_NOT_AVAILABLE"].includes(code)
      ? 404
      : [
            "DRAFT_DISABLED",
            "RETIRED",
            "USAGE_REVIEW_REQUIRED",
            "HISTORY_ADAPTATION_DISABLED",
            "OWNER_SCOPE_MISMATCH",
          ].includes(code)
        ? 403
        : [
              "STALE_RUN_VERSION",
              "IDEMPOTENCY_CONFLICT",
              "FRAMEWORK_BUSY",
              "BATCH_BUSY",
              "DEFINITION_DRIFT",
              "EXPLICIT_RECOVERY_REQUIRED",
              "SEMANTIC_REJECTION_REQUIRES_CHANGE",
              "GENERATION_OBSOLETE",
            ].includes(code)
          ? 409
          : 422;
    return c.json({ error: { code } }, status);
  });
  app.get("/definitions", async (c) => c.json(await service.catalog()));
  app.get("/definitions/:key/:version", (c) =>
    c.json(service.definition(c.req.param("key"), c.req.param("version"))),
  );
  app.post("/runs", async (c) =>
    c.json(await service.start(await c.req.json(), c.req.header("Idempotency-Key") ?? ""), 201),
  );
  app.get("/runs/:id", async (c) => c.json(await service.get(c.req.param("id"))));
  app.post("/runs/:id/respond", async (c) =>
    c.json(
      await service.respond(
        c.req.param("id"),
        await c.req.json(),
        c.req.header("Idempotency-Key") ?? "",
      ),
    ),
  );
  app.post("/runs/:id/continue", async (c) =>
    c.json(
      await service.continue(
        c.req.param("id"),
        await c.req.json(),
        c.req.header("Idempotency-Key") ?? "",
      ),
    ),
  );
  app.post("/runs/:id/pause", async (c) =>
    c.json(
      await service.pause(
        c.req.param("id"),
        await c.req.json(),
        c.req.header("Idempotency-Key") ?? "",
      ),
    ),
  );
  app.post("/runs/:id/amend", async (c) =>
    c.json(
      await service.amend(
        c.req.param("id"),
        await c.req.json(),
        c.req.header("Idempotency-Key") ?? "",
      ),
    ),
  );
  app.post("/runs/:id/abandon", async (c) =>
    c.json(
      await service.abandon(
        c.req.param("id"),
        await c.req.json(),
        c.req.header("Idempotency-Key") ?? "",
      ),
    ),
  );
  app.get("/runs/:id/evidence/:source", async (c) =>
    c.json(await service.evidence(c.req.param("id"), c.req.param("source"))),
  );
  return app;
}
