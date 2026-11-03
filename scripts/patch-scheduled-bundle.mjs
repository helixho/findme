import { createHash } from "node:crypto";
// Offline, narrowly scoped patch for the verified production cloudflare.js module.
// Usage: node scripts/patch-scheduled-bundle.mjs input.js output.js
// This does not upload, deploy, change bindings/assets, or access a database.
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output || input === output) throw new Error("Provide distinct input/output paths");
const original = readFileSync(input, "utf8");
const anchor =
  '  async scheduled(_controller, env2) {\n    if (env2.FINDME_ACCOUNT_MODE === "1") return;';
if (original.split(anchor).length !== 2 || original.includes("FINDME_SCHEDULED_ENABLED")) {
  throw new Error("Unexpected baseline: refusing ambiguous or already-patched bundle");
}
const replacement =
  '  async scheduled(_controller, env2) {\n    if (env2.FINDME_SCHEDULED_ENABLED !== "1") return;\n    if (env2.FINDME_ACCOUNT_MODE === "1") return;';
const patched = original.replace(anchor, replacement);
if (patched.replace(replacement, anchor) !== original) throw new Error("Patch verification failed");
writeFileSync(output, patched, { flag: "wx" });
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
console.log(JSON.stringify({ originalSha256: sha256(original), patchedSha256: sha256(patched) }));
