import type { Db } from "@findme/db";
import { Hono } from "hono";
import type { CoreGateway } from "../src/core/llm.js";
import { onError } from "../src/middleware/error.js";
import { coreRoutes } from "../src/routes/core.js";

// Test harness: Core routes for one fixed owner, without account sessions or Profile scoping.
// Account routing, sessions and scoping are covered by the account integration suites.
export function coreTestApp(opts: { db: Db; gateway?: CoreGateway; auth?: unknown }) {
  const app = new Hono();
  app.onError(onError);
  app.route(
    "/api/core",
    coreRoutes(opts.db, opts.gateway, async () => ({
      provider: "findme-runtime",
      principalId: "owner",
    })),
  );
  return app;
}
