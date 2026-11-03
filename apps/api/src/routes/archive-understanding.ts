import { type Context, Hono } from "hono";
import type { PersonalContext } from "../core/exploration-service.js";
import type { ArchiveUnderstandingRuntime } from "../understanding-app/archive-runtime.js";

/** Existing parent middleware authenticates every request before this private reader runs. */
export function archiveUnderstandingRoutes(
  runtime: ArchiveUnderstandingRuntime,
  contextFor: (c: Context) => Promise<PersonalContext>,
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((e, c) =>
    c.json(
      { error: { code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : "ARCHIVE_READ_FAILED" } },
      422,
    ),
  );
  app.get("/", async (c) => c.json(await runtime.read(await contextFor(c))));
  app.get("/history", async (c) =>
    c.json(
      await runtime.history(
        await contextFor(c),
        c.req.query("domain") ?? "",
        Number(c.req.query("limit") ?? 30),
      ),
    ),
  );
  app.get("/version", async (c) =>
    c.json(
      await runtime.version(
        await contextFor(c),
        c.req.query("domain") ?? "",
        c.req.query("version") ?? "",
      ),
    ),
  );
  app.get("/evidence/batch", async (c) =>
    c.json(
      await runtime.evidences(
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
        await runtime.evidences(
          await contextFor(c),
          c.req.query("domain") ?? "",
          c.req.query("version") ?? "",
          [c.req.query("id") ?? ""],
        )
      )[0],
    ),
  );
  // Never silently discard a response or claim this snapshot reader processes/publishes reports.
  app.post("/*", (c) => c.json({ error: { code: "ARCHIVE_READ_ONLY" } }, 403));
  return app;
}
