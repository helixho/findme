import { createHash } from "node:crypto";

export const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export const digest = (value: unknown) => sha256(JSON.stringify(value));
export function fail(code: string): never {
  throw new Error(code);
}

// Historical dogfood hashing treats strings as raw bytes, unlike digest.
export const hash = (value: unknown) =>
  sha256(typeof value === "string" ? value : JSON.stringify(value));
