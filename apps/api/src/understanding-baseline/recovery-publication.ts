import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { digest, fail, inside, optionalJson } from "./io.js";
export async function recoveryPublication(out: string, run: { input_hash: string; model: string }) {
  const pointers: {
    pointer: { directory: string; version: string; input_hash: string };
    published: number;
  }[] = [];
  for (const name of ["latest-partial.json", "latest-ready.json"]) {
    const ptr = await optionalJson<{ directory: string; version: string; input_hash: string }>(
      path.join(out, name),
    );
    if (ptr) {
      const b = JSON.parse(
        await readFile(await inside(out, path.join(ptr.directory, "baseline.json")), "utf8"),
      );
      if (
        digest(b) !== ptr.version ||
        b.input_hash !== run.input_hash ||
        ptr.input_hash !== run.input_hash ||
        b.model !== run.model
      )
        fail("RECOVERY_BASELINE_CHANGED");
      pointers.push({ pointer: ptr, published: (await stat(await inside(out, name))).mtimeMs });
    }
  }
  pointers.sort((a, b) => b.published - a.published);
  if (
    pointers[1] &&
    required(pointers[0]).published === pointers[1].published &&
    required(pointers[0]).pointer.version !== pointers[1].pointer.version
  )
    fail("AMBIGUOUS_BASELINE_PUBLICATION");
  const pointer = pointers[0]?.pointer;
  if (!pointer || pointer.input_hash !== run.input_hash) fail("RECOVERY_BASELINE_REQUIRED");
  const baseline = JSON.parse(
    await readFile(await inside(out, path.join(pointer.directory, "baseline.json")), "utf8"),
  );
  if (
    digest(baseline) !== pointer.version ||
    baseline.input_hash !== run.input_hash ||
    baseline.model !== run.model
  )
    fail("RECOVERY_BASELINE_CHANGED");
  return { pointer, baseline };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) fail("RECOVERY_REFERENCE_MISSING");
  return value;
}
