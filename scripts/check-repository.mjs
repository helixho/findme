import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Only tracked documentation/static files are read. Never load env or private data.
export function checkRepository(root, files) {
  const errors = [];
  let references = 0;
  const anchors = new Map();
  function ids(file) {
    if (anchors.has(file)) return anchors.get(file);
    const text = readFileSync(path.join(root, file), "utf8");
    const result = new Set([...text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)].map((m) => m[1]));
    if (file.endsWith(".md")) {
      const counts = new Map();
      for (const match of text.replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6}\s+(.+)$/gm)) {
        const slug = match[1]
          .trim()
          .toLowerCase()
          .replace(/<[^>]*>/g, "")
          .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
          .replace(/\s/g, "-");
        const count = counts.get(slug) ?? 0;
        counts.set(slug, count + 1);
        result.add(count ? `${slug}-${count}` : slug);
      }
    }
    anchors.set(file, result);
    return result;
  }
  function check(file, raw, kind) {
    if (!raw || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(raw) || /[${}]/.test(raw)) return;
    const [pathname, fragment] = raw.split("#", 2);
    let target;
    try {
      const local = decodeURIComponent(pathname.split("?")[0]);
      if (local.startsWith("/")) {
        const app = file.match(/^(apps\/[^/]+)\//)?.[1];
        if (!app) return; // No deployment root is defined for standalone design documents.
        if (local === "/") return;
        target = path.posix.join(app, local.startsWith("/src/") ? "" : "public", local);
      } else
        target = local
          ? path.posix.normalize(path.posix.join(path.posix.dirname(file), local))
          : file;
    } catch {
      errors.push(`${file}: malformed URL ${raw}`);
      return;
    }
    references++;
    if (target.startsWith("../") || !existsSync(path.join(root, target))) {
      errors.push(`${file}: missing ${raw}`);
    } else if (fragment && /\.(?:md|html)$/.test(target) && kind !== "asset") {
      const dynamicHashRoute =
        target.endsWith(".html") &&
        /(?:location\.hash|hashchange)/.test(readFileSync(path.join(root, target), "utf8"));
      if (!dynamicHashRoute && !ids(target).has(decodeURIComponent(fragment)))
        errors.push(`${file}: missing anchor ${raw}`);
    }
  }
  for (const file of files) {
    if (!existsSync(path.join(root, file)) || !/\.(?:md|html|css|webmanifest)$/.test(file))
      continue;
    const text = readFileSync(path.join(root, file), "utf8");
    if (file.endsWith(".md")) {
      const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
      for (const m of prose.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g))
        check(file, m[1].replace(/^<|>$/g, ""), "link");
    } else if (file.endsWith(".webmanifest")) {
      for (const icon of JSON.parse(text).icons ?? []) check(file, icon.src, "asset");
    } else {
      // Limit attributes to actual tags; embedded JS strings can contain escaped markup.
      for (const tag of text.matchAll(/<[a-z][^>]*>/gi))
        for (const m of tag[0].matchAll(/\b(href|src)=["']([^"']+)["']/g))
          check(file, m[2], m[1] === "src" ? "asset" : "link");
      for (const m of text.matchAll(/url\(\s*["']?([^\s)"']+)["']?\s*\)/g))
        check(file, m[1], "asset");
      if (file.endsWith(".css"))
        for (const m of text.matchAll(/@import\s+["']([^"']+)["']/g)) {
          const app = file.match(/^(apps\/[^/]+)\//)?.[1];
          const manifest = app && path.join(root, app, "package.json");
          const pkg =
            manifest && existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : {};
          if (!pkg.dependencies?.[m[1]] && !pkg.devDependencies?.[m[1]]) check(file, m[1], "asset");
        }
    }
  }
  return { references, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const result = checkRepository(root, files);
  for (const error of result.errors) console.error(error);
  console.log(
    `[repository] ${files.length} tracked entries; ${result.references} local references; ${result.errors.length} errors`,
  );
  if (result.errors.length) process.exitCode = 1;
}
