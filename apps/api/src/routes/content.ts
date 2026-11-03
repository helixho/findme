import { ReflectionInput } from "@findme/core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getPublishedClaim, listPublishedContent } from "../content/catalog.js";
import { buildANewEarthReflection } from "../content/reflection.js";

export function contentRoutes() {
  const r = new Hono();

  // The list is a selection surface: withdrawn and draft versions never appear.
  r.get("/", (c) => c.json({ items: listPublishedContent() }));

  r.get("/:contentId", (c) => {
    const version = listPublishedContent().find(
      (candidate) => candidate.content_id === c.req.param("contentId"),
    );
    return version ? c.json({ item: version }) : c.json({ error: "content_not_found" }, 404);
  });

  r.post("/perspectives/a-new-earth/reflection", zValidator("json", ReflectionInput), (c) => {
    const input = c.req.valid("json");
    if (!input.enabled) return c.json({ enabled: false, perspective: null });
    const selected = getPublishedClaim("perspective.a-new-earth", input.claim_id);
    if (!selected) return c.json({ error: "published_claim_not_found" }, 404);
    return c.json({
      enabled: true,
      perspective: buildANewEarthReflection(
        selected.version,
        selected.claim,
        input.situation,
        input.response,
      ),
    });
  });

  return r;
}
