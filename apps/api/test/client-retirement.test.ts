import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const json = async (path: string) => JSON.parse(await readFile(new URL(path, root), "utf8"));

describe("single browser client repository contract", () => {
  it("removes both retired projects and their workspace commands", async () => {
    for (const path of ["apps/web", "apps/miniapp"])
      expect(existsSync(new URL(path, root))).toBe(false);
    const manifest = await json("package.json");
    expect(manifest.scripts["dev:web"]).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toMatch(/@tarojs|@findme\/(?:web|miniapp)|webpack/);
    const lock = await readFile(new URL("pnpm-lock.yaml", root), "utf8");
    expect(lock).not.toMatch(/^ {2}apps\/(?:web|miniapp):/m);
    expect(lock).not.toMatch(/@tarojs|html-minifier@|miniprogram-simulate@|webpack-dev-server@/);
  });

  it("keeps the React browser App as the only static deployment and the API asset-free", async () => {
    const api = await json("wrangler.jsonc");
    const app = await json("wrangler.app.jsonc");
    expect(api.main).toBe("apps/api/src/cloudflare.ts");
    expect(api.assets).toBeUndefined();
    expect(app.assets.directory).toBe("apps/app/dist");
    expect(app.assets.not_found_handling).toBe("single-page-application");
    expect(existsSync(new URL("apps/app/src/main.tsx", root))).toBe(true);
  });

  it("preserves the App browser entry and mobile viewport support", async () => {
    const html = await readFile(new URL("apps/app/index.html", root), "utf8");
    expect(html).toContain('name="viewport"');
    expect(html).toContain("width=device-width");
    expect(html).toContain("/src/main.tsx");
    const manifest = await json("apps/app/package.json");
    expect(manifest.dependencies["react-dom"]).toBeTruthy();
    expect(manifest.scripts.build).toContain("vite build");
  });
});
