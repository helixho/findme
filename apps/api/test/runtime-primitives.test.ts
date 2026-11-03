import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { UnderstandingReport } from "@findme/core";
import type { Db } from "@findme/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonalContext } from "../src/core/exploration-service.js";
import { hash as legacyHash } from "../src/dogfood/model.js";
import {
  POLICY,
  PROMPTS,
  normalizeReportTimes,
  validateAudit,
  validateReport,
} from "../src/domain/understanding/policy.js";
import { FrameworkStateSchema } from "../src/framework-runtime/schema.js";
import { digest, fail, hash, sha256 } from "../src/shared/primitives.js";
import * as legacyIO from "../src/understanding-baseline/io.js";
import * as legacyPolicy from "../src/understanding-baseline/policy.js";
import { PrivateFrameworkRepository } from "./helpers/file-framework-repository.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const nodeHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

describe("stable runtime primitives and policy", () => {
  it("preserves exact UTF8/binary bytes and the two historical JSON conventions", () => {
    for (const value of ["", "中文😀\r\n", "\ud800", Buffer.from([0, 255, 128, 10])])
      expect(sha256(value)).toBe(nodeHash(value));
    for (const value of [null, true, 12, "中文😀", { b: 1, a: [null, "x"] }]) {
      expect(digest(value)).toBe(nodeHash(JSON.stringify(value)));
      expect(hash(value)).toBe(nodeHash(typeof value === "string" ? value : JSON.stringify(value)));
    }
    expect(digest("x")).not.toBe(hash("x"));
    expect(digest({ a: 1, b: 2 })).not.toBe(digest({ b: 2, a: 1 }));
    expect(() => digest(undefined)).toThrow();
    expect(() => hash(undefined)).toThrow();
    expect(() => fail("EXACT_ERROR")).toThrowError(new Error("EXACT_ERROR"));
    expect(legacyIO.sha256).toBe(sha256);
    expect(legacyIO.digest).toBe(digest);
    expect(legacyIO.fail).toBe(fail);
    expect(legacyHash).toBe(hash);
  });

  it("preserves baseline 4a1df98 policy/prompt bytes and compatibility exports", () => {
    expect(digest({ POLICY, PROMPTS })).toBe(
      "67ce6dfcd1e09156e74255f38ae63d77c679b23bba476e2c5d3073bccd2e9d21",
    );
    expect(legacyPolicy.PROMPTS).toBe(PROMPTS);
    expect(legacyPolicy.validateReport).toBe(validateReport);
    expect(legacyPolicy.validateAudit).toBe(validateAudit);
    const report = UnderstandingReport.parse({
      headline: "材料有限",
      alternatives: [],
      current_understanding: null,
      findings: [],
      resources_conditions_costs: [],
      nodes: [],
      links: [],
      unknowns: ["材料不足"],
      question: null,
      next_step: null,
    });
    expect(() => validateReport(report, { evidence: [] })).not.toThrow();
    expect(normalizeReportTimes(report)).toEqual(report);
    expect(() => validateReport({ ...report, unknowns: [] }, { evidence: [] })).toThrow(
      "CURRENT_UNDERSTANDING_REQUIRED",
    );
    expect(() =>
      validateAudit({ input_hash: "h", checks: [], issues: [] }, "other", [], []),
    ).toThrow("INCOMPLETE_SAME_INPUT_AUDIT");
  });
});

describe("private framework storage remains a local adapter", () => {
  it("retains empty reads, serialized writes, rollback and stored checksum format", async () => {
    const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), "findme-runtime-framework-"));
    dirs.push(dir);
    const repository = new PrivateFrameworkRepository(dir, "synthetic-owner");
    expect((await repository.read()).revision).toBe(0);
    await expect(readFile(path.join(dir, "frameworks/state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const versions = await Promise.all(
      Array.from({ length: 6 }, () => repository.update((state) => state.revision)),
    );
    expect([...versions].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    await expect(
      repository.update((state) => {
        state.owner_key = "wrong";
        throw Error("ROLLBACK");
      }),
    ).rejects.toThrow("ROLLBACK");
    const file = path.join(dir, "frameworks/state.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored).toEqual({
      state: FrameworkStateSchema.parse(await repository.read()),
      hash: digest(stored.state),
    });
    expect(stored.state.revision).toBe(6);
    await expect(new PrivateFrameworkRepository(dir, "another-owner").read()).rejects.toThrow(
      "OWNER_SCOPE_MISMATCH",
    );
    stored.state.revision++;
    await writeFile(file, JSON.stringify(stored));
    await expect(repository.read()).rejects.toThrow("FRAMEWORK_STATE_INTEGRITY");
  });
});
