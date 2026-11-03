import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { checkRepository } from "../../../scripts/check-repository.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
function fixture(entries: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "findme-cleanup-"));
  roots.push(root);
  for (const [file, text] of Object.entries(entries)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return { root, files: Object.keys(entries) };
}

test("checks local Markdown anchors, HTML/CSS assets and public manifest roots", () => {
  const { root, files } = fixture({
    "README.md": "[阶段](docs/phase.md#第一阶段) [duplicate](docs/phase.md#第一阶段-1)",
    "docs/phase.md": "# 第一阶段\n# 第一阶段\n[web](../apps/app/index.html#main)",
    "apps/app/index.html": '<main id="main"><img src="/icon.png"><link href="style.css"></main>',
    "apps/app/style.css": 'body{background:url("/icon.png")}',
    "apps/app/public/icon.png": "fixture",
    "apps/app/public/manifest.webmanifest": '{"icons":[{"src":"/icon.png"}]}',
  });
  expect(checkRepository(root, files)).toEqual({ references: 7, errors: [] });
  rmSync(path.join(root, "apps/app/public/icon.png"));
  expect(checkRepository(root, files).errors).toHaveLength(3);
});

test("rejects missing links and anchors without treating code samples or external URLs as files", () => {
  const { root, files } = fixture({
    "README.md":
      "[bad](missing.md) [anchor](target.md#absent) [web](https://example.com)\n`[example](ignored)`\n```md\n[example](also-ignored)\n```",
    "target.md": "# Present",
  });
  expect(checkRepository(root, files)).toEqual({
    references: 2,
    errors: ["README.md: missing missing.md", "README.md: missing anchor target.md#absent"],
  });
});
