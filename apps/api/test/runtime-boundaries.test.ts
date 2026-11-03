import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const api = fileURLToPath(new URL("../", import.meta.url));
const root = path.resolve(api, "../..");
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  verbatimModuleSyntax: true,
};
// Inspect emitted JS: type-only imports/exports (including mixed named bindings) disappear.
// Resolve retained values with TypeScript, including .js -> .ts and workspace exports.
function specifiers(source: string): string[] {
  const emitted = ts.transpileModule(source, { compilerOptions: options }).outputText;
  const ast = ts.createSourceFile("module.js", emitted, ts.ScriptTarget.ES2022, true);
  const result: string[] = [];
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      result.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteral(argument))
        throw new Error("Boundary graph requires a literal runtime import");
      result.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}
function graph(entries: string[]) {
  const seen = new Set<string>();
  const edges: [string, string][] = [];
  function walk(input: string) {
    const file = realpathSync(input);
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
      if (!resolved) {
        if (specifier.startsWith(".") || specifier.startsWith("@findme/"))
          throw new Error(`Unresolved runtime import ${file}: ${specifier}`);
        edges.push([file, specifier]);
        continue;
      }
      const target = realpathSync(resolved.resolvedFileName);
      edges.push([file, target]);
      // Third-party packages are terminal; this measures first-party runtime boundaries.
      if (!target.includes("/node_modules/") && !target.endsWith(".d.ts")) walk(target);
    }
  }
  entries.forEach(walk);
  return { files: [...seen], edges };
}
const relative = (file: string) => path.relative(root, file);
const forbidden = (file: string) =>
  /apps\/api\/src\/(understanding-baseline|dogfood)\//.test(file) ||
  file.endsWith("/helpers/file-framework-repository.ts");

describe("hosted first-party value import boundaries", () => {
  it("distinguishes types, mixed bindings, re-exports and dynamic value imports", () => {
    expect(
      specifiers(`
      import type { T } from './type.js';
      import { type T2, value } from './mixed.js';
      export type { T3 } from './export-type.js';
      export { value as other } from './export-value.js';
      export * from './star.js';
      void import('./dynamic.js');
    `),
    ).toEqual(["./mixed.js", "./export-value.js", "./star.js", "./dynamic.js"]);
  });

  it("cloud diagnostics and hosted readers never load frozen/local runners or storage", () => {
    const entries = [
      ...readdirSync(path.join(api, "src/cloud-diagnostic"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => path.join(api, "src/cloud-diagnostic", f)),
      ...[
        "understanding-app/archive-runtime",
        "framework-runtime/service",
        "framework-runtime/schema",
        "framework-runtime/routes",
        "domain/understanding/policy",
        "shared/primitives",
      ].map((f) => path.join(api, `src/${f}.ts`)),
    ];
    const measured = graph(entries);
    expect(measured.files.filter(forbidden).map(relative)).toEqual([]);
    expect(
      measured.edges
        .filter(([, target]) => /^(node:)?fs(?:\/|$)/.test(target))
        .map(([from, target]) => [relative(from), target]),
    ).toEqual([]);
    console.info(
      `[runtime-boundary] ${entries.length} roots; ${measured.files.length} first-party files; ${measured.edges.length} value edges; 0 frozen/dogfood/private-storage or fs edges`,
    );
  });

  it("the guard detects compatibility entries that intentionally retain local IO", () => {
    const measured = graph([path.join(api, "test/helpers/file-framework-repository.ts")]);
    expect(measured.files.some(forbidden)).toBe(true);
    expect(measured.edges.some(([, target]) => target === "node:fs/promises")).toBe(true);
  });
});
