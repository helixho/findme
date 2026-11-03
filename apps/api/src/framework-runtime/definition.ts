import { createHash } from "node:crypto";
import { FrameworkDefinition } from "@findme/core";

/** Canonical hash covers publication/usage/protocol too; no mutable run binding. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function defineFramework(
  content: Omit<FrameworkDefinition, "content_hash">,
): FrameworkDefinition {
  const normalized = FrameworkDefinition.parse({ ...content, content_hash: "0".repeat(64) });
  const { content_hash: _placeholder, ...body } = normalized;
  return FrameworkDefinition.parse({ ...body, content_hash: hash(body) });
}
export function validateDefinition(raw: unknown): FrameworkDefinition {
  const definition = FrameworkDefinition.parse(raw);
  const { content_hash, ...content } = definition;
  if (content_hash !== hash(content)) throw new Error("DEFINITION_HASH_MISMATCH");
  return definition;
}
