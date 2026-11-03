import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type CoreReportSourceBinding, CoreReportTarget, UnderstandingReport } from "@findme/core";
import { type Db, coreSchema } from "@findme/db";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreError } from "../src/core/errors.js";
import { startExploration } from "../src/core/exploration-service.js";
import {
  type CoreReportBackend,
  rebindCoreReportSource,
  transferCoreReportSource,
  validateReportTarget,
} from "../src/core/report-bridge.js";
import {
  createCoreReportBackend,
  createCoreReportVerifier,
  eligibleReportSource,
} from "../src/core/report-source-service.js";
import { onError } from "../src/middleware/error.js";
import { coreRoutes } from "../src/routes/core.js";
import { nativeUnderstandingRoutes } from "../src/routes/understanding.js";
import { createPrivateCoreReportService } from "../src/understanding-app/core-adapter.js";
import { feedbackFact } from "../src/understanding-app/dependencies.js";
import { qualificationInput } from "../src/understanding-app/qualification.js";
import { type BaselineSnapshot, readBaseline } from "../src/understanding-app/read.js";
import { PrivateUnderstandingRepository } from "../src/understanding-app/repository.js";
import { Receipt, readState } from "../src/understanding-app/state.js";
import type { Selection } from "../src/understanding-baseline/prepare.js";
vi.mock("../src/understanding-app/read.js", () => ({ readBaseline: vi.fn() }));

const owner = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  subjectId: "00000000-0000-4000-8000-000000000002",
};
const explorationId = "00000000-0000-4000-8000-000000000003";
const sourceId = "00000000-0000-4000-8000-000000000004";
const target = CoreReportTarget.parse({
  baseline_version: "baseline-1",
  input_hash: "a".repeat(64),
  domain: "agency",
  report_version: "topic-1",
  finding_key: "finding-1",
  question: "合成待澄清判断",
});
const report = UnderstandingReport.parse({
  headline: "合成报告",
  current_understanding: {
    key: "finding-1",
    text: "合成待澄清判断",
    scope: "合成局部",
    evidence_ids: [],
    counterevidence_ids: [],
    context_ids: [],
    time: null,
    status: "unknown",
  },
  findings: [],
  resources_conditions_costs: [],
  alternatives: [],
  unknowns: ["没有足够输入"],
  question: { text: "合成问题", branches: ["情境甲", "情境乙"] },
  next_step: null,
  nodes: [],
  links: [],
});
const selection = {
  domain: "agency",
  scope: "synthetic only",
  evidence: [],
  omitted: [],
  selected_original_atoms: 0,
  canonical_count: 0,
  repair_inputs_unavailable: [],
  bytes: 2,
} as unknown as Selection;
const snapshot = {
  version: target.baseline_version,
  old: null,
  input: {
    input_hash: target.input_hash,
    inventory: {
      batch: {
        manifest: {
          cutoffBefore: "2026-01-01",
          sourceFingerprint: "synthetic",
        },
      },
    },
    fresh: async () => {},
  },
  baseline: {
    topics: [
      { domain: "agency", version: target.report_version, status: "ready_candidate", selection },
    ],
  },
  accepted: new Map([
    ["agency", { version: target.report_version, report, selection }],
    ["overall", { version: "overall-1", report, selection }],
  ]),
} as unknown as BaselineSnapshot;
function sourceFixture() {
  const now = new Date("2026-01-02T00:00:00Z");
  return {
    source: {
      id: sourceId,
      tenantId: owner.tenantId,
      subjectId: owner.subjectId,
      sourceKind: "native_event",
      authorKind: "subject",
      content: "我昨天在合成项目中先确认条件。",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      capturedAt: now,
      externalRef: null,
      sourceMeta: {},
      usageStatus: "active",
    },
    assessment: {
      id: "00000000-0000-4000-8000-000000000005",
      sourceItemId: sourceId,
      version: 1,
      attributionStatus: "confirmed_subject",
      contextCompleteness: "partial",
      temporalPrecision: "exact",
      eligibility: "eligible",
      rationale: "合成本人直接输入",
      isCurrent: true,
      supersedesId: null,
      createdAt: now,
    },
    turn: {
      id: "00000000-0000-4000-8000-000000000006",
      explorationId,
      questionId: null,
      sourceItemId: sourceId,
      role: "user",
      turnKind: "event",
      content: "我昨天在合成项目中先确认条件。",
      createdAt: now,
    },
    replaced: false,
  };
}
beforeEach(() => {
  vi.mocked(readBaseline).mockReset();
  vi.mocked(readBaseline).mockResolvedValue(snapshot);
});
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  // Synthetic files live in the platform temporary directory, never a private workspace.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "findme-core-report-")));
  temporary.push(dir);
  const paths = {
    repoRoot: path.join(dir, "repo"),
    batch: path.join(dir, "batch"),
    coverage: path.join(dir, "coverage"),
    baselineDir: path.join(dir, "baseline"),
    stateDir: path.join(dir, "state"),
  };
  await Promise.all(Object.values(paths).map((p) => mkdir(p, { recursive: true })));
  const row = sourceFixture();
  const backend: CoreReportBackend = {
    target: async (ctx) => {
      if (ctx.tenantId !== owner.tenantId || ctx.subjectId !== owner.subjectId)
        throw new Error("OWNER");
      return target;
    },
    source: async (ctx, id, sid) => {
      if (sid !== row.source.id) throw new Error("SOURCE");
      return eligibleReportSource(ctx, id, row);
    },
  };
  const source = await backend.source(owner, explorationId, sourceId);
  const binding: CoreReportSourceBinding = {
    tenant_id: owner.tenantId,
    subject_id: owner.subjectId,
    exploration_id: explorationId,
    source_id: sourceId,
    assessment_version: 1,
    content_hash: source.content_hash,
    occurred_at: source.occurred_at,
    disclosed_at: source.disclosed_at,
    attribution_basis: source.attribution_basis,
  };
  const verifySource = vi.fn(async (b: CoreReportSourceBinding, note: string) => {
    const current = await backend.source(
      { tenantId: b.tenant_id, subjectId: b.subject_id },
      b.exploration_id,
      b.source_id,
    );
    if (
      current.content_hash !== b.content_hash ||
      current.assessment_version !== b.assessment_version ||
      current.content !== note
    )
      throw new CoreError("STALE_REPORT_SOURCE", 409, "合成来源变化");
  });
  const repository = new PrivateUnderstandingRepository({
    ...paths,
    coreBridge: { owner, verifySource },
  });
  const service = createPrivateCoreReportService(repository);
  const selected = {
    source_id: sourceId,
    assessment_version: 1,
    content_hash: source.content_hash,
  };
  return { paths, row, backend, binding, repository, service, selected, verifySource };
}

describe("explicit native Core/report bridge (synthetic, no DB/model)", () => {
  it("validates every target dimension, finding/question membership and never retargets", () => {
    const view = {
      baseline_version: target.baseline_version,
      input_hash: target.input_hash,
      overall: { version: "overall-1", report },
      topics: [{ domain: "agency", version: "topic-1", report }],
    };
    expect(validateReportTarget(view, target)).toEqual(target);
    for (const changed of [
      { baseline_version: "other" },
      { input_hash: "b".repeat(64) },
      { report_version: "old" },
      { domain: "other" },
      { finding_key: "invented" },
      { question: "invented" },
    ])
      expect(() => validateReportTarget(view, { ...target, ...changed })).toThrow();
    expect(
      validateReportTarget(view, { ...target, finding_key: undefined, question: "合成问题" })
        .question,
    ).toBe("合成问题");
  });
  it("scopes all report adapter methods to configured authenticated owner, never body identity", async () => {
    const f = await fixture();
    const stranger = { ...owner, subjectId: "00000000-0000-4000-8000-000000000099" };
    const viewCalls = vi.mocked(readBaseline).mock.calls.length;
    await expect(f.service.read(stranger)).rejects.toMatchObject({ code: "REPORT_OWNER_MISMATCH" });
    await expect(f.service.validateTarget(stranger, target)).rejects.toMatchObject({
      code: "REPORT_OWNER_MISMATCH",
    });
    await expect(f.service.saveCore(stranger, {}, "core-test", f.binding)).rejects.toMatchObject({
      code: "REPORT_OWNER_MISMATCH",
    });
    expect(vi.mocked(readBaseline).mock.calls).toHaveLength(viewCalls);
    expect(() =>
      createPrivateCoreReportService(new PrivateUnderstandingRepository(f.paths)),
    ).toThrow("CORE_SOURCE_LIFECYCLE_REQUIRED");
  });
  it("rejects assistant, summary, wrong owner/exploration, excluded/deleted/stale/corrected sources", async () => {
    for (const mutate of [
      (r: ReturnType<typeof sourceFixture>) => {
        r.turn.role = "assistant";
      },
      (r: ReturnType<typeof sourceFixture>) => {
        r.source.sourceKind = "summary";
      },
      (r: ReturnType<typeof sourceFixture>) => {
        r.source.subjectId = "other";
      },
      (r: ReturnType<typeof sourceFixture>) => {
        r.source.tenantId = "other";
      },
      (r: ReturnType<typeof sourceFixture>) => {
        r.turn.explorationId = "other";
      },
      (r: ReturnType<typeof sourceFixture>) => {
        r.assessment.eligibility = "excluded";
      },
      (r: ReturnType<typeof sourceFixture>) => {
        r.source.usageStatus = "deleted";
      },
      (r: ReturnType<typeof sourceFixture>) => {
        r.assessment.isCurrent = false;
      },
      (r: ReturnType<typeof sourceFixture>) => {
        r.replaced = true;
      },
    ]) {
      const row = sourceFixture();
      mutate(row);
      await expect(eligibleReportSource(owner, explorationId, row)).rejects.toMatchObject({
        code:
          row.source.tenantId !== owner.tenantId || row.source.subjectId !== owner.subjectId
            ? "REPORT_OWNER_MISMATCH"
            : "REPORT_SOURCE_INELIGIBLE",
      });
    }
  });
  it("copies only the selected original text, retaining root identity, times and attribution", async () => {
    const f = await fixture();
    const receipt = await transferCoreReportSource(
      f.backend,
      f.service,
      owner,
      explorationId,
      f.selected,
    );
    expect(receipt.status).toBe("pending_analysis");
    expect(receipt.result_version).toBeNull();
    expect(receipt.input.note).toBe(f.row.source.content);
    expect(receipt.source_id).toBe(sourceId);
    expect(receipt.core_source).toEqual(f.binding);
    expect(Receipt.parse(receipt).core_source).toEqual(f.binding);
    const fact = feedbackFact(receipt);
    expect(fact.root_ids).toEqual([sourceId]);
    expect(fact.time).toBe(f.binding.disclosed_at);
    expect(fact.group_id).toBe(explorationId);
    expect(fact.use).toBe("context");
    expect(qualificationInput([receipt]).notes[0]?.core_source).toEqual(f.binding);
    expect((await readState(f.paths)).calls_reserved).toBe(0);
  });
  it("guided answers exclude generated option labels and require original free text", async () => {
    const row = sourceFixture();
    row.source.sourceKind = "guided_response";
    row.turn.turnKind = "answer";
    row.source.sourceMeta = { selected_options: ["模型生成的选项"], free_text: "我自己的限定原话" };
    row.source.content = row.turn.content = "选择：模型生成的选项。我自己的限定原话";
    expect((await eligibleReportSource(owner, explorationId, row)).content).toBe(
      "我自己的限定原话",
    );
    row.source.sourceMeta = { selected_options: ["模型生成的选项"], free_text: "" };
    await expect(eligibleReportSource(owner, explorationId, row)).rejects.toMatchObject({
      code: "REPORT_SOURCE_INELIGIBLE",
    });
  });
  it("survives lost downstream acknowledgement and repository recreation without duplicate feedback", async () => {
    const f = await fixture();
    const save = f.service.saveCore.bind(f.service);
    f.service.saveCore = async (...args) => {
      await save(...args);
      throw new Error("ACK_LOST");
    };
    await expect(
      transferCoreReportSource(f.backend, f.service, owner, explorationId, f.selected),
    ).rejects.toThrow("ACK_LOST");
    const restarted = createPrivateCoreReportService(
      new PrivateUnderstandingRepository(f.repository.options),
    );
    const receipt = await transferCoreReportSource(
      f.backend,
      restarted,
      owner,
      explorationId,
      f.selected,
    );
    const repeat = await transferCoreReportSource(
      f.backend,
      restarted,
      owner,
      explorationId,
      f.selected,
    );
    expect(repeat.id).toBe(receipt.id);
    expect((await readState(f.paths)).entries).toHaveLength(1);
    // Pending display must not break validation/replay for the overall version either.
    const overallBackend = {
      ...f.backend,
      target: async () => ({ ...target, domain: "overall", report_version: "overall-1" }),
    };
    const a = await transferCoreReportSource(
      overallBackend,
      restarted,
      owner,
      explorationId,
      f.selected,
    );
    expect((await restarted.read(owner)).overall.report).toBeNull();
    const b = await transferCoreReportSource(
      overallBackend,
      restarted,
      owner,
      explorationId,
      f.selected,
    );
    expect(a.id).toBe(b.id);
    expect((await readState(f.paths)).entries).toHaveLength(2);
  });
  it("blocks copied material after source change on adapter reads, process and historical evidence", async () => {
    const f = await fixture();
    const saved = await transferCoreReportSource(
      f.backend,
      f.service,
      owner,
      explorationId,
      f.selected,
    );
    f.row.assessment.version++;
    const view = await f.service.read(owner);
    expect(view.sources?.[0]?.status).toBe("invalid");
    expect(view.feedback[0]?.input.note).toBe("");
    expect(JSON.stringify(view)).not.toContain(f.row.source.content);
    expect(view.topics[0]?.version).toBe("topic-1");
    await expect(f.service.process(owner, saved.id, {})).rejects.toMatchObject({
      publicCode: "REPORT_SOURCE_BLOCKED",
    });
    await expect(f.service.evidences(owner, "agency", "topic-1", [sourceId])).rejects.toMatchObject(
      { publicCode: "EVIDENCE_OUTSIDE_REPORT" },
    );
    await expect(
      transferCoreReportSource(f.backend, f.service, owner, explorationId, f.selected),
    ).rejects.toMatchObject({ code: "STALE_REPORT_SOURCE" });
    expect((await readState(f.paths)).entries[0]?.receipt.status).toBe("pending_analysis");
    expect((await readState(f.paths)).calls_reserved).toBe(0);
  });
  it("capability-off rejects opt-in requests while ordinary Core saves stay unchanged", async () => {
    const f = await fixture();
    const app = new Hono();
    app.onError(onError);
    app.route(
      "/api/core",
      coreRoutes(
        {} as Db,
        undefined,
        () => ({ provider: "synthetic", principalId: "owner" }),
        undefined,
        { contextFor: async () => owner, backend: f.backend },
      ),
    );
    expect(await (await app.request("/api/core/capabilities")).json()).toEqual({
      native_core: true,
      report_bridge: false,
    });
    const transfer = await app.request(`/api/core/explorations/${explorationId}/report-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(f.selected),
    });
    expect(transfer.status).toBe(403);
    expect(
      (
        await app.request("/api/core/report-sources/rebind", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source_id: sourceId,
            expected_lifecycle_revision: 0,
            reason: "合成重绑",
            idempotency_key: "disabled-rebind",
            exploration_id: explorationId,
            new_source_id: sourceId,
            target,
          }),
        })
      ).status,
    ).toBe(403);
    const start = await app.request("/api/core/explorations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "合成事件", report_target: target }),
    });
    expect(start.status).toBe(403); // No DB/model invoked, even if a client supplies a target.
    await expect(
      startExploration({} as Db, undefined, owner, { event: "合成事件", report_target: target }),
    ).rejects.toMatchObject({ code: "REPORT_BRIDGE_UNAVAILABLE" });
  });
  it("real Core save persists target in ext separately from event and production backend reloads it", async () => {
    const tables = new Map<unknown, Record<string, unknown>[]>();
    const tx = {
      insert: (table: unknown) => ({
        values: (value: Record<string, unknown>) => {
          const row = {
            id: table === coreSchema.explorations ? explorationId : sourceId,
            version: 1,
            status: "active",
            ...value,
          };
          tables.set(table, [...(tables.get(table) ?? []), row]);
          return {
            returning: async () => [row],
            then: (resolve: (v: unknown) => void) => resolve(undefined),
          };
        },
      }),
    };
    const db = {
      transaction: async (run: (t: unknown) => unknown) => run(tx),
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({ limit: async () => tables.get(table) ?? [] }),
        }),
      }),
    } as unknown as Db;
    const result = await startExploration(
      db,
      undefined,
      owner,
      { event: "本人原始合成事件", report_target: target },
      undefined,
      target,
    );
    expect(result.saved).toBe(true);
    expect(tables.get(coreSchema.sourceItems)?.[0]?.content).toBe("本人原始合成事件");
    expect(tables.get(coreSchema.explorationTurns)?.[0]?.content).toBe("本人原始合成事件");
    expect(await createCoreReportBackend(db).target(owner, explorationId)).toEqual(target);
    tables.clear();
    await startExploration(db, undefined, owner, { event: "普通合成事件" });
    expect(tables.get(coreSchema.explorations)?.[0]?.ext).toBeUndefined();
  });
  it("actual transfer route enforces exact length/current source, and capability is injected only", async () => {
    const f = await fixture();
    const app = new Hono();
    app.onError(onError);
    app.route(
      "/api/core",
      coreRoutes(
        {} as Db,
        undefined,
        () => ({ provider: "synthetic", principalId: "owner" }),
        f.service,
        { contextFor: async () => owner, backend: f.backend },
      ),
    );
    app.route(
      "/api/understanding",
      nativeUnderstandingRoutes(f.service, async () => owner),
    );
    expect((await (await app.request("/api/core/capabilities")).json()).report_bridge).toBe(true);
    expect((await (await app.request("/api/understanding")).json()).capabilities.native_core).toBe(
      "available",
    );
    expect((await f.repository.read()).capabilities.native_core).toBe("unavailable");
    const post = (body: unknown) =>
      app.request(`/api/core/explorations/${explorationId}/report-feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ ...f.selected, assessment_version: 99 })).status).toBe(409);
    expect((await post({ ...f.selected, note: "CLIENT/ASSISTANT_OVERRIDE" })).status).toBe(400);
    f.row.source.content = f.row.turn.content = "长".repeat(2401);
    const current = await f.backend.source(owner, explorationId, sourceId);
    const oversized = await post({ ...f.selected, content_hash: current.content_hash });
    expect(oversized.status).toBe(422);
    expect((await oversized.json()).error.code).toBe("FEEDBACK_INPUT_BOUND_EXCEEDED");
    expect((await readState(f.paths)).entries).toHaveLength(0);
    f.row.source.content = f.row.turn.content = "长".repeat(2400);
    const bounded = await f.backend.source(owner, explorationId, sourceId);
    expect((await post({ ...f.selected, content_hash: bounded.content_hash })).status).toBe(201);
    expect((await readState(f.paths)).calls_reserved).toBe(0);
  });
});

it("malformed recovery JSON is rejected before invoking the report processor", async () => {
  const f = await fixture();
  const process = vi.spyOn(f.service, "process");
  const app = nativeUnderstandingRoutes(f.service, async () => owner);
  const response = await app.request("/feedback/synthetic/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("INVALID_JSON");
  expect(process).not.toHaveBeenCalled();
});

describe("source lifecycle actions (synthetic owner and verifier)", () => {
  async function imported() {
    const f = await fixture();
    await transferCoreReportSource(f.backend, f.service, owner, explorationId, f.selected);
    return f;
  }
  const retire = (revision = 0) => ({
    source_id: sourceId,
    expected_lifecycle_revision: revision,
    reason: "明确停止使用合成来源",
    idempotency_key: "synthetic-retire-1",
  });
  it("GET derives invalidity without writing, transient outage and owner faults cannot authorize retirement", async () => {
    const f = await imported();
    const before = await readState(f.paths);
    f.row.assessment.version++;
    expect((await f.repository.read()).sources?.[0]?.status).toBe("invalid");
    expect(await readState(f.paths)).toEqual(before);
    f.row.source.usageStatus = "excluded";
    expect((await f.repository.read()).sources?.[0]?.reason).toBe("REPORT_SOURCE_EXCLUDED");
    expect(await readState(f.paths)).toEqual(before);
    f.verifySource.mockRejectedValue(new Error("VERIFIER_UNAVAILABLE"));
    await expect(f.repository.read()).rejects.toThrow("VERIFIER_UNAVAILABLE");
    await expect(f.repository.retireSource(retire())).rejects.toThrow("VERIFIER_UNAVAILABLE");
    f.verifySource.mockRejectedValue(new CoreError("REPORT_OWNER_MISMATCH", 403, "合成越权"));
    await expect(f.repository.retireSource(retire())).rejects.toMatchObject({
      code: "REPORT_OWNER_MISMATCH",
    });
    expect(await readState(f.paths)).toEqual(before);
  });
  it("explicit unchanged-source retirement is durable, idempotent and conflicts on changed request/frontier", async () => {
    const f = await imported();
    const before = await readState(f.paths);
    await f.repository.retireSource(retire());
    const after = await readState(f.paths);
    await f.repository.retireSource(retire());
    expect(await readState(f.paths)).toEqual(after);
    expect(after.entries).toEqual(before.entries);
    expect(after.lifecycle[0]).toMatchObject({
      actor: owner,
      kind: "retire",
      expected_lifecycle_revision: 0,
    });
    expect(after.lifecycle[0]?.source_fingerprints).toHaveLength(1);
    expect(JSON.stringify(await f.repository.read())).not.toContain(f.row.source.content);
    await expect(f.repository.retireSource({ ...retire(), reason: "不同理由" })).rejects.toThrow(
      "IDEMPOTENCY_CONFLICT",
    );
    await expect(
      f.repository.retireSource({ ...retire(), idempotency_key: "new-retire-key" }),
    ).rejects.toThrow("SOURCE_LIFECYCLE_CONFLICT");
    await expect(
      transferCoreReportSource(f.backend, f.service, owner, explorationId, { ...f.selected }),
    ).resolves.toMatchObject({ input: { note: "" } });
    const restored = {
      ...retire(1),
      idempotency_key: "explicit-restore-1",
      exploration_id: explorationId,
      new_source_id: sourceId,
      target: { ...target, finding_key: undefined, question: undefined },
    };
    await rebindCoreReportSource(f.backend, f.service, owner, restored);
    const nextRoot = (await readState(f.paths)).entries.at(-1)!.receipt.source_id;
    expect(nextRoot).not.toBe(sourceId);
    expect((await f.repository.read()).feedback[0]?.input.note).toBe("");
    await f.repository.retireSource({
      ...retire(2),
      source_id: nextRoot,
      idempotency_key: "retire-rebound-root",
    });
    await rebindCoreReportSource(f.backend, f.service, owner, {
      ...restored,
      source_id: nextRoot,
      expected_lifecycle_revision: 3,
      idempotency_key: "explicit-restore-2",
    });
    const restoredState = await readState(f.paths);
    expect(restoredState.entries.at(-1)?.receipt.source_id).not.toBe(nextRoot);
    expect(restoredState.calls_reserved).toBe(0);
    expect((await f.repository.read()).feedback.slice(0, 2).every((f) => f.input.note === "")).toBe(
      true,
    );
  });
  it("secure rebind fetches current content, rejects client binding/content and stale target, preserves calls", async () => {
    const f = await imported();
    f.row.source.content = f.row.turn.content = "合成新版原话，不继承旧审核。";
    f.row.assessment.version++;
    const input = {
      ...retire(),
      idempotency_key: "synthetic-rebind-1",
      exploration_id: explorationId,
      new_source_id: sourceId,
      target: { ...target, finding_key: undefined, question: undefined },
    };
    await expect(
      rebindCoreReportSource(f.backend, f.service, owner, { ...input, note: "伪造" }),
    ).rejects.toThrow();
    await expect(
      rebindCoreReportSource(f.backend, f.service, owner, {
        ...input,
        target: { ...input.target, report_version: "stale" },
      }),
    ).rejects.toMatchObject({ code: "STALE_REPORT_VERSION" });
    const app = new Hono();
    app.onError(onError);
    app.route(
      "/api/core",
      coreRoutes(
        {} as Db,
        undefined,
        () => ({ provider: "synthetic", principalId: "owner" }),
        f.service,
        { contextFor: async () => owner, backend: f.backend },
      ),
    );
    const post = (body: unknown) =>
      app.request("/api/core/report-sources/rebind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ ...input, core_source: f.binding })).status).toBe(400);
    expect((await post(input)).status).toBe(200);
    const state = await readState(f.paths);
    expect(state.calls_reserved).toBe(0);
    expect(state.entries).toHaveLength(2);
    expect(state.entries[1]?.receipt).toMatchObject({
      replaces_source_id: sourceId,
      input: { note: f.row.source.content },
      status: "pending_analysis",
    });
    expect(state.entries[1]?.receipt.source_id).not.toBe(sourceId);
    expect((await f.repository.read()).feedback[1]?.qualification).toBe("pending");
    await rebindCoreReportSource(f.backend, f.service, owner, input);
    expect(await readState(f.paths)).toEqual(state);
    expect((await f.repository.read()).feedback[0]?.input.note).toBe("");
  });
  it("history index and exact versions remain read-only, bounded and owner-scoped", async () => {
    const f = await imported();
    const before = await readState(f.paths);
    expect(await f.service.history(owner, "agency", 1)).toMatchObject({
      truncated: false,
      versions: [{ version: "topic-1", status: "needs_review", origin: "baseline" }],
    });
    expect((await f.service.version(owner, "agency", "topic-1")).report).toEqual(report);
    await expect(f.service.version(owner, "agency", "invented-version")).rejects.toMatchObject({
      publicCode: "REPORT_VERSION_NOT_FOUND",
    });
    await expect(
      f.service.history({ ...owner, tenantId: explorationId }, "agency"),
    ).rejects.toMatchObject({ code: "REPORT_OWNER_MISMATCH" });
    await expect(f.repository.history("agency", 101)).rejects.toThrow("HISTORY_QUERY_INVALID");
    expect(await readState(f.paths)).toEqual(before);
  });
});
