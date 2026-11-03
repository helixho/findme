import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

describe("upgraded Node adapter compatibility", () => {
  it("adapts synthetic Node HTTP requests without a listening server", async () => {
    const chunks: Buffer[] = [];
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const incoming = new IncomingMessage(socket as never);
    incoming.method = "GET";
    incoming.url = "/smoke?value=synthetic";
    incoming.headers = { host: "localhost" };
    incoming.push(null);
    const outgoing = new ServerResponse(incoming);
    outgoing.assignSocket(socket as never);
    const finished = once(outgoing, "finish");
    const app = new Hono().get("/smoke", (c) => c.json({ value: c.req.query("value") }));
    await getRequestListener(app.fetch, { overrideGlobalObjects: false })(incoming, outgoing);
    await finished;
    expect(outgoing.statusCode).toBe(200);
    expect(Buffer.concat(chunks).toString()).toContain('{"value":"synthetic"}');
    socket.destroy();
  });

  it("serves GET/HEAD/ranges and keeps encoded paths aligned with middleware", async () => {
    const directory = await mkdtemp(join(tmpdir(), "findme-static-dependency-"));
    try {
      await mkdir(join(directory, "assets"));
      await mkdir(join(directory, "protected"));
      await writeFile(join(directory, "assets", "app.js"), "synthetic-asset");
      await writeFile(join(directory, "protected", "data.txt"), "synthetic-protected");
      const app = new Hono();
      app.use("/protected/*", (c) => c.text("denied", 403));
      app.use("*", serveStatic({ root: directory }));
      const get = await app.request("/assets/app.js");
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toContain("javascript");
      expect(await get.text()).toBe("synthetic-asset");
      const head = await app.request("/assets/app.js", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe("15");
      expect(await head.text()).toBe("");
      const range = await app.request("/assets/app.js", { headers: { range: "bytes=0-8" } });
      expect(range.status).toBe(206);
      expect(range.headers.get("content-range")).toBe("bytes 0-8/15");
      expect(await range.text()).toBe("synthetic");
      expect((await app.request("/missing.txt")).status).toBe(404);
      expect((await app.request("/assets/app.js", { method: "POST" })).status).toBe(404);
      expect((await app.request("/protected/data.txt")).status).toBe(403);
      for (const path of [
        "/%70rotected/data.txt",
        "/%2570rotected/data.txt",
        "/%70rotected%FF/data.txt",
        "/assets/%2e%2e/protected/data.txt",
        "/assets/%252e%252e/protected/data.txt",
      ]) {
        const response = await app.request(path);
        expect([403, 404], path).toContain(response.status);
        expect(await response.text(), path).not.toContain("synthetic-protected");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
