import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CLOUD_PIPELINE_ID } from "../src/cloud-diagnostic/policy-identity.js";
import { QUALIFICATION_HASH } from "../src/cloud-diagnostic/provenance.js";
import { PURPOSEFUL_EXPLORATION_POLICY } from "../src/core/epistemic-policy.js";
import { POLICY, PROMPTS } from "../src/domain/understanding/policy.js";
import {
  defineFramework,
  hash as definitionHash,
  validateDefinition,
} from "../src/framework-runtime/definition.js";
import { human3Draft } from "../src/framework-runtime/definitions/human3-draft.js";
import { currentPolicyRegistry, describePolicyIdentity } from "../src/policy-registry.js";

const api = fileURLToPath(new URL("../", import.meta.url));
const jsonDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("current source policy registry", () => {
  it("preserves the pre-extraction pipeline bytes, prompt digest and qualification identity", () => {
    expect(CLOUD_PIPELINE_ID).toBe(
      jsonDigest(["cloud-diagnostic-pipeline@2", POLICY, PROMPTS, QUALIFICATION_HASH]),
    );
    expect(CLOUD_PIPELINE_ID).toBe(
      "28903b294ce4bb051f80d7da5a58985580b3e3efae6fd2c6ae620244795cfb65",
    );
    expect(QUALIFICATION_HASH).toBe(
      "8b95d345fb504d91ac4807bd02ab3e2e6bbcee7252288e1c6c0391030c2f62dc",
    );
    expect(jsonDigest(PROMPTS)).toBe(
      "307085a2f821375189d2a30a19be7c5e631541097f1675a27a81887f855161ac",
    );
    const processing = readFileSync(path.join(api, "src/cloud-diagnostic/processing.ts"), "utf8");
    expect(processing).toContain('import { CLOUD_PIPELINE_ID } from "./policy-identity.js"');
    expect(processing).toContain("const PIPELINE = CLOUD_PIPELINE_ID;");
  });

  it("retains the actual independent Core policy/prompt/validator strings", () => {
    const core = currentPolicyRegistry().entries.filter((entry) => entry.key.startsWith("core."));
    expect(core.map((entry) => entry.identifiers.map((item) => item.value))).toEqual([
      [
        "epistemic-policy@v1",
        "purposeful-planner-prompt@v5",
        "exploration-plan-validator@v2",
        "purposeful-exploration@v1",
      ],
      [
        "epistemic-policy@v1",
        "understanding-prompt@v2",
        "understanding-policy-validator@v2",
        "purposeful-exploration@v1",
      ],
      [
        "epistemic-policy@v1",
        "revision-prompt@v2",
        "revision-policy-validator@v1",
        "purposeful-exploration@v1",
      ],
      [
        "epistemic-policy@v1",
        "understanding-prior-prompt@v1",
        "prior-update-validator@v1",
        "purposeful-exploration@v1",
        "prior-understanding-selection@v1",
      ],
    ]);
    expect(core.every((entry) => entry.digest === null)).toBe(true);
    expect(describePolicyIdentity("diagnostic-evidence-policy@3").status).toBe("known");
    expect(POLICY).toBe("u2-proposition-context-policy@2:diagnostic-evidence-policy@3");
    expect(describePolicyIdentity("bounded-explanation-and-independent-audit@3").status).toBe(
      "known",
    );
  });

  it("separates exact known IDs, unknown historical hashes and ambiguous versions", () => {
    expect(describePolicyIdentity(CLOUD_PIPELINE_ID)).toMatchObject({
      status: "known",
      current: true,
      matchedBy: "digest",
      entry: { key: "cloud.pipeline" },
    });
    const historical = "a".repeat(64);
    expect(describePolicyIdentity(historical)).toMatchObject({
      status: "unknown",
      current: false,
      query: historical,
    });
    expect(describePolicyIdentity("diagnostic-evidence-policy@2")).toMatchObject({
      status: "unknown",
      current: false,
    });
    expect(describePolicyIdentity("cloud-diagnostic-pipeline@2").status).toBe("unknown");
    expect(describePolicyIdentity(` ${CLOUD_PIPELINE_ID}`).status).toBe("unknown");
    const ambiguous = describePolicyIdentity(PURPOSEFUL_EXPLORATION_POLICY.version);
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status === "ambiguous")
      expect(ambiguous.entries.map((entry) => entry.key)).toEqual([
        "core.planner",
        "core.synthesis",
        "core.revision",
        "core.prior",
      ]);
    expect(describePolicyIdentity("understanding-prior-prompt@v1")).toMatchObject({
      status: "known",
      entry: { key: "core.prior" },
    });
  });

  it("returns detached arrays/objects, including lookup results", () => {
    const before = JSON.stringify(currentPolicyRegistry());
    const detached = currentPolicyRegistry();
    expect(detached.entries).not.toBe(currentPolicyRegistry().entries);
    // Deliberately bypass readonly types to prove isolation from JS callers.
    (detached.entries[0]!.sources as string[]).push("changed");
    (detached.entries[0]!.identifiers[0] as { value: string }).value = "changed";
    (detached.framework.notes as string[]).length = 0;
    const lookup = describePolicyIdentity(CLOUD_PIPELINE_ID);
    if (lookup.status === "known") (lookup.entry.notes as string[]).push("changed");
    expect(JSON.stringify(currentPolicyRegistry())).toBe(before);
  });

  it("describes framework hashes as definition-scoped without loading a definition store", () => {
    const framework = currentPolicyRegistry().framework;
    expect(framework.scope).toBe("definition-version");
    expect(framework.globalDigest).toBeNull();
    expect(framework.notes.join(" ")).toContain("removes content_hash");
    expect(framework.sources).toContain("apps/api/src/framework-runtime/definition.ts");
    const { content_hash, ...body } = human3Draft;
    expect(content_hash).toBe(definitionHash(body));
    expect(validateDefinition(human3Draft)).toEqual(human3Draft);
    const changed = defineFramework({
      ...body,
      usage_status: body.usage_status === "reviewed" ? "review_required" : "reviewed",
    });
    expect(changed.content_hash).not.toBe(content_hash);
    expect(describePolicyIdentity(content_hash)).toMatchObject({
      status: "unknown",
      current: false,
    });
    expect(describePolicyIdentity(changed.content_hash)).toMatchObject({
      status: "unknown",
      current: false,
    });
  });

  it("has no first-party frozen/localfs/repository/provider initialization import graph", () => {
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      verbatimModuleSyntax: true,
    };
    const seen = new Set<string>();
    function walk(input: string) {
      const file = realpathSync(input);
      if (seen.has(file)) return;
      seen.add(file);
      expect(file).not.toMatch(
        /\/src\/(understanding-baseline|dogfood)\/|\/private-repository\.ts$|\/llm\/gateway\.ts$|\/repository\.ts$/,
      );
      const emitted = ts.transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: options,
      }).outputText;
      const ast = ts.createSourceFile(`${file}.js`, emitted, ts.ScriptTarget.ES2022, true);
      function visit(node: ts.Node) {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const specifier = node.moduleSpecifier.text;
          expect(specifier).not.toMatch(/^(node:)?fs(?:\/|$)/);
          const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
          if (!resolved) expect(specifier).not.toMatch(/^\.|^@findme\//);
          else if (
            !resolved.resolvedFileName.includes("/node_modules/") &&
            !resolved.resolvedFileName.endsWith(".d.ts")
          )
            walk(resolved.resolvedFileName);
        }
        if (ts.isCallExpression(node))
          expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
    walk(path.join(api, "scripts/policy-inspect.ts"));
    walk(path.join(api, "src/cloud-diagnostic/policy-identity.ts"));
    expect(seen.size).toBeGreaterThan(10);
  });

  it("runs the readonly CLI without app configuration and queries exact supplied IDs", () => {
    const run = (...args: string[]) =>
      JSON.parse(
        execFileSync(process.execPath, ["--import", "tsx", "scripts/policy-inspect.ts", ...args], {
          cwd: api,
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        }),
      );
    expect(run().entries).toEqual(currentPolicyRegistry().entries);
    expect(
      run(CLOUD_PIPELINE_ID, "historical-unknown", "epistemic-policy@v1").map(
        (result: { status: string; current: boolean }) => [result.status, result.current],
      ),
    ).toEqual([
      ["known", true],
      ["unknown", false],
      ["ambiguous", true],
    ]);
  });
});
