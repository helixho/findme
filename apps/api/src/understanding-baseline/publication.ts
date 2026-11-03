import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { digest, fail, inside, optionalJson, privateDirectory, sha256 } from "./io.js";
export async function verifyPublishedVersion(
  directory: string,
  version: string,
  artifactNames: string[],
) {
  const existing = await optionalJson<{
    version: string;
    files?: Record<string, string>;
  }>(path.join(directory, "manifest.json"));
  if (existing && existing.version !== version) fail("VERSION_INTEGRITY");
  if (existing) {
    if (
      !existing.files ||
      digest(Object.keys(existing.files).sort()) !== digest([...artifactNames].sort())
    )
      fail("VERSION_ARTIFACT_MANIFEST_INVALID");
    for (const name of artifactNames)
      if (sha256(await readFile(await inside(directory, name))) !== existing.files[name])
        fail("VERSION_ARTIFACT_INTEGRITY");
    if (
      digest(JSON.parse((await readFile(path.join(directory, "baseline.json"))).toString())) !==
      version
    )
      fail("BASELINE_VERSION_INTEGRITY");
  }
  return existing;
}

export async function buildPublishedVersion(
  versions: string,
  directory: string,
  write: (temp: string) => Promise<void>,
  fresh: () => Promise<void>,
) {
  const temp = path.join(versions, `.build-${randomUUID()}`);
  await privateDirectory(temp);
  await write(temp);
  await fresh();
  await rename(temp, directory);
}
