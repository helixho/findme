import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type FrameworkAssertion,
  FrameworkAudit,
  type FrameworkCandidate,
  type FrameworkDefinition,
} from "@findme/core";
import { afterEach, describe, expect, it } from "vitest";
import type { FrameworkGateway } from "../src/framework-runtime/attempts.js";
import { defineFramework } from "../src/framework-runtime/definition.js";
import { human3Draft } from "../src/framework-runtime/definitions/human3-draft.js";
import { assertions } from "../src/framework-runtime/policy.js";
import { frameworkRoutes } from "../src/framework-runtime/routes.js";
import { FrameworkService } from "../src/framework-runtime/service.js";
import {
  type FrameworkRepository,
  PrivateFrameworkRepository,
} from "../src/framework-runtime/state.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
function definition(min = 1, max = 1) {
  const { content_hash: _hash, ...d } = human3Draft;
  return defineFramework({
    ...d,
    key: "synthetic",
    version: "test-v1",
    publication_status: "published",
    usage_status: "reviewed",
    title: "Synthetic test framework",
    domains: d.domains.map((x) => ({ ...x, min_answers: min, max_answers: max })),
    disclaimer: "Synthetic only. No real person or official fidelity claim.",
  });
}
type Input = {
  stage: string;
  domain_index: number;
  definition: FrameworkDefinition;
  answers: {
    id: string;
    text: string;
    domain: string;
  }[];
};
function claim(
  id: string,
  sources: Input["answers"],
  basis: FrameworkAssertion["basis"] = "reported",
): FrameworkAssertion {
  return {
    id,
    text: "Synthetic bounded observation",
    basis,
    refs: sources.map((a) => ({ source_id: a.id, start: 0, end: a.text.length, quote: a.text })),
  };
}
function candidate(i: Input, unknown = false): FrameworkCandidate {
  const d = i.definition.domains[i.domain_index];
  const sources = i.answers.filter((a) => a.domain === d?.key);
  if (i.stage === "question")
    return {
      kind: "question",
      domain: required(d).key,
      text: `Synthetic probe after ${sources.length} answers?`,
      intent: claim("intent", sources),
    };
  if (i.stage !== "synthesis") {
    const trait = {
      status: "unknown" as const,
      assessment: null,
      reason: "Insufficient practice evidence",
    };
    return {
      kind: "evaluation",
      assessment: {
        domain: required(d).key,
        evidence_status: unknown ? "unknown" : "supported",
        level: unknown ? null : "individualist",
        phase: unknown ? null : "uncertainty",
        reason: "Bounded synthetic input",
        rationale: unknown ? null : claim("rationale", sources),
        knowledge: trait,
        experience: trait,
        skill: trait,
        strengths: [],
        limitations: [],
        practice_mismatch: [],
        regression: [],
        channels: [],
      },
    };
  }
  return {
    kind: "synthesis",
    synthesis: {
      integration: claim("integration", i.answers, "hypothesis"),
      lifestyle: {
        name: "Synthetic lifestyle",
        assessment: claim("lifestyle", i.answers, "hypothesis"),
      },
      metatype: {
        name: "Dynamic synthetic metatype",
        assessment: claim("metatype", i.answers, "hypothesis"),
      },
      cross_domain_links: [
        {
          domains: i.definition.domains.slice(0, 2).map((d) => d.key),
          relation: "interaction",
          assessment: claim(
            "link",
            i.answers.filter((a) =>
              i.definition.domains.slice(0, 2).some((d) => d.key === a.domain),
            ),
            "hypothesis",
          ),
        },
      ],
      core_problem: claim("core", i.answers, "hypothesis"),
      plans: i.definition.plan_horizons.map((h) => ({
        horizon: h,
        status: "proposal",
        proposals: [claim(`plan-${h}`, i.answers, "hypothesis")],
      })),
      glitch_risks: [],
    },
  };
}
function mock(
  opts: {
    unknown?: boolean;
    mutate?: (c: FrameworkCandidate, i: Input) => FrameworkCandidate;
    auditWarning?: boolean;
    auditFailure?: () => boolean;
    beforeGenerate?: () => Promise<void>;
  } = {},
) {
  const calls: {
    phase: string;
    controls: unknown;
    input: unknown;
  }[] = [];
  const gateway: FrameworkGateway = {
    extract: async (args) => {
      const audit = (args.schema as unknown) === FrameworkAudit;
      const input = JSON.parse(args.text);
      calls.push({ phase: audit ? "audit" : "generation", controls: args.controls, input });
      if (audit && opts.auditFailure?.()) throw new Error("PROVIDER_FAILED");
      if (!audit) await opts.beforeGenerate?.();
      const out = audit
        ? {
            input_hash: input.input_hash,
            candidate_hash: input.candidate_hash,
            source_ids: input.source_ids,
            checks: assertions(input.candidate).map((a) => ({
              assertion_id: a.id,
              supported: true,
              safe: true,
              findings: [],
            })),
            findings: opts.auditWarning ? ["Warning blocks publication"] : [],
          }
        : (opts.mutate?.(candidate(input, opts.unknown), input) ?? candidate(input, opts.unknown));
      await args.controls?.captureRawOutput?.(JSON.stringify(out));
      return args.schema.parse(out);
    },
  };
  return { gateway, calls };
}
async function setup(
  d = definition(),
  opts: {
    budget?: number;
    gateway?: FrameworkGateway;
    draft?: boolean;
    timeout?: number;
  } = {},
) {
  const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), "findme-u4-synthetic-"));
  dirs.push(dir);
  const repository = new PrivateFrameworkRepository(dir, "owner-A");
  const service = new FrameworkService({
    repository,
    ownerKey: "owner-A",
    definitions: [d],
    gateway: opts.gateway,
    allowInternalDraft: opts.draft,
    u4CallBudget: opts.budget ?? 80,
    timeoutMs: opts.timeout ?? 1000,
  });
  return { service, repository, dir };
}
let sequence = 0;
const key = () => `synthetic-${++sequence}`;
async function start(s: FrameworkService, d: FrameworkDefinition) {
  return s.start(
    { key: d.key, definition_version: d.version, definition_hash: d.content_hash },
    key(),
  );
}
type View = Awaited<ReturnType<FrameworkService["get"]>>;
async function answer(s: FrameworkService, r: View, text?: string) {
  return s.respond(
    r.id,
    {
      expected_version: r.version,
      question_id: required(r.open_question).id,
      text: text ?? `Synthetic practice ${required(r.open_question).domain} ${r.version} 🙂`,
    },
    key(),
  );
}
async function advance(s: FrameworkService, r: View, recovery = false) {
  return s.continue(r.id, { expected_version: r.version, recovery }, key());
}
async function finish(s: FrameworkService, d: FrameworkDefinition) {
  let r = await start(s, d);
  for (let n = 0; n < 30 && r.status !== "completed"; n++)
    r = r.open_question ? await answer(s, r) : await advance(s, r);
  return r;
}
describe("bounded private U4 framework runtime", () => {
  it("immutable definition binding and explicit accurate draft gate", async () => {
    const { service, repository } = await setup(human3Draft);
    expect((await service.catalog()).definitions[0]).toMatchObject({
      available: false,
      blocked_reason: "DRAFT_DISABLED",
    });
    await expect(start(service, human3Draft)).rejects.toThrow("DRAFT_DISABLED");
    const internal = new FrameworkService({
      repository,
      ownerKey: "owner-A",
      definitions: [human3Draft],
      allowInternalDraft: true,
    });
    const r = await start(internal, human3Draft);
    expect(r.protocol_status).toBe("draft_adaptation");
    expect(r.definition.publication_status).toBe("draft");
    const changed = defineFramework({ ...human3Draft, title: "Changed" });
    const drift = new FrameworkService({
      repository,
      ownerKey: "owner-A",
      definitions: [changed],
      allowInternalDraft: true,
    });
    await expect(drift.get(r.id)).rejects.toThrow("DEFINITION_DRIFT");
    expect(
      () =>
        new FrameworkService({
          repository,
          ownerKey: "owner-A",
          definitions: [{ ...human3Draft, title: "Tampered" }],
        }),
    ).toThrow("DEFINITION_HASH_MISMATCH");
    await expect(
      internal.start(
        {
          key: human3Draft.key,
          definition_version: human3Draft.version,
          definition_hash: human3Draft.content_hash,
          mode: "history_adapted",
        },
        key(),
      ),
    ).rejects.toThrow("HISTORY_ADAPTATION_DISABLED");
  });
  it("start/respond zero model calls, UTF16 exact save, reload, idempotent versions/conflicts", async () => {
    const d = definition();
    const m = mock();
    const { service, repository, dir } = await setup(d, { gateway: m.gateway });
    const k = key();
    const body = { key: d.key, definition_version: d.version, definition_hash: d.content_hash };
    const initial = await service.start(body, k);
    expect((await service.start(body, k)).version).toBe(1);
    const text = "  synthetic 🙂 practice  ";
    const k2 = key();
    const input = { expected_version: 1, question_id: required(initial.open_question).id, text };
    const saved = await service.respond(initial.id, input, k2);
    expect(saved.version).toBe(2);
    expect(saved.open_question).toBeNull();
    expect(m.calls).toHaveLength(0);
    expect((await service.respond(initial.id, input, k2)).version).toBe(2);
    await expect(service.respond(initial.id, { ...input, text: "changed" }, k2)).rejects.toThrow(
      "IDEMPOTENCY_CONFLICT",
    );
    await expect(service.respond(initial.id, input, key())).rejects.toThrow("STALE_RUN_VERSION");
    expect(
      required((await new PrivateFrameworkRepository(dir, "owner-A").read()).runs[0]).answers[0],
    ).toMatchObject({ text, end: text.length, start: 0 });
    expect((await repository.read()).u4_calls_reserved).toBe(0);
  });
  it("one question, no blank/skip/duplicate count; configured min/max and unknown at cap", async () => {
    const d = definition(2, 2);
    const m = mock({ unknown: true });
    const { service } = await setup(d, { gateway: m.gateway });
    let r = await start(service, d);
    await expect(advance(service, r)).rejects.toThrow("ANSWER_PENDING");
    for (const [text, skipped, error] of [
      [" ", false, "ANSWER_REQUIRED"],
      ["x", true, "SKIPPED_ANSWER_MUST_BE_EMPTY"],
    ] as const)
      await expect(
        service.respond(
          r.id,
          { expected_version: r.version, question_id: required(r.open_question).id, text, skipped },
          key(),
        ),
      ).rejects.toThrow(error);
    r = await answer(service, r, "First practice");
    r = await advance(service, r);
    expect(r.open_question).not.toBeNull();
    expect(r.assessments).toHaveLength(0);
    await expect(answer(service, r, "First practice")).rejects.toThrow("DUPLICATE_ANSWER");
    r = await answer(service, r, "Second practice");
    r = await advance(service, r);
    expect(r.assessments[0]).toMatchObject({
      evidence_status: "unknown",
      level: null,
      phase: null,
    });
    expect(required(r.open_question).domain).toBe("body");
    expect((required(m.calls[2]).input as Input).stage).toBe("evaluation");
  });
  it("accepts an empty skip without treating it as an answer or calling a model", async () => {
    const d = definition(2, 2);
    const m = mock();
    const { service } = await setup(d, { gateway: m.gateway });
    const initial = await start(service, d);
    const question = required(initial.open_question);
    const input = {
      expected_version: initial.version,
      question_id: question.id,
      text: "",
      skipped: true,
    };
    const idempotencyKey = key();
    const saved = await service.respond(initial.id, input, idempotencyKey);
    expect(saved.answers).toHaveLength(0);
    expect(saved.skipped_questions).toHaveLength(1);
    expect(saved.skipped_questions[0]).toMatchObject({
      question_id: question.id,
      domain: question.domain,
    });
    expect(saved.open_question).toBeNull();
    expect(m.calls).toHaveLength(0);
    expect(
      (await service.respond(initial.id, input, idempotencyKey)).skipped_questions,
    ).toHaveLength(1);
  });
  it("no cross-quadrant evidence laundering; rejected candidate retained privately", async () => {
    const d = definition();
    const m = mock({
      mutate: (c, i) => {
        if (c.kind === "evaluation" && c.assessment.domain === "body")
          c.assessment.rationale = claim(
            "rationale",
            i.answers.filter((a) => a.domain === "mind"),
          );
        return c;
      },
    });
    const { service, repository } = await setup(d, { gateway: m.gateway });
    let r = await start(service, d);
    r = await answer(service, r);
    r = await advance(service, r);
    r = await answer(service, r);
    r = await advance(service, r);
    expect(r.error).toBe("INVALID_EXACT_EVIDENCE");
    expect(r.assessments).toHaveLength(1);
    expect(r.result).toBeNull();
    expect(required((await repository.read()).jobs.at(-1)).candidate).not.toBeNull();
  });
  it("save/adaptive probes/four audited domains/audited synthesis/reload end to end", async () => {
    const d = definition(2, 3);
    const m = mock();
    const { service, dir, repository } = await setup(d, { gateway: m.gateway });
    const r = await finish(service, d);
    expect(r.status).toBe("completed");
    expect(r.answers).toHaveLength(8);
    expect(required(r.result).domains).toHaveLength(4);
    expect(required(r.result).synthesis.plans.map((p) => p.horizon)).toEqual(d.plan_horizons);
    expect(m.calls).toHaveLength(18);
    expect(m.calls.filter((c) => c.phase === "audit")).toHaveLength(9);
    for (const c of m.calls) expect(c.controls).toMatchObject({ retries: 0, timeoutMs: 1000 });
    for (let n = 0; n < m.calls.length; n += 2)
      expect(
        (
          required(m.calls[n + 1]).input as {
            input: unknown;
          }
        ).input,
      ).toEqual(required(m.calls[n]).input);
    const reload = new FrameworkService({
      repository: new PrivateFrameworkRepository(dir, "owner-A"),
      ownerKey: "owner-A",
      definitions: [d],
    });
    expect((await reload.get(r.id)).result).toEqual(r.result);
    expect((await repository.read()).u4_calls_reserved).toBe(18);
  });
  it("all audit warnings and unsupported level/horizon prevent publication", async () => {
    const d = definition();
    const m = mock({ auditWarning: true });
    const a = await setup(d, { gateway: m.gateway });
    let r = await answer(a.service, await start(a.service, d));
    r = await advance(a.service, r);
    expect(r.error).toBe("AUDIT_REJECTED");
    expect(r.assessments).toHaveLength(0);
    await expect(advance(a.service, r, true)).rejects.toThrow("SEMANTIC_REJECTION_REQUIRES_CHANGE");
    const score = mock({
      mutate: (c) => {
        if (c.kind === "evaluation") c.assessment.level = "2_7";
        return c;
      },
    });
    const b = await setup(d, { gateway: score.gateway });
    r = await answer(b.service, await start(b.service, d));
    r = await advance(b.service, r);
    expect(r.error).toBe("UNDEFINED_LEVEL");
    const horizon = mock({
      mutate: (c) => {
        if (c.kind === "synthesis") required(c.synthesis.plans[0]).horizon = "5years";
        return c;
      },
    });
    const c = await setup(d, { gateway: horizon.gateway });
    let p = await start(c.service, d);
    for (let n = 0; n < 4; n++) {
      p = await answer(c.service, p);
      p = await advance(c.service, p);
    }
    p = await advance(c.service, p);
    expect(p.status).toBe("active");
    expect(p.error).toBe("UNDEFINED_PLAN_HORIZON");
    expect(p.result).toBeNull();
  });
  it("independent U4 cumulative budget preflight/no retry/raw/explicit accepted checkpoint recovery", async () => {
    const d = definition();
    const m = mock();
    const a = await setup(d, { gateway: m.gateway, budget: 1 });
    let r = await answer(a.service, await start(a.service, d));
    await expect(advance(a.service, r)).rejects.toThrow("U4_BUDGET_EXHAUSTED");
    expect(m.calls).toHaveLength(0);
    expect((await a.repository.read()).u4_calls_reserved).toBe(0);
    let fails = true;
    const m2 = mock({ auditFailure: () => fails });
    const b = await setup(d, { gateway: m2.gateway, budget: 3 });
    r = await answer(b.service, await start(b.service, d));
    r = await advance(b.service, r);
    expect(r.error).toBe("PROVIDER_FAILED");
    expect(r.recovery_required).toBe(true);
    expect(m2.calls).toHaveLength(2);
    await expect(advance(b.service, r)).rejects.toThrow("EXPLICIT_RECOVERY_REQUIRED");
    fails = false;
    r = await advance(b.service, r, true);
    expect(r.assessments).toHaveLength(1);
    expect(m2.calls).toHaveLength(3);
    expect(required(m2.calls[2]).phase).toBe("audit");
    const s = await b.repository.read();
    expect(required(s.attempts[0]).raw).toContain("evaluation");
    expect(required(s.attempts[1]).status).toBe("error");
    expect(s.u4_calls_reserved).toBe(3);
    // An accepted audit is a reusable checkpoint when only publication was interrupted.
    const ready = mock();
    const checkpoint = await setup(d, { gateway: ready.gateway, budget: 2 });
    let interruptPublication = true;
    const interrupted: FrameworkRepository = {
      read: () => checkpoint.repository.read(),
      update: (fn) =>
        checkpoint.repository.update(async (state) => {
          const before = state.runs.reduce((n, run) => n + run.assessments.length, 0);
          const result = await fn(state);
          if (
            interruptPublication &&
            state.runs.reduce((n, run) => n + run.assessments.length, 0) > before
          ) {
            interruptPublication = false;
            throw new Error("SYNTHETIC_PUBLICATION_INTERRUPTED");
          }
          return result;
        }),
    };
    const interruptedService = new FrameworkService({
      repository: interrupted,
      ownerKey: "owner-A",
      definitions: [d],
      gateway: ready.gateway,
      u4CallBudget: 2,
    });
    let pending = await answer(interruptedService, await start(interruptedService, d));
    pending = await advance(interruptedService, pending);
    expect(pending.error).toBe("SYNTHETIC_PUBLICATION_INTERRUPTED");
    const offlineRecovery = new FrameworkService({
      repository: checkpoint.repository,
      ownerKey: "owner-A",
      definitions: [d],
      u4CallBudget: 2,
    });
    pending = await advance(offlineRecovery, pending, true);
    expect(pending.assessments).toHaveLength(1);
    expect(ready.calls).toHaveLength(2);
  });
  it("timeout keeps late raw but never publishes late candidate", async () => {
    const d = definition();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const m = mock({ beforeGenerate: () => wait });
    const { service, repository } = await setup(d, { gateway: m.gateway, timeout: 20 });
    let r = await answer(service, await start(service, d));
    r = await advance(service, r);
    expect(r.error).toBe("PROVIDER_TIMEOUT");
    expect(r.assessments).toHaveLength(0);
    release();
    await expect
      .poll(async () => required((await repository.read()).attempts[0]).raw, {
        timeout: 2000,
        interval: 10,
      })
      .toContain("evaluation");
    expect((await service.get(r.id)).assessments).toHaveLength(0);
    expect(required((await repository.read()).attempts[0]).raw).toContain("evaluation");
    expect(required((await repository.read()).attempts[0]).status).toBe("error");
  });
  it("concurrent amend/exclude/abandon forbids late publish and invalid report/evidence is redacted", async () => {
    const d = definition();
    for (const action of ["correct", "exclude", "abandon"] as const) {
      let release!: () => void;
      let began!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      const m = mock({
        beforeGenerate: async () => {
          began();
          await wait;
        },
      });
      const { service } = await setup(d, { gateway: m.gateway });
      const saved = await answer(service, await start(service, d));
      const pending = advance(service, saved);
      await started;
      let current = await service.get(saved.id);
      if (action === "abandon")
        current = await service.abandon(current.id, { expected_version: current.version }, key());
      else
        current = await service.amend(
          current.id,
          {
            expected_version: current.version,
            source_id: required(current.answers[0]).id,
            action,
            ...(action === "correct" ? { text: "Corrected input" } : {}),
            reason: "Owner correction",
          },
          key(),
        );
      release();
      await pending;
      const after = await service.get(saved.id);
      expect(after.result).toBeNull();
      expect(after.assessments).toHaveLength(0);
      expect(m.calls).toHaveLength(1);
      if (action !== "abandon") {
        expect(after.status).toBe("needs_review");
        expect(required(after.answers[0]).text).toBeNull();
      }
      await expect(service.evidence(after.id, required(saved.answers[0]).id)).rejects.toThrow(
        "SOURCE_NOT_AVAILABLE",
      );
    }
    const m = mock();
    const { service } = await setup(d, { gateway: m.gateway });
    const completed = await finish(service, d);
    const changed = await service.amend(
      completed.id,
      {
        expected_version: completed.version,
        source_id: required(completed.answers[0]).id,
        action: "exclude",
        reason: "Exclude",
      },
      key(),
    );
    expect(changed.status).toBe("needs_review");
    expect(changed.result).toBeNull();
    expect(required(changed.answers[0]).text).toBeNull();
  });
  it("serializes competing saves and enforces protocol/cross-domain support independently of audit", async () => {
    const d = definition(2, 2);
    const m = mock();
    const { service, repository } = await setup(d, { gateway: m.gateway });
    const initial = await start(service, d);
    const competing = await Promise.allSettled([
      answer(service, initial, "First competing answer"),
      answer(service, initial, "Second competing answer"),
    ]);
    expect(competing.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(required((await repository.read()).runs[0]).answers).toHaveLength(1);
    expect(
      (competing.find((x) => x.status === "rejected") as PromiseRejectedResult).reason.message,
    ).toBe("STALE_RUN_VERSION");
    const early = mock({
      mutate: (c, i) => (i.stage === "question" ? candidate({ ...i, stage: "evaluation" }) : c),
    });
    const a = await setup(d, { gateway: early.gateway });
    let r = await answer(a.service, await start(a.service, d));
    r = await advance(a.service, r);
    expect(r.error).toBe("DOMAIN_MINIMUM_NOT_MET");
    expect(early.calls).toHaveLength(2);
    const one = definition();
    const excessive = mock({
      mutate: (c, i) =>
        c.kind === "evaluation"
          ? {
              kind: "question",
              domain: required(i.definition.domains[i.domain_index]).key,
              text: "Over the cap?",
              intent: claim("intent", i.answers),
            }
          : c,
    });
    const b = await setup(one, { gateway: excessive.gateway });
    r = await answer(b.service, await start(b.service, one));
    r = await advance(b.service, r);
    expect(r.error).toBe("QUESTION_PROTOCOL_VIOLATION");
    const laundering = mock({
      mutate: (c, i) => {
        if (c.kind === "synthesis")
          required(c.synthesis.cross_domain_links[0]).assessment = claim(
            "link",
            i.answers.filter((a) => a.domain === "mind"),
            "hypothesis",
          );
        return c;
      },
    });
    const c = await setup(one, { gateway: laundering.gateway });
    r = await start(c.service, one);
    for (let n = 0; n < 4; n++) {
      r = await answer(c.service, r);
      r = await advance(c.service, r);
    }
    r = await advance(c.service, r);
    expect(r.error).toBe("CROSS_DOMAIN_EVIDENCE_REQUIRED");
    expect(r.result).toBeNull();
  });
  it("owner bearer and exact evidence isolation reject foreign IDs/owner; no AV copying", async () => {
    const d = definition();
    const { service, dir } = await setup(d);
    const r = await answer(service, await start(service, d));
    const other = await start(service, d);
    await expect(service.evidence(other.id, required(r.answers[0]).id)).rejects.toThrow(
      "SOURCE_NOT_AVAILABLE",
    );
    await expect(service.get("foreign-run")).rejects.toThrow("RUN_NOT_FOUND");
    const foreign = new FrameworkService({
      repository: new PrivateFrameworkRepository(dir, "owner-B"),
      ownerKey: "owner-B",
      definitions: [d],
    });
    await expect(foreign.catalog()).rejects.toThrow("OWNER_SCOPE_MISMATCH");
    const routes = frameworkRoutes(service, {
      authorize: (req) => req.headers.get("Authorization") === "Bearer synthetic-owner",
    });
    expect((await routes.request("/definitions")).status).toBe(401);
    const headers = { Authorization: "Bearer synthetic-owner" };
    expect((await routes.request("/definitions", { headers })).status).toBe(200);
    const response = await routes.request(`/runs/${r.id}/evidence/${required(r.answers[0]).id}`, {
      headers,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: required(r.answers[0]).text,
      offset_unit: "UTF-16",
    });
    expect(await readFile(path.join(dir, "frameworks", "state.json"), "utf8")).not.toContain(
      "raw.json",
    );
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("SYNTHETIC_FIXTURE_MISSING");
  return value;
}
