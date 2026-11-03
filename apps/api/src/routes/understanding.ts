import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { PersonalContext } from "../core/exploration-service.js";
import {
  type CoreReportBackend,
  type NativeReportService,
  rebindCoreReportSource,
} from "../core/report-bridge.js";

/** Injected backend only: safe to import from Worker; no Node repository imports. */
export function nativeUnderstandingRoutes(
  service: NativeReportService,
  contextFor: (c: Context) => Promise<PersonalContext>,
  backend?: CoreReportBackend,
) {
  const app = new Hono();
  app.use(
    "*",
    bodyLimit({
      maxSize: 12000,
      onError: (c) => c.json({ error: { code: "BODY_TOO_LARGE" } }, 413),
    }),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/", async (c) => {
    const view = await service.read(await contextFor(c));
    return c.json({ ...view, capabilities: { ...view.capabilities, native_core: "available" } });
  });
  app.get("/history", async (c) =>
    c.json(
      await service.history(
        await contextFor(c),
        c.req.query("domain") ?? "",
        Number(c.req.query("limit") ?? 30),
      ),
    ),
  );
  app.get("/version", async (c) =>
    c.json(
      await service.version(
        await contextFor(c),
        c.req.query("domain") ?? "",
        c.req.query("version") ?? "",
      ),
    ),
  );
  app.post("/sources/retire", async (c) =>
    c.json(await service.retireSource(await contextFor(c), await c.req.json())),
  );
  app.post("/sources/rebind", async (c) => {
    const ctx = await contextFor(c);
    if (!backend) return c.json({ error: { code: "SOURCE_REBIND_UNAVAILABLE" } }, 403);
    return c.json(await rebindCoreReportSource(backend, service, ctx, await c.req.json()));
  });
  app.post("/topics/recover", async (c) => {
    const body = await c.req.json();
    return c.json(
      await service.recoverTopic(
        await contextFor(c),
        body.domain,
        body.version,
        body.recovery ?? {},
      ),
    );
  });
  app.get("/evidence/batch", async (c) =>
    c.json(
      await service.evidences(
        await contextFor(c),
        c.req.query("domain") ?? "",
        c.req.query("version") ?? "",
        c.req.queries("id") ?? [],
      ),
    ),
  );
  app.get("/evidence", async (c) =>
    c.json(
      (
        await service.evidences(
          await contextFor(c),
          c.req.query("domain") ?? "",
          c.req.query("version") ?? "",
          [c.req.query("id") ?? ""],
        )
      )[0],
    ),
  );
  app.post("/feedback", async (c) =>
    c.json(
      await service.save(
        await contextFor(c),
        await c.req.json(),
        c.req.header("Idempotency-Key") ?? "",
      ),
      201,
    ),
  );
  app.post("/feedback/:id/process", async (c) => {
    const text = await c.req.text();
    let recovery: unknown = {};
    if (text.trim()) {
      try {
        recovery = JSON.parse(text);
      } catch {
        return c.json({ error: { code: "INVALID_JSON" } }, 400);
      }
    }
    return c.json(await service.process(await contextFor(c), c.req.param("id"), recovery));
  });
  app.post("/overall/process", async (c) => {
    const body = await c.req.json();
    return c.json(
      await service.processOverall(await contextFor(c), body.request, body.recovery ?? {}),
    );
  });
  return app;
}
