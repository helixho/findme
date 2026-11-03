import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  prepareEvidencePacketImport,
  prepareExportRestore,
} from "../cloud-diagnostic/ingest-adapter.js";
import type { CloudServices } from "../cloud-diagnostic/runtime.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { frameworkRoutes } from "../framework-runtime/routes.js";
import type { PrincipalResolver } from "./core.js";
const id = (c: Context) => z.string().uuid().parse(c.req.param("id"));
const key = (c: Context) =>
  z.string().trim().min(1).max(200).parse(c.req.header("Idempotency-Key"));
export function cloudProfileRoutes(services: CloudServices, principal: PrincipalResolver) {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 16000 }));
  app.get("/", async (c) => c.json(await services.profiles.list(await principal(c))));
  app.post("/", async (c) => {
    const body = z
      .object({ name: z.string() })
      .strict()
      .parse(await c.req.json());
    return c.json(await services.profiles.create(await principal(c), body.name, key(c)), 201);
  });
  app.patch("/:id", async (c) =>
    c.json(await services.profiles.update(await principal(c), id(c), await c.req.json())),
  );
  return app;
}
export function cloudDataRoutes(
  services: CloudServices,
  contextFor: (c: Context) => Promise<PersonalContext>,
) {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.get("/sources", async (c) =>
    c.json(
      await services.lifecycle.sources(await contextFor(c), Number(c.req.query("cursor") ?? 0)),
    ),
  );
  app.post("/sources/:id/actions", async (c) =>
    c.json(await services.lifecycle.act(await contextFor(c), id(c), await c.req.json(), key(c))),
  );
  app.post("/sources/:id/rebind", async (c) =>
    c.json(await services.lifecycle.rebind(await contextFor(c), id(c), await c.req.json(), key(c))),
  );
  app.post("/imports/prepare", async (c) => {
    await contextFor(c);
    const input = z
      .object({ namespace: z.string(), packet: z.unknown() })
      .strict()
      .parse(await c.req.json());
    return c.json(await prepareEvidencePacketImport(input.packet, input.namespace));
  });
  app.post("/imports/restore-prepare", async (c) => {
    await contextFor(c);
    const input = z
      .object({ namespace: z.string(), export: z.unknown() })
      .strict()
      .parse(await c.req.json());
    return c.json(prepareExportRestore(input.export, input.namespace));
  });
  app.post("/imports/preview", async (c) =>
    c.json(await services.ingest.preview(await contextFor(c), await c.req.json()), 201),
  );
  app.post("/imports/:id/commit", async (c) => {
    const input = z
      .object({ input_hash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) })
      .strict()
      .parse(await c.req.json());
    return c.json(await services.ingest.commit(await contextFor(c), id(c), input.input_hash));
  });
  app.post("/erase-profile", async (c) => {
    const input = z
      .object({ confirm: z.literal(true) })
      .strict()
      .parse(await c.req.json());
    return c.json(await services.purge.purge(await contextFor(c), key(c), input.confirm));
  });
  app.get("/export", (c) => c.json(services.export.manifest()));
  app.get("/export/:part", async (c) =>
    c.json(
      await services.export.page(
        await contextFor(c),
        c.req.param("part"),
        Number(c.req.query("cursor") ?? 0),
      ),
    ),
  );
  return app;
}
export function cloudBlobRoutes(
  services: CloudServices,
  contextFor: (c: Context) => Promise<PersonalContext>,
) {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 50 * 1024 * 1024 }));
  app.get("/", async (c) =>
    c.json({
      enabled: services.blobs.available(),
      items: await services.blobs.list(await contextFor(c)),
    }),
  );
  app.post("/", async (c) =>
    c.json(await services.blobs.declare(await contextFor(c), await c.req.json()), 201),
  );
  app.put("/:id/content", async (c) => {
    if (!c.req.raw.body) return c.json({ error: { code: "BODY_REQUIRED" } }, 400);
    return c.json(await services.blobs.upload(await contextFor(c), id(c), c.req.raw.body));
  });
  app.get("/:id/content", async (c) => {
    const blob = await services.blobs.download(await contextFor(c), id(c));
    return new Response(blob.body, {
      headers: {
        "content-type": blob.mediaType,
        "content-length": String(blob.size),
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${id(c)}"`,
        "x-content-type-options": "nosniff",
      },
    });
  });
  app.delete("/:id", async (c) => {
    const body = z
      .object({ confirm: z.literal(true) })
      .strict()
      .parse(await c.req.json());
    return c.json(await services.blobs.remove(await contextFor(c), id(c)));
  });
  app.post("/:id/recover", async (c) =>
    c.json(await services.blobs.recover(await contextFor(c), id(c))),
  );
  return app;
}
export function cloudFrameworkRoutes(
  services: CloudServices,
  contextFor: (c: Context) => Promise<PersonalContext>,
) {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 56000 }));
  app.all("*", async (c) => {
    const ctx = await contextFor(c);
    let request = c.req.raw;
    let cap = 0;
    if (c.req.method === "POST" && new URL(request.url).pathname.endsWith("/continue")) {
      const { provider_call_cap, ...input } = await c.req.json();
      cap = z.number().int().min(0).max(2).parse(provider_call_cap);
      if (cap < 2) return c.json({ error: { code: "FRAMEWORK_TWO_CALL_CAP_REQUIRED" } }, 400);
      request = new Request(request, { body: JSON.stringify(input) });
    }
    const router = new Hono().route(
      "/api/understanding/frameworks",
      frameworkRoutes(services.framework(ctx, cap), { authorize: () => true }),
    );
    return router.fetch(request);
  });
  return app;
}
