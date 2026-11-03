import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { frameworkRoutes } from "../framework-runtime/routes.js";
import type { FrameworkService } from "../framework-runtime/service.js";
import { inside } from "../understanding-baseline/io.js";
import type { PrivateUnderstandingRepository } from "./repository.js";
import { understandingRoutes } from "./routes.js";
export async function createPrivateUnderstandingHost(
  repository: PrivateUnderstandingRepository,
  token: string,
  build: string,
  frameworks?: FrameworkService,
) {
  const app = new Hono();
  if (frameworks) {
    const expected = Buffer.from(`Bearer ${token}`);
    app.route(
      "/api/understanding/frameworks",
      frameworkRoutes(frameworks, {
        authorize: (request) => {
          const actual = Buffer.from(request.headers.get("authorization") ?? "");
          return (
            Boolean(token.trim()) &&
            actual.length === expected.length &&
            timingSafeEqual(actual, expected)
          );
        },
      }),
    );
  }
  app.route(
    "/api/understanding",
    understandingRoutes(
      repository,
      token,
      frameworks ? () => frameworks.summaryStatus("human3") : undefined,
    ),
  );
  app.all("/api/*", (c) =>
    c.json({ error: { code: "NATIVE_CORE_UNAVAILABLE_PRIVATE_HOST" } }, 404),
  );
  const index = (await readFile(await inside(build, "index.html"), "utf8")).replace(
    "<head>",
    '<head><meta name="findme-private-host" content="understanding">',
  );
  app.get("*", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
    );
    if (c.req.path === "/" || c.req.path === "/index.html") return c.html(index);
    if (
      !c.req.path.startsWith("/assets/") &&
      ![
        "/manifest.webmanifest",
        "/apple-touch-icon.png",
        "/icon-192.png",
        "/icon-512.png",
        "/favicon.ico",
      ].includes(c.req.path)
    )
      return c.notFound();
    try {
      const file = await inside(build, `.${decodeURIComponent(c.req.path)}`);
      const bytes = await readFile(file);
      const ext = path.extname(file);
      const mime: Record<string, string> = {
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
        ".webmanifest": "application/manifest+json",
        ".ico": "image/x-icon",
      };
      return c.body(bytes, 200, { "Content-Type": mime[ext] ?? "application/octet-stream" });
    } catch {
      return c.notFound();
    }
  });
  return app;
}
