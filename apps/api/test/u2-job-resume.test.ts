import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UnderstandingReport } from "@findme/core";
import { afterEach, expect, it } from "vitest";
import { type JobOptions, jobRunner } from "../src/understanding-baseline/jobs.js";
import { validateReport } from "../src/understanding-baseline/policy.js";
import type { Selection } from "../src/understanding-baseline/prepare.js";
const dirs: string[] = [];
afterEach(async () => {
  for (const p of dirs.splice(0)) await rm(p, { recursive: true, force: true });
});
it("keeps unnormalized failed raw and permits a real retry rather than inventing a valid timestamp", async () => {
  const out = await realpath(await mkdtemp(path.join(os.tmpdir(), "u2-job-resume-")));
  dirs.push(out);
  const stamp = "2026-01-01T00:00:00Z";
  const selection = {
    domain: "synthetic",
    evidence: [
      {
        id: "e",
        time: stamp,
        use: "personal_expression",
        purpose: "personal_expression",
        content_author: "subject",
        about: "self",
        kind: "self_report",
        stance: "reported",
      },
    ],
  } as Selection;
  const f = {
    key: "f",
    text: "合成自述",
    scope: "仅该来源",
    evidence_ids: ["e"],
    counterevidence_ids: [],
    context_ids: [],
    time: "null",
    status: "reported",
  };
  const raw = {
    headline: "合成",
    current_understanding: f,
    findings: [],
    resources_conditions_costs: [],
    alternatives: [],
    unknowns: [],
    question: null,
    next_step: null,
    nodes: [
      {
        key: "n",
        type: "state",
        text: "合成状态",
        scope: "该来源",
        evidence_ids: ["e"],
        time: "1999-01-01",
        status: "reported",
        stance: "reported",
        actor: "subject",
        about: "subject",
      },
    ],
    links: [],
  };
  let calls = 0;
  const gateway: NonNullable<JobOptions["gateway"]> = {
    describe: (route) => ({ route, model: "mock" }),
    extract: async (args) => {
      calls++;
      const value = structuredClone(raw);
      if (calls > 1) value.nodes[0].time = stamp;
      await args.controls?.captureRawOutput?.(JSON.stringify(value));
      return args.schema.parse(value);
    },
  };
  const options = {
    out,
    inputHash: "a".repeat(64),
    model: "mock",
    gateway,
    live: true,
    maxCalls: 2,
    fresh: async () => {},
  };
  const payload = { task: "synthetic", selection };
  const first = await jobRunner(options);
  expect(
    await first.job("topic", payload, UnderstandingReport, (r) => validateReport(r, selection)),
  ).toBeUndefined();
  const before = JSON.parse(
    await readFile(path.join(out, "jobs", `${first.attempts[0]?.job}.json`), "utf8"),
  );
  expect(before.result.current_understanding.time).toBe("null");
  expect(before.error).toBe("TIME_SCOPE_MISMATCH");
  const second = await jobRunner({ ...options, retryFailed: true });
  const recovered = await second.job("topic", payload, UnderstandingReport, (r) =>
    validateReport(r, selection),
  );
  expect(recovered?.current_understanding?.time).toBeNull();
  expect(calls).toBe(2);
  expect(second.attempts.map((a) => a.status)).toEqual(["error", "ok"]);
});
