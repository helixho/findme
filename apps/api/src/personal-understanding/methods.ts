import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

export const METHOD_NAMES = [
  "experience-and-evidence",
  "problem-and-explanations",
  "behavior-and-conditions",
  "needs-values-and-narrative",
  "decisions-and-acquisition",
  "trust-and-verification",
  "life-structure-synthesis",
  "discriminating-exploration",
  "understanding-revision",
  "understanding-review",
] as const;
export type MethodName = (typeof METHOD_NAMES)[number];
export type MethodDocument = {
  name: MethodName;
  description: string;
  text: string;
  version: string;
};
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Explicit application resource root; never searches HOME, cwd or global agent skills. */
export class UnderstandingMethods {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error("METHOD_ROOT_MUST_BE_ABSOLUTE");
  }

  private async read(relative: string) {
    const root = await realpath(this.root);
    const file = await realpath(path.resolve(root, relative));
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("METHOD_RESOURCE_OUTSIDE_ROOT");
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("METHOD_RESOURCE_TOO_LARGE");
    return { text, version: digest(text) };
  }

  async load(name: MethodName): Promise<MethodDocument> {
    if (!METHOD_NAMES.includes(name)) throw new Error("UNKNOWN_UNDERSTANDING_METHOD");
    const resource = await this.read(`skills/${name}/SKILL.md`);
    const header = resource.text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    const declared = header?.match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim();
    const rawDescription = header?.match(
      /^description:[ \t]*([^\r\n]*)(?:\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*))?/m,
    );
    const description = rawDescription
      ? /^[>|][-+]?$/.test((rawDescription[1] ?? "").trim())
        ? (rawDescription[2] ?? "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .join(" ")
            .trim()
        : (rawDescription[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2")
      : "";
    if (declared !== name || !description) throw new Error("INVALID_METHOD_METADATA");
    return { name, description, ...resource };
  }

  async catalog() {
    return Promise.all(
      METHOD_NAMES.map(async (name) => {
        const { description, version } = await this.load(name);
        return { name, description, version };
      }),
    );
  }

  async reference(name: MethodName, file: string) {
    if (!METHOD_NAMES.includes(name) || !/^[a-zA-Z0-9_-]+\.md$/.test(file))
      throw new Error("UNKNOWN_METHOD_REFERENCE");
    const relative = `skills/${name}/references/${file}`;
    const root = await realpath(this.root);
    const methodRoot = await realpath(path.join(root, "skills", name));
    if (!methodRoot.startsWith(`${root}${path.sep}`))
      throw new Error("METHOD_RESOURCE_OUTSIDE_ROOT");
    const target = await realpath(path.join(methodRoot, "references", file));
    if (!target.startsWith(`${methodRoot}${path.sep}`))
      throw new Error("METHOD_RESOURCE_OUTSIDE_METHOD");
    return this.read(relative);
  }

  system() {
    return this.read("system.md");
  }
}

export function requiredMethods(
  intent: "conversation" | "correction" | "synthesis",
  writesUnderstanding: boolean,
  selected: readonly MethodName[],
): MethodName[] {
  if (selected.some((name) => !METHOD_NAMES.includes(name)))
    throw new Error("UNKNOWN_UNDERSTANDING_METHOD");
  const names = new Set(selected);
  if (intent === "correction") names.add("understanding-revision");
  if (intent === "correction" || intent === "synthesis" || writesUnderstanding)
    names.add("understanding-review");
  return METHOD_NAMES.filter((name) => names.has(name));
}
