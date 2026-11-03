import { CloudDiagnosticCreate, CloudDiagnosticResponse } from "@findme/core";
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { CloudProcessingService } from "../cloud-diagnostic/processing.js";
import type { CloudDiagnosticRepository } from "../cloud-diagnostic/repository.js";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";

/** Account-only persistent endpoints. Reads and response saves never enqueue inference. */
export function cloudDiagnosticRoutes(
  repository: CloudDiagnosticRepository,
  contextFor: (c: Context) => Promise<PersonalContext>,
  processing?: CloudProcessingService,
) {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 64 * 1024 }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  const id = zValidator("param", z.object({ id: z.string().uuid() }));
  const key = (c: Context) => {
    const value = c.req.header("Idempotency-Key");
    if (!value || value.length > 200)
      throw new CoreError("IDEMPOTENCY_KEY_REQUIRED", 400, "需要 Idempotency-Key");
    return value;
  };
  app.get("/capabilities", (c) =>
    c.json({
      account_scoped: true,
      response_save: true,
      ...(processing?.capabilities() ?? {
        storage: "postgres",
        inference_enabled: false,
        accepted_publication: false,
      }),
    }),
  );
  app.get(
    "/",
    zValidator(
      "query",
      z.object({
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
    ),
    async (c) => c.json(await repository.list(await contextFor(c), c.req.valid("query").limit)),
  );
  app.post("/", zValidator("json", CloudDiagnosticCreate), async (c) =>
    c.json(await repository.create(await contextFor(c), c.req.valid("json"), key(c)), 201),
  );
  app.get("/:id", id, async (c) =>
    c.json(await repository.read(await contextFor(c), c.req.valid("param").id)),
  );
  app.get(
    "/:id/evidence",
    id,
    zValidator(
      "query",
      z.object({
        evidence_id: z.string().min(1).max(200),
      }),
    ),
    async (c) =>
      c.json(
        await repository.evidence(
          await contextFor(c),
          c.req.valid("param").id,
          c.req.valid("query").evidence_id,
        ),
      ),
  );
  app.post("/:id/responses", id, zValidator("json", CloudDiagnosticResponse), async (c) =>
    c.json(
      await repository.respond(
        await contextFor(c),
        c.req.valid("param").id,
        c.req.valid("json"),
        key(c),
      ),
      201,
    ),
  );
  app.get("/:id/history", id, async (c) =>
    c.json(await repository.history(await contextFor(c), c.req.valid("param").id)),
  );
  app.get("/:id/history/:version", async (c) =>
    c.json(
      await repository.version(
        await contextFor(c),
        z.string().uuid().parse(c.req.param("id")),
        z.coerce.number().int().positive().parse(c.req.param("version")),
      ),
    ),
  );
  app.get("/:id/responses", id, async (c) =>
    c.json(await repository.responses(await contextFor(c), c.req.valid("param").id)),
  );
  if (processing) {
    app.post("/:id/process/plan", id, async (c) =>
      c.json(
        await processing.plan(await contextFor(c), c.req.valid("param").id, await c.req.json()),
      ),
    );
    app.post("/:id/process", id, async (c) =>
      c.json(
        await processing.enqueue(await contextFor(c), c.req.valid("param").id, await c.req.json()),
        202,
      ),
    );
    app.get("/:id/jobs", id, async (c) =>
      c.json(await processing.jobs(await contextFor(c), c.req.valid("param").id)),
    );
    app.get("/jobs/:id", id, async (c) =>
      c.json(await processing.get(await contextFor(c), c.req.valid("param").id)),
    );
    app.post("/jobs/:id/resume", id, async (c) =>
      c.json(
        await processing.resume(await contextFor(c), c.req.valid("param").id, await c.req.json()),
        202,
      ),
    );
    app.post("/jobs/:id/cancel", id, async (c) =>
      c.json(await processing.cancel(await contextFor(c), c.req.valid("param").id)),
    );
  }
  return app;
}
