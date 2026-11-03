import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import path from "node:path";

import { fail } from "../shared/primitives.js";
export { sha256, digest, fail } from "../shared/primitives.js";

export function contains(root: string, file: string) {
  const r = path.relative(root, file);
  return !r || (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
}
export async function noLinks(file: string) {
  let current = path.resolve(file);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) fail("SYMLINK_NOT_ALLOWED");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export async function inside(root: string, file: string) {
  const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  if (!contains(root, resolved)) fail("REFERENCE_PATH_ESCAPE");
  await noLinks(resolved);
  const actual = await realpath(resolved);
  if (!contains(root, actual)) fail("REFERENCE_PATH_ESCAPE");
  return actual;
}
async function future(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return path.join(await future(path.dirname(file)), path.basename(file));
  }
}
export async function prepareOutput(out: string, protectedRoots: string[]) {
  if (!path.isAbsolute(out)) fail("ABSOLUTE_OUTPUT_REQUIRED");
  await noLinks(out);
  const resolved = await future(out);
  for (const root of protectedRoots) {
    const actual = await realpath(root);
    if (contains(actual, resolved) || contains(resolved, actual)) fail("PROTECTED_OUTPUT_PATH");
  }
  await privateDirectory(resolved);
  return resolved;
}
export async function privateDirectory(dir: string) {
  await noLinks(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}
export async function atomic(file: string, value: unknown, raw = false) {
  await noLinks(file);
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(raw ? String(value) : JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
}
export async function optionalJson<T>(file: string): Promise<T | undefined> {
  await noLinks(file);
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
