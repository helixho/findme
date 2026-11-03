import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { VerifiedSnapshotCache } from "../src/understanding-app/read-cache.js";
import { sha256 } from "../src/understanding-baseline/io.js";

it("shares concurrent loads, rechecks every reuse, and does not retain failed loads", async () => {
  const cache = new VerifiedSnapshotCache<number>();
  let loads = 0;
  let checks = 0;
  const load = async () => {
    loads++;
    await Promise.resolve();
    return 1;
  };
  const verify = async () => {
    checks++;
  };
  expect(
    await Promise.all([cache.get("one", load, verify), cache.get("one", load, verify)]),
  ).toEqual([1, 1]);
  expect(loads).toBe(1);
  await cache.get("one", load, verify);
  expect(checks).toBe(1);
  await expect(
    cache.get(
      "one",
      async () => {
        throw new Error("CORRUPT");
      },
      async () => {
        throw new Error("STALE");
      },
    ),
  ).rejects.toThrow("CORRUPT");
  expect(await cache.get("one", async () => 2, verify)).toBe(2);
});

it("notices changed file bytes even when size and publication time are unchanged", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "u3-cache-test-"));
  const file = path.join(dir, "source.txt");
  try {
    await writeFile(file, "good");
    const original = await stat(file);
    const cache = new VerifiedSnapshotCache<string>();
    let loads = 0;
    const load = async () => {
      loads++;
      const bytes = await readFile(file);
      if (bytes.toString() !== "good") throw new Error("SOURCE_CHANGED");
      return sha256(bytes);
    };
    const verify = async (hash: string) => {
      if (sha256(await readFile(file)) !== hash) throw new Error("SOURCE_CHANGED");
    };
    await cache.get("source", load, verify);
    await writeFile(file, "evil");
    await utimes(file, original.atime, original.mtime);
    await expect(cache.get("source", load, verify)).rejects.toThrow("SOURCE_CHANGED");
    expect(loads).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps caches bounded and does not confuse separate input bindings", async () => {
  const cache = new VerifiedSnapshotCache<number>(1);
  let loads = 0;
  const read = (key: string, value: number) =>
    cache.get(
      key,
      async () => {
        loads++;
        return value;
      },
      async () => {},
    );
  expect(await read("first", 1)).toBe(1);
  expect(await read("second", 2)).toBe(2);
  expect(await read("first", 3)).toBe(3);
  expect(loads).toBe(3);
});
