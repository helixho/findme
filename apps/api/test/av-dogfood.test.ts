import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DogfoodEngine, batchView, exactSpanSchema } from "../src/dogfood/engine.js";
import { type RawSession, selectSessions } from "../src/dogfood/freeze.js";
import { chunks, hash, qualified } from "../src/dogfood/model.js";
import { createDogfoodApp, metadata, reviewedPackage } from "../src/dogfood/server.js";
import { BatchStore } from "../src/dogfood/store.js";
import { createGateway } from "../src/llm/gateway.js";

const provider = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  return {
    ...actual,
    default: class {
      static APIConnectionTimeoutError = actual.default.APIConnectionTimeoutError;
      static AuthenticationError = actual.default.AuthenticationError;
      static NotFoundError = actual.default.NotFoundError;
      static RateLimitError = actual.default.RateLimitError;
      static BadRequestError = actual.default.BadRequestError;
      static APIError = actual.default.APIError;
      chat = { completions: { create: provider.create } };
    },
  };
});
const folders: string[] = [];
beforeEach(() => {
  provider.create.mockReset();
});
afterEach(async () => {
  await Promise.all(folders.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const response = (value: unknown) => ({
  choices: [{ message: { content: JSON.stringify(value) } }],
  usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26, prompt_cache_hit_tokens: 3 },
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic fixture");
  return value;
}
type RequestBody = { messages: { content: string }[]; model: string; max_tokens: number };
type Payload = {
  SOURCE: { offset: number; end: number; text: string; role: string };
  CONTEXT: unknown;
  channel: string;
  scope: string[];
  evidence: { source: { text?: string } }[];
  sources: { role: string }[];
  existing: unknown[];
  reviewedAttributions: unknown[];
  feedback: { independentProof: boolean }[];
};
const payload = (request: RequestBody): Payload =>
  JSON.parse(required(request.messages.at(-1)).content);
const defaultExtract = (request: RequestBody) => {
  const p = payload(request);
  return response({
    spans: [
      {
        start: p.SOURCE.offset,
        end: p.SOURCE.end,
        quote: p.SOURCE.text,
        author: "subject",
        about: "self",
        stance: "explicit",
        kind: "evaluation",
        uncertainty: "model candidate",
      },
    ],
  });
};
async function fixture(text = "I prefer a limited, reversible choice.", followup = false) {
  const folder = await mkdtemp(path.join(tmpdir(), "findme-av-synthetic-"));
  folders.push(folder);
  const input: RawSession[] = ["a", "b", "c", "d"].map((id, index) => ({
    id,
    sourceUuid: null,
    rootId: null,
    time: "2026-01-01",
    fingerprint: "",
    groupId: "",
    selectionReasons: [],
    messages: [
      { id: `${id}-context`, role: "assistant" as const, text: `AI context ${index}`, time: null },
      {
        id: `${id}-message`,
        role: "user" as const,
        text: `${text} [synthetic ${index}]`,
        time: "2026-01-01",
      },
      ...(followup
        ? [
            {
              id: `${id}-followup`,
              role: "user" as const,
              text: `I agree only with that particular point. [followup ${index}]`,
              time: "2026-01-01",
            },
          ]
        : []),
    ],
  }));
  const selected = selectSessions(input, 4, 1, "synthetic-seed");
  const manifest = {
    format: "findme-av-dogfood-v0.1",
    id: "synthetic-batch",
    createdAt: "2026-01-01",
    sourceFingerprint: hash(input),
    seed: "synthetic-seed",
    requestedSessions: 4,
    requestedHoldout: 1,
    sessions: selected.sessions,
    independence: "unknown",
    holdoutValidation: "pending",
  };
  await writeFile(path.join(folder, "raw.json"), JSON.stringify(selected.raw));
  await writeFile(path.join(folder, "manifest.json"), JSON.stringify(manifest));
  const store = new BatchStore(folder);
  const gateway = createGateway({
    deepseekKey: "synthetic-key-never-sent",
    mx2BaseUrl: "http://synthetic.invalid",
    deepseekModel: "synthetic-model@1",
  });
  const engine = new DogfoodEngine(store, gateway);
  const batch = await store.load();
  const dev = batch.sources.filter((s) => s.split === "dev" && s.role === "user");
  return { folder, store, engine, dev, source: required(dev[0]) };
}
async function extractOne(f: Awaited<ReturnType<typeof fixture>>) {
  provider.create.mockImplementation(defaultExtract);
  await f.engine.generate({
    operation: "extract",
    live: true,
    session: f.source.sessionId,
    maxCalls: 1,
  });
  return required((await f.store.load()).state.candidates[0]);
}
function proposal(evidence: string[], extra: Record<string, unknown> = {}) {
  return {
    action: "create",
    reuseId: null,
    kind: "pattern",
    mode: "observation",
    text: "A limited observation",
    scope: "Selected synthetic dev events only",
    evidence,
    counterevidence: [],
    rationale: "Direct selected expression",
    alternatives: ["Project-specific preference"],
    changeCondition: "A contrary event in the same scope",
    question: null,
    ...extra,
  };
}

describe("AV attribution and scope", () => {
  it("validates exact quotation/comment/third-person spans and keeps both selected and unchosen original", async () => {
    const f = await fixture(
      "Quoted: “I must always win.”\nMy comment: I only agree with trying.\nThey prefer certainty.",
    );
    const source = f.source;
    const chunk = required(chunks(source)[0]);
    const quote = "I must always win.";
    const comment = "I only agree with trying.";
    const third = "They prefer certainty.";
    const span = (text: string, author: string, about: string, kind: string) => ({
      start: source.text.indexOf(text),
      end: source.text.indexOf(text) + text.length,
      quote: text,
      author,
      about,
      kind,
      stance: "limited",
      uncertainty: "candidate",
    });
    const spans = [
      span(quote, "third_party", "unknown", "quotation"),
      span(comment, "subject", "self", "evaluation"),
      span(third, "subject", "third_party", "evaluation"),
    ];
    provider.create.mockReturnValue(response({ spans }));
    await f.engine.generate({
      operation: "extract",
      live: true,
      session: source.sessionId,
      maxCalls: 1,
    });
    const batch = await f.store.load();
    expect(batch.state.candidates.map((c) => c.author)).toEqual([
      "third_party",
      "subject",
      "subject",
    ]);
    expect(
      batch.state.candidates.every(
        (c) =>
          c.status === "candidate" &&
          c.judgedBy === "model_candidate" &&
          c.checksum === hash(c.quote),
      ),
    ).toBe(true);
    expect(batchView(batch).sources.find((s) => s.id === source.id)?.text).toBe(source.text);
    expect(
      exactSpanSchema(source, chunk).safeParse({ spans: [{ ...spans[0], quote: "invented" }] })
        .success,
    ).toBe(false);
    expect(
      exactSpanSchema(source, chunk).parse({
        spans: [{ ...spans[0], end: source.text.length + 1 }],
      }).spans[0],
    ).toEqual(spans[0]);
    expect(batch.manifest.independence).toBe("unknown");
  });
  it("extracts only dev user content, keeps chunks pending at call limit, never silently truncates raw", async () => {
    const f = await fixture("long synthetic forwarded text ".repeat(650));
    provider.create.mockImplementation((request) => response({ spans: [] }));
    await f.engine.generate({
      operation: "extract",
      live: true,
      session: f.source.sessionId,
      maxCalls: 1,
    });
    const batch = await f.store.load();
    const view = batchView(batch);
    const selected = required(view.sources.find((s) => s.id === f.source.id));
    expect(selected.text.length).toBeGreaterThan(14000);
    expect(selected.processing.filter((c) => c.status === "completed")).toHaveLength(1);
    expect(selected.processing.filter((c) => c.status === "pending").length).toBeGreaterThan(0);
    expect(provider.create.mock.calls.map(([r]) => payload(r).SOURCE.role)).toEqual(["user"]);
    const holdout = required(
      (await f.store.load()).manifest.sessions.find((s) => s.split === "holdout"),
    );
    await expect(
      f.engine.generate({ operation: "extract", live: true, session: holdout.id }),
    ).rejects.toThrow("DEV_SESSION_REQUIRED");
    expect(JSON.stringify(provider.create.mock.calls)).not.toContain(
      `[synthetic ${["a", "b", "c", "d"].indexOf(holdout.id)}]`,
    );
  });
  it("compares separate structured/raw products with the identical selected dev scope and model", async () => {
    const f = await fixture();
    const candidate = await extractOne(f);
    provider.create.mockImplementation((request) => {
      const p = payload(request);
      return response({
        claims: [proposal([p.channel === "structured" ? candidate.id : f.source.id])],
        unknowns: ["Event independence unknown"],
      });
    });
    await f.engine.generate({ operation: "compare", live: true, maxCalls: 2 });
    const batch = await f.store.load();
    const calls = provider.create.mock.calls.slice(1).map(([r]) => r);
    expect(calls.map((r) => payload(r).channel)).toEqual(["structured", "baseline"]);
    expect(payload(calls[0]).scope).toEqual(payload(calls[1]).scope);
    expect(calls.map((r) => r.model)).toEqual(["synthetic-model@1", "synthetic-model@1"]);
    expect(payload(calls[0]).evidence[0].source.text).toBeUndefined();
    expect(payload(calls[1]).sources.some((s: { role: string }) => s.role === "assistant")).toBe(
      true,
    );
    expect(batch.state.claims.map((c) => c.channel)).toEqual(["structured", "baseline"]);
    expect(
      batch.state.claims.every((c) => c.independence === "unknown" && c.status === "candidate"),
    ).toBe(true);
    const before = provider.create.mock.calls.length;
    await new DogfoodEngine(
      f.store,
      createGateway({
        deepseekKey: "fake",
        mx2BaseUrl: "http://synthetic.invalid",
        deepseekModel: "synthetic-model@1",
      }),
    ).generate({ operation: "compare", live: true, maxCalls: 2 });
    expect(provider.create).toHaveBeenCalledTimes(before);
  });
});

describe("AV budgets, checkpoint and revisions", () => {
  it("reserves every failed parse attempt, records exact provider usage and blocks unchanged double spend", async () => {
    const f = await fixture();
    provider.create.mockReturnValue({
      choices: [{ message: { content: "invalid json" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
    await f.engine.generate({
      operation: "extract",
      live: true,
      session: f.source.sessionId,
      maxCalls: 2,
    });
    const batch = await f.store.load();
    expect(batch.state.usage.attempts).toHaveLength(2);
    expect(
      batch.state.usage.attempts.every(
        (a) => a.errorKind === "json_parse" && a.usage?.inputTokens === 10,
      ),
    ).toBe(true);
    expect(batch.state.usage.reservedInput).toBe(
      batch.state.usage.attempts.reduce((n, a) => n + a.serializedUtf8Bytes, 0),
    );
    expect(
      provider.create.mock.calls.every(
        ([body, options]) =>
          body.max_tokens === 2500 && options.maxRetries === 0 && options.timeout === 45000,
      ),
    ).toBe(true);
    await f.engine.generate({
      operation: "extract",
      live: true,
      session: f.source.sessionId,
      maxCalls: 2,
    });
    expect(provider.create).toHaveBeenCalledTimes(2);
  });
  it("stops before provider when conservative budget is exhausted and reports unprocessed content", async () => {
    const f = await fixture();
    provider.create.mockImplementation(defaultExtract);
    await f.store.update((b) => {
      b.state.usage.inputCap = 10;
    });
    await f.engine.generate({ operation: "extract", live: true, maxCalls: 2 });
    expect(provider.create).not.toHaveBeenCalled();
    const batch = await f.store.load();
    expect(batch.state.runs[0]?.error).toBe("BUDGET_EXHAUSTED");
    expect((await metadata(f.store)).pendingChunks).toBe(3);
  });
  it("resumes successful chunks without re-spend and persists owner review/idempotency across reload", async () => {
    const f = await fixture("large synthetic ".repeat(900));
    provider.create.mockReturnValue(response({ spans: [] }));
    await f.engine.generate({
      operation: "extract",
      live: true,
      session: f.source.sessionId,
      maxCalls: 1,
    });
    await f.engine.generate({
      operation: "extract",
      live: true,
      session: f.source.sessionId,
      maxCalls: 1,
    });
    expect(provider.create).toHaveBeenCalledTimes(2);
    expect((await f.store.load()).state.runs.filter((r) => r.status === "completed")).toHaveLength(
      2,
    );
    const g = await fixture();
    const candidate = await extractOne(g);
    const version = (await g.store.load()).state.version;
    const input = {
      expectedVersion: version,
      idempotencyKey: "owner-correction",
      targetId: candidate.id,
      action: "correct" as const,
      author: "third_party" as const,
      about: "third_party" as const,
      note: "Original is their quotation",
    };
    await g.store.review(input);
    await new BatchStore(g.folder).review(input);
    const reloaded = await g.store.load();
    expect(reloaded.state.candidates[0]?.author).toBe("third_party");
    expect(reloaded.state.feedback).toHaveLength(1);
    await expect(g.store.review({ ...input, note: "conflicting body" })).rejects.toThrow(
      "IDEMPOTENCY_CONFLICT",
    );
    await expect(g.store.review({ ...input, idempotencyKey: "new-key" })).rejects.toThrow(
      "STALE_VERSION",
    );
  });
  it("invalidates only dependent claims immediately, while context/adoption is never independent proof", async () => {
    const f = await fixture();
    const candidate = await extractOne(f);
    await f.store.update((b) => {
      const template = {
        ...proposal([candidate.id]),
        id: "dependent",
        revision: 1,
        channel: "structured" as const,
        status: "candidate" as const,
        history: [],
        runId: "r",
        inputFingerprint: "f",
        independence: "unknown" as const,
      };
      b.state.claims.push(template, { ...template, id: "unrelated", evidence: ["other"] });
    });
    const before = (await f.store.load()).state.version;
    await f.store.review({
      expectedVersion: before,
      idempotencyKey: "not-mine",
      targetId: candidate.id,
      action: "correct",
      author: "third_party",
      note: "Quotation correction",
    });
    let batch = await f.store.load();
    expect(batch.state.claims.find((c) => c.id === "dependent")?.status).toBe("invalid");
    expect(batch.state.claims.find((c) => c.id === "unrelated")?.status).toBe("candidate");
    await f.store.review({
      expectedVersion: batch.state.version,
      idempotencyKey: "context",
      targetId: candidate.id,
      action: "context",
      note: "Reviewer supplement",
    });
    provider.create.mockImplementation((request) =>
      response({ claims: [], unknowns: ["No eligible evidence"] }),
    );
    await f.engine.generate({ operation: "compare", live: true, maxCalls: 2 });
    const baseline = provider.create.mock.calls
      .map(([r]) => payload(r))
      .find((p) => p.channel === "baseline");
    expect(baseline.reviewedAttributions[0]).toMatchObject({
      author: "third_party",
      about: "self",
      independentProof: false,
    });
    expect(
      baseline.feedback.every((v: { independentProof: boolean }) => v.independentProof === false),
    ).toBe(true);
    batch = await f.store.load();
    await f.store.review({
      expectedVersion: batch.state.version,
      idempotencyKey: "exclude-source",
      targetId: f.source.id,
      action: "exclude",
    });
    expect(
      batchView(await f.store.load()).sources.find((s) => s.id === f.source.id)?.review.excluded,
    ).toBe(true);
  });
  it("rejects a late model result after owner review without waiting on model availability", async () => {
    const f = await fixture();
    const candidate = await extractOne(f);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.create.mockImplementation(async () => {
      entered();
      await barrier;
      return response({ claims: [proposal([candidate.id])], unknowns: [] });
    });
    const generation = f.engine.generate({ operation: "synthesize", live: true, maxCalls: 1 });
    await started;
    const before = (await f.store.load()).state.version;
    await f.store.review({
      expectedVersion: before,
      idempotencyKey: "during-model",
      targetId: candidate.id,
      action: "exclude",
    });
    expect((await f.store.load()).state.candidates[0]?.status).toBe("excluded");
    release();
    await generation;
    const batch = await f.store.load();
    expect(batch.state.claims).toHaveLength(0);
    expect(batch.state.runs.at(-1)?.status).toBe("stale");
    expect(batch.state.usage.attempts.at(-1)?.status).toBe("ok");
  });
  it("differentiates contested interpretation from historical time-update and exports lineage only as staging", async () => {
    const f = await fixture();
    const candidate = await extractOne(f);
    provider.create.mockReturnValue(response({ claims: [proposal([candidate.id])], unknowns: [] }));
    await f.engine.generate({ operation: "synthesize", live: true, maxCalls: 1 });
    let batch = await f.store.load();
    const claim = required(batch.state.claims[0]);
    await f.store.review({
      expectedVersion: batch.state.version,
      idempotencyKey: "contested",
      targetId: claim.id,
      action: "contested",
      note: "Alternative interpretation",
    });
    batch = await f.store.load();
    expect(batch.state.claims[0]?.status).toBe("contested");
    await f.store.review({
      expectedVersion: batch.state.version,
      idempotencyKey: "time",
      targetId: claim.id,
      action: "time_update",
      note: "It was true then; now changed",
    });
    batch = await f.store.load();
    expect(batch.state.claims[0]?.status).toBe("historical");
    expect(batch.state.claims[0]?.history).toHaveLength(2);
    const exported = await reviewedPackage(f.store);
    expect(exported.publication).toBe("staging_only");
    expect(exported.officialCorePublished).toBe(false);
    expect(exported.lineage.length).toBeGreaterThan(0);
  });
  it("detects original mutation after checkpoint", async () => {
    const f = await fixture();
    await f.store.update(() => undefined);
    const raw = JSON.parse(await readFile(path.join(f.folder, "raw.json"), "utf8"));
    raw[0].messages[0].text = "tampered";
    await writeFile(path.join(f.folder, "raw.json"), JSON.stringify(raw));
    await expect(f.store.load()).rejects.toThrow("BATCH_INTEGRITY");
  });
  it("propagates preceding context review, skips excluded context, and cannot reuse a withdrawn claim", async () => {
    const f = await fixture("Yes, only this point.");
    const candidate = await extractOne(f);
    provider.create.mockReturnValue(response({ claims: [proposal([candidate.id])], unknowns: [] }));
    await f.engine.generate({ operation: "synthesize", live: true, maxCalls: 1 });
    let batch = await f.store.load();
    const claim = required(batch.state.claims[0]);
    const context = required(
      batch.sources.find((s) => s.sessionId === f.source.sessionId && s.role === "assistant"),
    );
    expect(batch.state.candidates[0]?.contextSourceIds).toEqual([context.id]);
    await f.store.review({
      expectedVersion: batch.state.version,
      idempotencyKey: "context-exclude",
      targetId: context.id,
      action: "exclude",
    });
    batch = await f.store.load();
    expect(batch.state.claims[0]?.status).toBe("invalid");
    expect(batch.state.candidates[0]?.provenanceStatus).toBe("stale");
    provider.create.mockImplementation(defaultExtract);
    await f.engine.generate({
      operation: "extract",
      live: true,
      session: f.source.sessionId,
      maxCalls: 1,
    });
    expect(payload(provider.create.mock.calls.at(-1)?.[0]).CONTEXT).toBeNull();
    batch = await f.store.load();
    expect(batch.state.candidates[0]?.provenanceStatus).toBe("current");
    await f.store.review({
      expectedVersion: batch.state.version,
      idempotencyKey: "withdraw",
      targetId: claim.id,
      action: "exclude",
    });
    provider.create.mockReturnValue(
      response({
        claims: [proposal([candidate.id], { action: "reuse", reuseId: claim.id })],
        unknowns: [],
      }),
    );
    await f.engine.generate({ operation: "synthesize", live: true, maxCalls: 1 });
    expect((await f.store.load()).state.claims[0]?.status).toBe("withdrawn");
    expect(payload(provider.create.mock.calls.at(-1)?.[0]).existing).toEqual([]);
  });
  it("recovers a dead process checkpoint conservatively and serializes stale-lock recovery", async () => {
    const f = await fixture();
    await extractOne(f);
    await f.store.update((batch) => {
      const run = required(batch.state.runs[0]);
      run.status = "running";
      run.ownerPid = 2147483647;
      required(batch.state.usage.attempts[0]).status = "reserved";
    });
    await f.store.recover();
    let batch = await f.store.load();
    expect(batch.state.runs[0]?.status).toBe("failed");
    expect(batch.state.usage.attempts[0]?.status).toBe("interrupted");
    const before = provider.create.mock.calls.length;
    await f.engine.generate({
      operation: "extract",
      live: true,
      session: f.source.sessionId,
      maxCalls: 1,
    });
    expect(provider.create).toHaveBeenCalledTimes(before);
    await mkdir(path.join(f.folder, ".staging-lock"));
    await writeFile(path.join(f.folder, ".staging-lock", "pid"), "2147483647");
    let active = 0;
    let maximum = 0;
    await Promise.allSettled(
      [f.store, new BatchStore(f.folder)].map((store) =>
        store.locked(async () => {
          active++;
          maximum = Math.max(maximum, active);
          await new Promise((r) => setTimeout(r, 20));
          active--;
        }),
      ),
    );
    expect(maximum).toBe(1);
    batch = await f.store.load();
    expect(batch.state.usage.attempts).toHaveLength(1);
  });
});

describe("AV focused final repair regressions", () => {
  it("resolves unique Unicode quotes without trusting numeric hints, but requires exact hints for ambiguity", async () => {
    const f = await fixture("前缀😀𠮷。我的选择：保留🙂与原文。重复 重复");
    const source = f.source;
    const chunk = required(chunks(source)[0]);
    const draft = {
      quote: "我的选择：保留🙂与原文。",
      author: "subject",
      about: "project",
      stance: "explicit preference",
      kind: "choice",
      uncertainty: "candidate",
    };
    const schema = exactSpanSchema(source, chunk);
    const expectedStart = source.text.indexOf(draft.quote);
    const expected = { ...draft, start: expectedStart, end: expectedStart + draft.quote.length };
    expect(schema.parse({ spans: [draft] }).spans).toEqual([expected]);
    expect(schema.parse({ spans: [{ ...draft, start: -9, end: 100000 }] }).spans).toEqual([
      expected,
    ]);
    expect(
      schema.safeParse({ spans: [{ ...draft, quote: `${draft.quote}invented` }] }).success,
    ).toBe(false);
    expect(schema.safeParse({ spans: [{ ...draft, quote: "重复" }] }).success).toBe(false);
    const start = source.text.lastIndexOf("重复");
    expect(
      schema.parse({ spans: [{ ...draft, quote: "重复", start, end: start + 2 }] }).spans[0]?.start,
    ).toBe(start);
    expect(
      schema.safeParse({ spans: [{ ...draft, quote: "重复", start: 0, end: 2 }] }).success,
    ).toBe(false);
    expect(
      exactSpanSchema(source, { ...chunk, start: expectedStart + draft.quote.length }).safeParse({
        spans: [draft],
      }).success,
    ).toBe(false);
    provider.create.mockReturnValue(response({ spans: [{ ...draft, start: 1, end: 2 }] }));
    expect(
      await f.engine.generate({
        operation: "extract",
        live: true,
        session: source.sessionId,
        maxCalls: 1,
      }),
    ).toMatchObject({ status: "completed", calls: 1 });
    expect((await f.store.load()).state.candidates[0]).toMatchObject(expected);
  });

  it("freezes identical successful ranges/context for both channels after a partial multi-session extraction", async () => {
    const f = await fixture("raw selected text ".repeat(1000));
    provider.create.mockImplementation(defaultExtract);
    const extraction = await f.engine.generate({ operation: "extract", live: true, maxCalls: 1 });
    expect(extraction).toMatchObject({ status: "partial", completedRuns: 1 });
    const before = await f.store.load();
    const c = required(before.state.candidates[0]);
    const source = required(before.sources.find((s) => s.id === c.sourceId));
    expect(before.state.scope).toHaveLength(3);
    provider.create.mockImplementation((request) => {
      const p = payload(request);
      return response({
        claims:
          p.channel === "structured"
            ? [proposal([c.id], { text: "GENERATED_STRUCTURED_OPINION" })]
            : [],
        unknowns: [],
      });
    });
    await f.engine.generate({ operation: "compare", live: true, maxCalls: 2 });
    const [structured, baseline] = provider.create.mock.calls
      .slice(1)
      .map(([r]) => JSON.parse(r.messages.at(-1).content));
    expect(structured.coverage).toEqual(baseline.coverage);
    expect(structured.coverage).toEqual([
      { sourceId: source.id, start: 0, end: 7000, fingerprint: hash(source.text.slice(0, 7000)) },
    ]);
    expect(structured.sourceContext).toEqual(baseline.sourceContext);
    expect(structured.sourceContext[0].text.length).toBeLessThanOrEqual(2000);
    expect(
      baseline.sources
        .filter((s: { purpose: string }) => s.purpose === "processed_expression")
        .map((s: { text: string }) => s.text),
    ).toEqual([source.text.slice(0, 7000)]);
    expect(JSON.stringify(baseline)).not.toContain("GENERATED_STRUCTURED_OPINION");
    expect(structured.evidence[0].source.text).toBeUndefined();
    expect(structured.evidence[0].sourceId).toBe(source.id);
    const runs = (await f.store.load()).state.runs.filter((r) => r.operation !== "extract");
    expect(runs[0]?.comparisonScope).toEqual(runs[1]?.comparisonScope);
    expect(runs[0]?.comparisonScope?.attributionVersions[0]).toMatchObject({
      id: c.id,
      revision: c.revision,
    });
    expect(runs.every((r) => r.payloadFingerprint && r.thinkingMode === "disabled")).toBe(true);
    expect(provider.create.mock.calls.every(([r]) => r.thinking?.type === "disabled")).toBe(true);
  });

  it("does not compare failed/unprocessed selections or pretend an empty coverage is completed", async () => {
    const f = await fixture();
    provider.create.mockRejectedValue(new Error("private provider detail"));
    expect(
      await f.engine.generate({
        operation: "extract",
        live: true,
        session: f.source.sessionId,
        maxCalls: 1,
      }),
    ).toMatchObject({ completedRuns: 0, failedRuns: 1, idempotent: false });
    await expect(
      f.engine.generate({ operation: "compare", live: true, maxCalls: 2 }),
    ).rejects.toThrow("PROCESSED_SCOPE_REQUIRED");
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it("retries a billed failure only explicitly, preserves prior attempts, and never returns failed idempotency as success", async () => {
    const f = await fixture();
    const opts = {
      operation: "extract" as const,
      live: true,
      session: f.source.sessionId,
      maxCalls: 2,
      expectedVersion: 1,
      idempotencyKey: "failed-input",
    };
    provider.create.mockRejectedValue(new Error("secret provider response"));
    expect(await f.engine.generate(opts)).toMatchObject({
      status: "failed",
      calls: 2,
      retryRequired: true,
    });
    const before = (await f.store.load()).state;
    expect(await f.engine.generate(opts)).toMatchObject({
      status: "retry_required",
      calls: 0,
      idempotent: false,
    });
    expect(provider.create).toHaveBeenCalledTimes(2);
    provider.create.mockImplementation(defaultExtract);
    expect(await f.engine.generate({ ...opts, retryFailed: true })).toMatchObject({
      status: "completed",
      calls: 1,
    });
    const after = (await f.store.load()).state;
    expect(after.runs).toHaveLength(2);
    expect(after.runs[0]).toEqual(before.runs[0]);
    expect(after.runs[1]?.retryOf).toBe(before.runs[0]?.id);
    expect(after.usage.attempts.slice(0, 2)).toEqual(before.usage.attempts);
    expect(after.usage.attempts[2]?.runId).toBe(after.runs[1]?.id);
    expect(after.usage.reservedInput).toBeGreaterThan(before.usage.reservedInput);
    expect(JSON.stringify(after)).not.toContain("secret provider response");
    expect(await f.engine.generate(opts)).toMatchObject({
      status: "completed",
      calls: 0,
      idempotent: true,
    });
  });

  it("resumes a reservation-only failure without requiring another spend approval flag", async () => {
    const f = await fixture();
    const opts = {
      operation: "extract" as const,
      live: true,
      session: f.source.sessionId,
      maxCalls: 1,
      idempotencyKey: "no-request",
    };
    await f.store.update((b) => {
      b.state.usage.inputCap = 1;
    });
    provider.create.mockImplementation(defaultExtract);
    expect(await f.engine.generate(opts)).toMatchObject({
      status: "failed",
      calls: 0,
      retryRequired: false,
    });
    await f.store.update((b) => {
      b.state.usage.inputCap = 200000;
    });
    expect(await f.engine.generate(opts)).toMatchObject({ status: "completed", calls: 1 });
    const state = (await f.store.load()).state;
    expect(state.runs).toHaveLength(2);
    expect(state.usage.attempts).toHaveLength(1);
    expect(state.runs[0]?.error).toBe("BUDGET_EXHAUSTED");
  });

  it("reports a live run busy without duplicating requests; expired leases need explicit retry and reject late output", async () => {
    const f = await fixture();
    let release!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    provider.create.mockImplementation(async (request) => {
      enter();
      await barrier;
      return defaultExtract(request);
    });
    const opts = {
      operation: "extract" as const,
      live: true,
      session: f.source.sessionId,
      maxCalls: 1,
      idempotencyKey: "busy",
    };
    const first = f.engine.generate(opts);
    await entered;
    expect(await f.engine.generate({ ...opts, retryFailed: true })).toMatchObject({
      status: "busy",
      calls: 0,
    });
    expect(provider.create).toHaveBeenCalledTimes(1);
    await f.store.update((b) => {
      required(b.state.runs[0]).leaseExpiresAt = "2000-01-01T00:00:00Z";
    });
    await f.store.recover();
    expect(await f.engine.generate(opts)).toMatchObject({ status: "retry_required", calls: 0 });
    release();
    await first;
    expect((await f.store.load()).state.candidates).toHaveLength(0);
    provider.create.mockImplementation(defaultExtract);
    expect(await f.engine.generate({ ...opts, retryFailed: true })).toMatchObject({
      status: "completed",
      calls: 1,
    });
    expect((await f.store.load()).state.runs).toHaveLength(2);
  });

  it("source context changes stale its extraction and omitted old spans cannot return as evidence", async () => {
    const f = await fixture();
    const c = await extractOne(f);
    provider.create.mockReturnValue(response({ claims: [proposal([c.id])], unknowns: [] }));
    await f.engine.generate({ operation: "synthesize", live: true, maxCalls: 1 });
    const before = await f.store.load();
    await f.store.review({
      expectedVersion: before.state.version,
      idempotencyKey: "source-context",
      targetId: f.source.id,
      action: "context",
      note: "This context changes attribution.",
    });
    let state = (await f.store.load()).state;
    expect(state.candidates[0]?.provenanceStatus).toBe("stale");
    expect(state.claims[0]?.status).toBe("invalid");
    expect(state.runs[0]?.status).toBe("stale");
    provider.create.mockReturnValue(response({ spans: [] }));
    await f.engine.generate({
      operation: "extract",
      live: true,
      session: f.source.sessionId,
      maxCalls: 1,
    });
    provider.create.mockImplementation((request) => {
      const p = JSON.parse(request.messages.at(-1).content);
      expect(p.evidence).toEqual([]);
      expect(p.context).toEqual([]);
      return response({ claims: [], unknowns: [] });
    });
    await f.engine.generate({ operation: "synthesize", live: true, maxCalls: 1 });
    state = (await f.store.load()).state;
    expect(state.candidates[0]?.provenanceStatus).toBe("stale");
  });

  it("preserves an owner correction on rerun and applies it to raw support eligibility symmetrically", async () => {
    const f = await fixture();
    const c = await extractOne(f);
    let state = (await f.store.load()).state;
    await f.store.review({
      expectedVersion: state.version,
      idempotencyKey: "owner-author",
      targetId: c.id,
      action: "correct",
      author: "third_party",
      note: "Forwarded words.",
    });
    state = (await f.store.load()).state;
    await f.store.review({
      expectedVersion: state.version,
      idempotencyKey: "rerun-context",
      targetId: f.source.id,
      action: "context",
      note: "Corrected provenance.",
    });
    provider.create.mockImplementation(defaultExtract);
    await f.engine.generate({
      operation: "extract",
      live: true,
      session: f.source.sessionId,
      maxCalls: 1,
    });
    const corrected = required((await f.store.load()).state.candidates[0]);
    expect(corrected).toMatchObject({
      author: "third_party",
      judgedBy: "owner",
      provenanceStatus: "current",
    });
    provider.create.mockImplementation((request) => {
      const p = JSON.parse(request.messages.at(-1).content);
      expect(p.reviewedAttributions[0]).toMatchObject({
        author: "third_party",
        independentProof: false,
      });
      if (p.channel === "structured") {
        expect(p.evidence).toEqual([]);
        return response({ claims: [], unknowns: [] });
      }
      expect(p.sources.find((s: { id: string }) => s.id === f.source.id).purpose).toBe(
        "context_only",
      );
      return response({ claims: [proposal([f.source.id])], unknowns: [] });
    });
    const result = await f.engine.generate({ operation: "compare", live: true, maxCalls: 2 });
    expect(result).toMatchObject({ status: "partial", completedRuns: 1, failedRuns: 1 });
    expect((await f.store.load()).state.claims).toEqual([]);
  });

  it("owner attribution changes in preceding user context invalidate only dependent extraction and claims", async () => {
    const f = await fixture("My original point.", true);
    const first = await extractOne(f);
    provider.create.mockImplementation(defaultExtract);
    await f.engine.generate({
      operation: "extract",
      live: true,
      session: f.source.sessionId,
      maxCalls: 1,
    });
    let state = (await f.store.load()).state;
    const second = required(state.candidates.find((c) => c.id !== first.id));
    expect(second.contextSourceIds).toEqual([first.sourceId]);
    provider.create.mockReturnValue(response({ claims: [proposal([second.id])], unknowns: [] }));
    await f.engine.generate({ operation: "synthesize", live: true, maxCalls: 1 });
    state = (await f.store.load()).state;
    await f.store.review({
      expectedVersion: state.version,
      idempotencyKey: "previous-owner",
      targetId: first.id,
      action: "correct",
      author: "third_party",
    });
    state = (await f.store.load()).state;
    expect(state.candidates.find((c) => c.id === second.id)?.provenanceStatus).toBe("stale");
    expect(state.candidates.find((c) => c.id === first.id)?.author).toBe("third_party");
    expect(state.claims[0]?.status).toBe("invalid");
    provider.create.mockImplementation(defaultExtract);
    await f.engine.generate({
      operation: "extract",
      live: true,
      session: f.source.sessionId,
      maxCalls: 1,
    });
    const prompt = JSON.parse(provider.create.mock.calls.at(-1)?.[0].messages.at(-1).content);
    expect(prompt.CONTEXT.reviewedAttributions[0]).toMatchObject({
      author: "third_party",
      revision: 2,
    });
    expect((await f.store.load()).state.candidates.find((c) => c.id === first.id)?.author).toBe(
      "third_party",
    );
  });

  it("rejects referent-only support and counterevidence in both channels", async () => {
    const f = await fixture();
    const c = await extractOne(f);
    const contextId = required(c.contextSourceIds?.[0]);
    provider.create.mockImplementation((request) => {
      const p = payload(request);
      return response({
        claims: [
          proposal([p.channel === "structured" ? c.id : f.source.id], {
            counterevidence: [contextId],
          }),
        ],
        unknowns: [],
      });
    });
    const result = await f.engine.generate({ operation: "compare", live: true, maxCalls: 4 });
    expect(result).toMatchObject({ completedRuns: 0, failedRuns: 2 });
    expect((await f.store.load()).state.claims).toEqual([]);
  });

  it("unrelated reviews do not recompute the selected scope or discard an in-flight result", async () => {
    const f = await fixture();
    const c = await extractOne(f);
    let release!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    provider.create.mockImplementation(async () => {
      enter();
      await barrier;
      return response({ claims: [proposal([c.id])], unknowns: [] });
    });
    const pending = f.engine.generate({ operation: "synthesize", live: true, maxCalls: 1 });
    await entered;
    const batch = await f.store.load();
    const unrelated = required(f.dev.find((s) => s.sessionId !== f.source.sessionId));
    await f.store.review({
      expectedVersion: batch.state.version,
      idempotencyKey: "unrelated-review",
      targetId: unrelated.id,
      action: "context",
      note: "Only another event.",
    });
    release();
    expect(await pending).toMatchObject({ status: "completed" });
    expect((await f.store.load()).state.claims[0]?.status).toBe("candidate");
    const count = provider.create.mock.calls.length;
    expect(
      await f.engine.generate({ operation: "synthesize", live: true, maxCalls: 1 }),
    ).toMatchObject({ status: "completed", calls: 0 });
    expect(provider.create).toHaveBeenCalledTimes(count);
  });

  it("retains the owner's explicit project/third-party evaluation while quotation and requirements remain ineligible", async () => {
    const f = await fixture("I choose this project. I dislike their approach.");
    const c = await extractOne(f);
    const state = (await f.store.load()).state;
    expect(
      qualified(state, { ...c, about: "project", kind: "choice", stance: "I choose this project" }),
    ).toBe(true);
    expect(
      qualified(state, {
        ...c,
        about: "third_party",
        kind: "evaluation",
        stance: "I dislike this approach",
      }),
    ).toBe(true);
    for (const kind of ["quotation", "work_requirement", "unknown"] as const)
      expect(qualified(state, { ...c, about: "project", kind })).toBe(false);
    expect(qualified(state, { ...c, about: "project", stance: "" })).toBe(false);
    expect(qualified(state, { ...c, author: "third_party", about: "project" })).toBe(false);
    await f.store.update((b) => {
      required(b.state.candidates[0]).about = "project";
    });
    provider.create.mockImplementation((request) => {
      const p = JSON.parse(request.messages.at(-1).content);
      expect(p.evidence[0]).toMatchObject({
        about: "project",
        supportScope: "explicit_owner_expression_only",
      });
      return response({
        claims: [proposal([c.id], { scope: "Only this owner's stated project choice" })],
        unknowns: [],
      });
    });
    expect(
      await f.engine.generate({ operation: "synthesize", live: true, maxCalls: 1 }),
    ).toMatchObject({ status: "completed" });
  });
});

describe("owner correction and export provenance regressions", () => {
  it("lets an owner correct an erroneous quotation kind back to a self report", async () => {
    const f = await fixture();
    const c = await extractOne(f);
    await f.store.update((batch) => {
      const item = batch.state.candidates.find((x) => x.id === c.id);
      if (item) {
        item.kind = "quotation";
        item.author = "third_party";
      }
    });
    let batch = await f.store.load();
    expect(qualified(batch.state, required(batch.state.candidates[0]))).toBe(false);
    await f.store.review({
      expectedVersion: batch.state.version,
      idempotencyKey: "restore-kind",
      targetId: c.id,
      action: "correct",
      author: "subject",
      about: "self",
      kind: "self_report",
      note: "This is my own statement, not a quote.",
    });
    batch = await f.store.load();
    expect(required(batch.state.candidates[0]).kind).toBe("self_report");
    expect(qualified(batch.state, required(batch.state.candidates[0]))).toBe(true);
    expect(required(batch.state.candidates[0]).judgedBy).toBe("owner");
  });
  it("exports the original message locator instead of only the staging hash", async () => {
    const f = await fixture();
    const c = await extractOne(f);
    const batch = await f.store.load();
    await f.store.review({
      expectedVersion: batch.state.version,
      idempotencyKey: "export-locator",
      targetId: c.id,
      action: "adopt",
    });
    const result = await reviewedPackage(f.store);
    const source = required(result.sources.find((s) => s.id === c.sourceId));
    expect(source.originalMessageId).toBe(`${f.source.sessionId}-message`);
    expect(source.originalSessionId).toBe(f.source.sessionId);
    expect(source.originalMessageId).not.toBe(source.id);
  });
});

describe("local provider switch after authentication-only failures", () => {
  it("permits a failed-only batch to use Codex but keeps its old failure ledger", async () => {
    const f = await fixture();
    await f.store.update((batch) => {
      batch.state.model = "failed-old-provider";
    });
    await extractOne(f);
    const batch = await f.store.load();
    expect(batch.state.model).toBe("synthetic-model@1");
    expect(batch.state.candidates.length).toBeGreaterThan(0);
  });
  it("rejects changing provider once any successful output exists", async () => {
    const f = await fixture();
    await extractOne(f);
    await f.store.update((batch) => {
      batch.state.model = "another-provider";
    });
    await expect(
      f.engine.generate({
        operation: "extract",
        live: true,
        maxCalls: 1,
        session: f.source.sessionId,
      }),
    ).rejects.toThrow("MODEL_VERSION_CHANGED");
  });
});

describe("AV local API protections", () => {
  it("GET never constructs gateway/generates; strict Host/Origin/nonce protect writes and paths are rejected", async () => {
    const f = await fixture();
    const factory = vi.fn(() => f.engine);
    const app = createDogfoodApp({ store: f.store, port: 8795, engine: factory });
    const get = () =>
      app.request("http://127.0.0.1:8795/api/dogfood/state", {
        headers: { host: "127.0.0.1:8795" },
      });
    const state = await (await get()).json();
    await get();
    expect(factory).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
    expect(JSON.stringify(state.sources)).not.toContain("holdout");
    const body = {
      expectedVersion: state.version,
      idempotencyKey: "api-review",
      targetId: f.source.id,
      action: "exclude",
    };
    const post = (headers: Record<string, string>, value: unknown = body) =>
      app.request("http://127.0.0.1:8795/api/dogfood/review", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(value),
      });
    expect(
      (
        await post({
          host: "evil.test",
          origin: "http://127.0.0.1:8795",
          "x-dogfood-nonce": state.nonce,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post({
          host: "127.0.0.1:8795",
          origin: "https://evil.test",
          "x-dogfood-nonce": state.nonce,
        })
      ).status,
    ).toBe(403);
    expect((await post({ host: "127.0.0.1:8795", origin: "http://127.0.0.1:8795" })).status).toBe(
      403,
    );
    const valid = {
      host: "127.0.0.1:8795",
      origin: "http://127.0.0.1:8795",
      "x-dogfood-nonce": state.nonce,
    };
    expect((await post(valid, { ...body, batch: "/private/arbitrary" })).status).toBe(400);
    expect((await post(valid)).status).toBe(200);
    const again = await (await get()).json();
    expect(
      again.sources.find((s: { id: string; review: { excluded: boolean } }) => s.id === f.source.id)
        ?.review.excluded,
    ).toBe(true);
    expect(factory).not.toHaveBeenCalled();
    expect(
      (
        await app.request("http://127.0.0.1:8795/api/dogfood/state", {
          headers: { host: "attacker.test" },
        })
      ).status,
    ).toBe(403);
  });
});
