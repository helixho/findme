import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
describe("explicit dependency override decisions", () => {
  it("documents every actual override version, without silently growing an unreviewed pin", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    const review = JSON.parse(
      await readFile(new URL("docs/implementation/dependency-overrides.json", root), "utf8"),
    );
    expect(Object.keys(review.overrides).sort()).toEqual(
      Object.keys(manifest.pnpm.overrides).sort(),
    );
    for (const [selector, version] of Object.entries(manifest.pnpm.overrides)) {
      expect(review.overrides[selector].version, selector).toBe(version);
      expect(review.overrides[selector].reason.trim().length, selector).toBeGreaterThan(15);
      expect(review.overrides[selector].introducedBy, selector).toBeTruthy();
      expect(Array.isArray(review.overrides[selector].declaredParents), selector).toBe(true);
      expect(review.overrides[selector].declaredParents.length, selector).toBeGreaterThan(0);
      for (const parent of review.overrides[selector].declaredParents) {
        expect(parent.resolved, selector).toBe(version);
        expect(parent.declaredRequirements.length, `${selector}: ${parent.parent}`).toBeGreaterThan(
          0,
        );
      }
    }
  });
  it("registers every installed backport with content provenance", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    const review = JSON.parse(
      await readFile(new URL("docs/implementation/dependency-overrides.json", root), "utf8"),
    );
    expect(Object.keys(manifest.pnpm.patchedDependencies).sort()).toEqual(
      Object.keys(review.patches).sort(),
    );
    for (const selector of Object.keys(manifest.pnpm.patchedDependencies)) {
      const patch = review.patches[selector];
      expect(manifest.pnpm.patchedDependencies[selector], selector).toBe(patch.path);
      expect(
        createHash("sha256")
          .update(await readFile(new URL(patch.path, root)))
          .digest("hex"),
        selector,
      ).toBe(patch.sha256);
      expect(patch.upstream, selector).toMatch(/^https:\/\/github.com\//);
      if (patch.kind === "upstream_backport") expect(patch.advisory, selector).toMatch(/^GHSA-/);
      else {
        expect([
          "toolchain_compatibility",
          "unused_command_cleanup",
          "local_advisory_fix",
        ]).toContain(patch.kind);
        expect(patch.reason.length, selector).toBeGreaterThan(20);
        expect(patch.relatedAdvisories.every((id: string) => /^GHSA-/.test(id))).toBe(true);
      }
    }
    expect(review.patches["zod@3.25.76"].advisory).toBe("GHSA-mrhx-c7xc-m3w5");
    expect(manifest.pnpm.patchedDependencies["webpack@5.91.0"]).toBeUndefined();
    expect(manifest.pnpm.overrides["webpack@5.91.0"]).toBeUndefined();
    expect(manifest.pnpm.overrides.tinypool).toBeUndefined();
  });
  it("keeps the authentication Zod4 patch separate from the business major3 contract", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    const api = JSON.parse(await readFile(new URL("apps/api/package.json", root), "utf8"));
    expect(manifest.pnpm.overrides.zod).toBeUndefined();
    expect(manifest.pnpm.overrides["zod@^4"]).toBe("4.6.6");
    expect(api.dependencies.zod).toMatch(/^\^?3\./);
  });
});
