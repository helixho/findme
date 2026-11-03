import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { coreSchema, createDb, diagnosticSchema as d, platformSchema as p } from "@findme/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { ACCOUNT_ISSUER, createAccountAuth } from "../src/auth/server.js";
import { CloudProcessingService } from "../src/cloud-diagnostic/processing.js";
import { createCloudServices } from "../src/cloud-diagnostic/runtime.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import { requestHash } from "../src/core/operations.js";
import { digest } from "../src/understanding-baseline/io.js";
import { cloudCheckpointRegressions } from "./helpers/cloud-checkpoint-regressions.js";
import { cloudCoreSourceInvalidation } from "./helpers/cloud-core-source-invalidation.js";
import { cloudLifecycleContinuity } from "./helpers/cloud-lifecycle-continuity.js";
import { cloudProcessingContinuity } from "./helpers/cloud-processing-continuity.js";
import { cloudRestoreContinuity } from "./helpers/cloud-restore-continuity.js";

// Explicit schema-only verification DB only. Never load the repository .env or production URL.
const configFile = process.env.FINDME_ACCOUNT_VERIFY_CONFIG;
const base = "http://127.0.0.1:8810";
const suite = configFile ? describe : describe.skip;
suite("account cloud integration / isolated Postgres / no model", () => {
  let runtime: ReturnType<typeof createDb>;
  let identity: ReturnType<typeof createDb>;
  let account: ReturnType<typeof createAccountAuth>;
  let services: ReturnType<typeof createCloudServices>;
  let app: ReturnType<typeof createApp>;
  let a = "";
  let a2 = "";
  let b = "";
  let aUser = "";
  let bUser = "";
  let aProfile = "";
  let bProfile = "";
  let runId = "";
  let sourceId = "";
  const mails: { to: string; text: string }[] = [];
  const stamp = randomUUID().slice(0, 8);
  const password = "Synthetic-Verification-Only-2026!";
  async function request(
    cookie: string,
    path: string,
    options: {
      method?: string;
      body?: unknown;
      profile?: string;
      key?: string;
    } = {},
  ) {
    return app.request(base + path, {
      method: options.method ?? "GET",
      headers: {
        Origin: base,
        Cookie: cookie,
        "content-type": "application/json",
        ...(options.profile ? { "X-FindMe-Profile": options.profile } : {}),
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }
  async function json(response: Response, status = 200): Promise<any> {
    const value = await response.json();
    expect(response.status, JSON.stringify(value.error ?? value.code ?? "unexpected_status")).toBe(
      status,
    );
    return value;
  }
  const cookies = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((s) => s.split(";")[0])
      .join("; ");
  async function signIn(email: string) {
    const r = await request("", "/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password },
    });
    await json(r);
    const result = cookies(r);
    expect(result).toContain("session_token");
    return result;
  }
  beforeAll(async () => {
    const cfg = JSON.parse(await readFile(configFile!, "utf8"));
    const legacyIsolated =
      cfg.branch_id === "br-winter-scene-b3qp2xaw" && cfg.database === "findme_c_verify";
    const localTest =
      cfg.database === "findme_test" && ["127.0.0.1", "localhost"].includes(cfg.host);
    if (!legacyIsolated && !localTest) throw new Error("EXPLICIT_ISOLATED_TEST_CONFIG_REQUIRED");
    for (const key of ["runtime_url", "identity_url", "auth_url"]) {
      const u = new URL(cfg[key]);
      if (u.hostname !== cfg.host || u.pathname !== `/${cfg.database}`)
        throw new Error("ISOLATED_URL_MISMATCH");
    }
    runtime = createDb(cfg.runtime_url, { max: 2 });
    identity = createDb(cfg.identity_url, { max: 2 });
    account = createAccountAuth({
      databaseUrl: cfg.auth_url,
      secret: cfg.secret,
      baseUrl: base,
      trustedOrigins: [base],
      registrationEnabled: true,
      sendMail: async (mail) => {
        mails.push(mail);
      },
    });
    services = createCloudServices({
      db: runtime.db,
      identityDb: identity.db,
      processing: {
        enabled: false,
        profileCallLimit: 0,
        maxCallsPerJob: 4,
        maxOutputTokens: 1000,
        timeoutMs: 10000,
      },
    });
    app = createApp({
      db: runtime.db,
      cloud: services,
      auth: {
        mode: "account",
        sessions: account.sessions,
        trustedOrigins: [base],
        handler: (req) => account.auth.handler(req),
      },
    });
    for (const who of ["a", "b"]) {
      const email = `c-${stamp}-${who}@validation.invalid`;
      const result = await json(
        await request("", "/api/auth/sign-up/email", {
          method: "POST",
          body: { email, password, name: `Synthetic ${who}` },
        }),
      );
      const mail = mails.find((m) => m.to === email);
      expect(mail).toBeDefined();
      const verification = mail!.text.match(/https?:\/\/\S+/)?.[0];
      expect(verification).toBeTruthy();
      const verified = await app.request(verification!, { headers: { Origin: base } });
      expect(verified.status).toBeLessThan(400);
      if (who === "a") {
        aUser = result.user.id;
        a = await signIn(email);
        a2 = await signIn(email);
      } else {
        bUser = result.user.id;
        b = await signIn(email);
      }
    }
  }, 180000);
  afterAll(async () => {
    await Promise.all([runtime?.sql.end(), identity?.sql.end(), account?.close()]);
  });
  it("authenticates two accounts, restores one account across sessions, and keeps Profiles apart", async () => {
    const left = await json(await request(a, "/api/profiles"));
    const same = await json(await request(a2, "/api/profiles"));
    const right = await json(await request(b, "/api/profiles"));
    expect(left).toHaveLength(1);
    expect(right).toHaveLength(1);
    aProfile = left[0].id;
    bProfile = right[0].id;
    expect(same[0].id).toBe(aProfile);
    expect(bProfile).not.toBe(aProfile);
    expect((await request(b, "/api/diagnostics", { profile: aProfile })).status).toBe(403);
    expect((await request("", "/api/diagnostics")).status).toBe(401);
    expect((await request(a, "/api/records")).status).toBe(404);
  });
  it("creates a cloud run, saves a response without inference, and rejects stale writes", async () => {
    const created = await json(
      await request(a, "/api/diagnostics", {
        method: "POST",
        profile: aProfile,
        key: `run-${stamp}`,
        body: { domain: "collaboration", question: "合成样例：如何判断协作中的信息条件？" },
      }),
      201,
    );
    runId = created.id;
    const response = {
      expected_version: 1,
      report_revision_id: null,
      kind: "supplement",
      note: "这是一条合成验证输入：在资料不完整时，我会先确认具体问题。",
    };
    const saved = await json(
      await request(a, `/api/diagnostics/${runId}/responses`, {
        method: "POST",
        profile: aProfile,
        key: `response-${stamp}`,
        body: response,
      }),
      201,
    );
    sourceId = saved.source_id;
    expect(saved.saved).toBe(true);
    expect(saved.analysis_status).toBe("recorded");
    const replay = await json(
      await request(a2, `/api/diagnostics/${runId}/responses`, {
        method: "POST",
        profile: aProfile,
        key: `response-${stamp}`,
        body: response,
      }),
      201,
    );
    expect(replay.id).toBe(saved.id);
    expect(
      (
        await request(a, `/api/diagnostics/${runId}/responses`, {
          method: "POST",
          profile: aProfile,
          key: `stale-${stamp}`,
          body: response,
        })
      ).status,
    ).toBe(409);
    const read = await json(await request(a2, `/api/diagnostics/${runId}`, { profile: aProfile }));
    expect(read.version).toBe(2);
    expect(read.report).toBeNull();
    expect((await request(b, `/api/diagnostics/${runId}`, { profile: bProfile })).status).toBe(404);
    const jobs = await json(
      await request(a, `/api/diagnostics/${runId}/jobs`, { profile: aProfile }),
    );
    expect(jobs).toHaveLength(0);
    const capabilities = await json(
      await request(a, "/api/diagnostics/capabilities", { profile: aProfile }),
    );
    expect(capabilities.inference_enabled).toBe(false);
    const health = await json(await request("", "/api/health?strict=1"));
    expect(health.status).toBe("ok");
    expect(health.detail.queue).toBe("account_scoped_not_enumerated");
  }, 150000);
  it("enforces database RLS even when a scoped query omits an explicit source filter", async () => {
    const ctxA = await services.profiles.resolve(
      { provider: ACCOUNT_ISSUER, principalId: aUser },
      aProfile,
    );
    const ctxB = await services.profiles.resolve(
      { provider: ACCOUNT_ISSUER, principalId: bUser },
      bProfile,
    );
    const own = await withProfileTransaction(runtime.db, ctxA, (tx) =>
      tx.select().from(coreSchema.sourceItems),
    );
    const other = await withProfileTransaction(runtime.db, ctxB, (tx) =>
      tx.select().from(coreSchema.sourceItems),
    );
    expect(own.some((s) => s.id === sourceId)).toBe(true);
    expect(other.some((s) => s.id === sourceId)).toBe(false);
    const unscoped = await runtime.db.select().from(coreSchema.sourceItems);
    expect(unscoped).toHaveLength(0);
    await expect(
      withProfileTransaction(runtime.db, ctxA, (tx) =>
        tx.insert(coreSchema.sourceItems).values({
          ...ctxB,
          sourceKind: "quick_note",
          authorKind: "subject",
          content: "forbidden synthetic cross-scope write",
        }),
      ),
    ).rejects.toThrow();
  });
  it("supports multiple Profiles and blocks archived Profile reads without affecting another", async () => {
    const extra = await json(
      await request(a, "/api/profiles", {
        method: "POST",
        key: `profile-${stamp}`,
        body: { name: "Synthetic alternate" },
      }),
      201,
    );
    expect(extra.id).not.toBe(aProfile);
    const archived = await json(
      await request(a, `/api/profiles/${extra.id}`, {
        method: "PATCH",
        body: { expected_version: extra.version, status: "archived" },
      }),
    );
    expect(archived.status).toBe("archived");
    expect((await request(a, "/api/diagnostics", { profile: extra.id })).status).toBe(403);
    expect((await request(a, `/api/diagnostics/${runId}`, { profile: aProfile })).status).toBe(200);
  });
  async function syntheticOverall() {
    const ctx = await services.profiles.resolve(
      { provider: ACCOUNT_ISSUER, principalId: aUser },
      aProfile,
    );
    const topic = await services.repository.create(
      ctx,
      { domain: "collaboration", question: "合成专题依赖" },
      randomUUID(),
    );
    const overall = await services.repository.create(
      ctx,
      { domain: "overall", question: "合成整体依赖" },
      randomUUID(),
    );
    const body = {
      headline: "合成整体报告",
      current_understanding: null,
      findings: [],
      resources_conditions_costs: [],
      alternatives: [],
      unknowns: ["仅验证依赖状态，不是模型报告"],
      question: null,
      next_step: null,
      nodes: [],
      links: [],
    };
    const contentHash = await requestHash(body);
    const overallJobId = randomUUID();
    const topicReportId = randomUUID();
    const overallReportId = randomUUID();
    await withProfileTransaction(runtime.db, ctx, async (tx) => {
      // Explicit synthetic accepted fixtures isolate dependency reads from publication/model tests.
      for (const run of [topic, overall]) {
        await tx
          .update(d.diagnosticRuns)
          .set({ status: "ready", version: 2, headVersion: 1 })
          .where(eq(d.diagnosticRuns.id, run.id));
        await tx.insert(d.diagnosticReportRevisions).values({
          ...ctx,
          id: run.id === topic.id ? topicReportId : overallReportId,
          runId: run.id,
          version: 1,
          basisVersion: 1,
          status: "accepted",
          body,
          jobId: run.id === overall.id ? overallJobId : null,
          contentHash,
          inputHash: contentHash,
          policyVersion: "synthetic",
          promptVersion: "synthetic",
          model: "zero-model-fixture",
        });
      }
      await tx.insert(p.cloudJobs).values({
        ...ctx,
        id: overallJobId,
        runId: overall.id,
        basisVersion: 1,
        fingerprint: randomUUID(),
        model: "zero-model-fixture",
        status: "completed",
        callCap: 0,
        input: {
          run_id: overall.id,
          run_version: 1,
          domain: "overall",
          question: "合成整体依赖",
          policy: "synthetic",
          sources: [
            {
              id: sourceId,
              hash: contentHash,
              assessment_version: 1,
              text: "合成上下文",
              reported_at: new Date().toISOString(),
              occurred_at: null,
              root_id: sourceId,
              kind: "quick_note",
              author: "unknown",
            },
          ],
          dependencies: [{ id: topic.id, version: 2, head_version: 1 }],
        },
      });
    });
    return { ctx, topic, overall, topicReportId, body };
  }
  it.each(["supplement", "inaccurate", "context_only", "changed_now"])(
    "blocks current overall immediately after topic %s, while helpful does not trigger invalidation or generation",
    async (kind) => {
      const x = await syntheticOverall();
      expect((await services.repository.read(x.ctx, x.overall.id)).report).toEqual(x.body);
      const before = await services.processing.jobs(x.ctx, x.overall.id);
      await services.repository.respond(
        x.ctx,
        x.topic.id,
        {
          expected_version: 2,
          report_revision_id: x.topicReportId,
          kind: "helpful",
          note: "这份合成专题有帮助",
        },
        randomUUID(),
      );
      expect((await services.repository.read(x.ctx, x.overall.id)).status).toBe("ready");
      await services.repository.respond(
        x.ctx,
        x.topic.id,
        {
          expected_version: 2,
          report_revision_id: x.topicReportId,
          kind,
          note: "合成专题纠正：这里只是当时条件",
        },
        randomUUID(),
      );
      const read = await services.repository.read(x.ctx, x.overall.id);
      expect(read).toMatchObject({
        status: "needs_review",
        report_status: "needs_review",
        report: null,
      });
      expect(await services.processing.jobs(x.ctx, x.overall.id)).toEqual(before);
      // Historical revision remains the then-current report; no synthetic replacement is made.
      expect((await services.repository.version(x.ctx, x.overall.id, 1)).report).toEqual(x.body);
    },
  );
  it.each(["version", "headVersion"])(
    "blocks overall if its recorded topic %s changes even while status remains ready",
    async (field) => {
      const x = await syntheticOverall();
      await withProfileTransaction(runtime.db, x.ctx, (tx) =>
        tx
          .update(d.diagnosticRuns)
          .set({ [field]: 3 })
          .where(eq(d.diagnosticRuns.id, x.topic.id)),
      );
      expect(await services.repository.read(x.ctx, x.overall.id)).toMatchObject({
        status: "needs_review",
        report: null,
      });
    },
  );
  it("commits initial consume staleness in Postgres, preserves budget and requires a new explicitly enqueued job", async () => {
    const ctx = await services.profiles.resolve(
      { provider: ACCOUNT_ISSUER, principalId: aUser },
      aProfile,
    );
    const run = await services.repository.create(
      ctx,
      { domain: "collaboration", question: "合成队列失效" },
      randomUUID(),
    );
    const first = await services.repository.respond(
      ctx,
      run.id,
      { expected_version: 1, report_revision_id: null, kind: "supplement", note: "合成原始输入" },
      randomUUID(),
    );
    const extract = vi.fn(async () => {
      throw new Error("MODEL_MUST_NOT_RUN");
    });
    const send = vi.fn(async () => {});
    const processing = new CloudProcessingService(
      runtime.db,
      { extract, describe: () => ({ model: "zero-model-fixture" }) } as any,
      {
        enabled: true,
        profileCallLimit: 4,
        maxCallsPerJob: 4,
        maxOutputTokens: 1000,
        timeoutMs: 10000,
      },
      send,
    );
    const old = await processing.enqueue(ctx, run.id, {
      expected_version: 2,
      source_ids: [first.source_id],
      provider_call_cap: 4,
    });
    const budget = () =>
      withProfileTransaction(runtime.db, ctx, (tx) => tx.select().from(p.cloudBudgets));
    const before = await budget();
    await services.repository.respond(
      ctx,
      run.id,
      {
        expected_version: 2,
        report_revision_id: null,
        kind: "changed_now",
        note: "合成输入已经变化",
      },
      randomUUID(),
    );
    await expect(
      processing.consume({
        type: "cloud_diagnostic",
        job_id: old.id,
        tenant_id: ctx.tenantId,
        subject_id: ctx.subjectId,
      }),
    ).resolves.toBeUndefined();
    expect(await processing.get(ctx, old.id)).toMatchObject({
      status: "stale",
      error: "SOURCE_CHANGED",
      calls_used: 0,
      call_cap: 4,
    });
    const attempts = await withProfileTransaction(runtime.db, ctx, (tx) =>
      tx
        .select()
        .from(p.cloudAttempts)
        .where(
          and(
            eq(p.cloudAttempts.jobId, old.id),
            eq(p.cloudAttempts.tenantId, ctx.tenantId),
            eq(p.cloudAttempts.subjectId, ctx.subjectId),
          ),
        ),
    );
    expect(attempts).toHaveLength(0);
    expect(await budget()).toEqual(before);
    expect(extract).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    const fresh = await processing.enqueue(ctx, run.id, {
      expected_version: 3,
      source_ids: [first.source_id],
      provider_call_cap: 4,
    });
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.status).toBe("queued");
    expect((await processing.get(ctx, old.id)).status).toBe("stale");
    expect(extract).not.toHaveBeenCalled();
  });
  async function publicationPropagationFixture(currentDependsOnA: boolean) {
    const x = await syntheticOverall();
    const topicB = await services.repository.create(
      x.ctx,
      { domain: "judgment_learning", question: "合成专题 B" },
      randomUUID(),
    );
    const contentHash = await requestHash(x.body);
    const publisherId = randomUUID();
    const execution = randomUUID();
    const candidateId = randomUUID();
    const inputHash = digest({ fixture: "publication-propagation", publisherId });
    const oldJobs = await services.processing.jobs(x.ctx, x.overall.id);
    const oldJobId = oldJobs[0]!.id;
    const makeInput = (runId: string, topicId = x.topic.id, version = 2, head = 1) => ({
      run_id: runId,
      run_version: 3,
      domain: "overall",
      question: "合成依赖传播",
      policy: "synthetic",
      sources: [
        {
          id: sourceId,
          hash: contentHash,
          assessment_version: 1,
          text: "合成上下文",
          reported_at: new Date().toISOString(),
          occurred_at: null,
          root_id: sourceId,
          kind: "quick_note",
          author: "unknown",
        },
      ],
      dependencies: [{ id: topicId, version, head_version: head }],
    });
    async function addJob(
      ctx: typeof x.ctx,
      runId: string,
      status: string,
      topicId = x.topic.id,
      version = 2,
      head = 1,
    ) {
      const id = randomUUID();
      await withProfileTransaction(runtime.db, ctx, (tx) =>
        tx.insert(p.cloudJobs).values({
          ...ctx,
          id,
          runId,
          basisVersion: 3,
          fingerprint: randomUUID(),
          model: "zero-model-fixture",
          status,
          callCap: 4,
          callsUsed: 1,
          input: makeInput(runId, topicId, version, head),
          execution: status === "running" ? randomUUID() : null,
          leaseUntil: status === "running" ? new Date(Date.now() + 60000) : null,
        }),
      );
      return id;
    }
    const currentJobId = await addJob(
      x.ctx,
      x.overall.id,
      "completed",
      currentDependsOnA ? x.topic.id : topicB.id,
    );
    await withProfileTransaction(runtime.db, x.ctx, async (tx) => {
      await tx
        .update(d.diagnosticRuns)
        .set({ status: "needs_review", version: 3 })
        .where(eq(d.diagnosticRuns.id, x.topic.id));
      await tx
        .update(d.diagnosticRuns)
        .set({ status: "ready", version: 2, headVersion: 1 })
        .where(eq(d.diagnosticRuns.id, topicB.id));
      await tx.insert(d.diagnosticReportRevisions).values({
        ...x.ctx,
        runId: topicB.id,
        version: 1,
        basisVersion: 1,
        status: "accepted",
        body: x.body,
        contentHash,
        inputHash,
        policyVersion: "synthetic",
        promptVersion: "synthetic",
        model: "zero-model-fixture",
      });
      await tx
        .update(d.diagnosticRuns)
        .set({ version: 3, headVersion: 2 })
        .where(eq(d.diagnosticRuns.id, x.overall.id));
      await tx.insert(d.diagnosticReportRevisions).values({
        ...x.ctx,
        runId: x.overall.id,
        version: 2,
        basisVersion: 2,
        status: "accepted",
        jobId: currentJobId,
        body: x.body,
        contentHash,
        inputHash,
        policyVersion: "synthetic",
        promptVersion: "synthetic",
        model: "zero-model-fixture",
      });
      await tx.insert(p.cloudJobs).values({
        ...x.ctx,
        id: publisherId,
        runId: x.topic.id,
        basisVersion: 3,
        fingerprint: randomUUID(),
        model: "zero-model-fixture",
        status: "running",
        execution,
        callCap: 4,
        callsUsed: 2,
        input: { ...makeInput(x.topic.id), domain: "collaboration", dependencies: [] },
      });
      await tx.insert(d.diagnosticReportRevisions).values({
        ...x.ctx,
        id: candidateId,
        runId: x.topic.id,
        version: 2,
        basisVersion: 3,
        jobId: publisherId,
        body: x.body,
        contentHash,
        inputHash,
        policyVersion: "synthetic",
        promptVersion: "synthetic",
        model: "zero-model-fixture",
      });
      // Valid zero-evidence report + raw generation/audit pair. It makes no personal claim;
      // the real publication path still checks schemas, hashes, raw equality and assigned IDs.
      const audit = { input_hash: inputHash, checks: [], issues: [] };
      for (const [phase, result, hash] of [
        ["report", x.body, inputHash],
        [
          "report_audit",
          audit,
          digest({ candidate: x.body, analysis_input_hash: inputHash, assigned: [] }),
        ],
      ] as const)
        await tx.insert(p.cloudAttempts).values({
          ...x.ctx,
          jobId: publisherId,
          execution,
          phase,
          status: "ok",
          inputHash: hash,
          raw: JSON.stringify(result),
          result,
        });
      await tx
        .insert(p.cloudBudgets)
        .values({ ...x.ctx, callsUsed: 7 })
        .onConflictDoNothing();
    });
    const terminalIds: string[] = [oldJobId, currentJobId];
    for (const status of ["completed", "failed", "cancelled", "rejected", "stale"])
      terminalIds.push(await addJob(x.ctx, x.overall.id, status));
    const queuedId = await addJob(x.ctx, x.overall.id, "queued");
    const runningId = await addJob(x.ctx, x.overall.id, "running");
    const unrelatedId = await addJob(x.ctx, x.overall.id, "queued", topicB.id);
    const futureId = await addJob(x.ctx, x.overall.id, "queued", x.topic.id, 4, 2);
    const archived = await services.repository.create(
      x.ctx,
      { domain: "overall", question: "合成已归档整体" },
      randomUUID(),
    );
    const archivedJobId = await addJob(x.ctx, archived.id, "completed");
    await withProfileTransaction(runtime.db, x.ctx, async (tx) => {
      await tx
        .update(d.diagnosticRuns)
        .set({ status: "archived", version: 9, headVersion: 1 })
        .where(eq(d.diagnosticRuns.id, archived.id));
      await tx.insert(d.diagnosticReportRevisions).values({
        ...x.ctx,
        runId: archived.id,
        version: 1,
        basisVersion: 1,
        status: "accepted",
        jobId: archivedJobId,
        body: x.body,
        contentHash,
        inputHash,
        policyVersion: "synthetic",
        promptVersion: "synthetic",
        model: "zero-model-fixture",
      });
    });
    const otherCtx = await services.profiles.resolve(
      { provider: ACCOUNT_ISSUER, principalId: bUser },
      bProfile,
    );
    const other = await services.repository.create(
      otherCtx,
      { domain: "overall", question: "另一作用域" },
      randomUUID(),
    );
    const otherJobId = await addJob(otherCtx, other.id, "running");
    const state = (ctx = x.ctx) =>
      withProfileTransaction(runtime.db, ctx, async (tx) => ({
        runs: await tx.select().from(d.diagnosticRuns),
        jobs: await tx.select().from(p.cloudJobs),
        budgets: await tx.select().from(p.cloudBudgets),
        attempts: await tx.select().from(p.cloudAttempts),
      }));
    const publish = (
      fresh: Parameters<typeof services.repository.acceptProcessed>[4] = async () => {},
    ) => services.repository.acceptProcessed(x.ctx, publisherId, execution, candidateId, fresh);
    return {
      ...x,
      topicB,
      currentJobId,
      terminalIds,
      queuedId,
      runningId,
      unrelatedId,
      futureId,
      archived,
      archivedJobId,
      otherCtx,
      other,
      otherJobId,
      state,
      publish,
      publisherId,
      makeInput,
    };
  }
  it("publishes A without withdrawing O's current B-only head or rewriting terminal history, while staling only related in-flight work", async () => {
    const x = await publicationPropagationFixture(false);
    const before = await x.state();
    const otherBefore = await x.state(x.otherCtx);
    await expect(x.publish()).resolves.toMatchObject({ status: "accepted" });
    const after = await x.state();
    for (const id of x.terminalIds)
      expect(after.jobs.find((j) => j.id === id)).toEqual(before.jobs.find((j) => j.id === id));
    expect(after.runs.find((r) => r.id === x.overall.id)).toEqual(
      before.runs.find((r) => r.id === x.overall.id),
    );
    expect((await services.repository.read(x.ctx, x.overall.id)).report).toEqual(x.body);
    for (const id of [x.queuedId, x.runningId])
      expect(after.jobs.find((j) => j.id === id)).toMatchObject({
        status: "stale",
        error: "TOPIC_CHANGED",
        execution: null,
        leaseUntil: null,
        callsUsed: 1,
        callCap: 4,
      });
    for (const id of [x.unrelatedId, x.futureId, x.archivedJobId])
      expect(after.jobs.find((j) => j.id === id)).toEqual(before.jobs.find((j) => j.id === id));
    expect(after.runs.find((r) => r.id === x.archived.id)).toEqual(
      before.runs.find((r) => r.id === x.archived.id),
    );
    expect(await x.state(x.otherCtx)).toEqual(otherBefore);
    expect(after.budgets).toEqual(before.budgets);
    expect(after.attempts).toEqual(before.attempts);
  });
  it("invalidates an A-dependent current head exactly once despite multiple historical and active jobs, without reviving archived runs", async () => {
    const x = await publicationPropagationFixture(true);
    const before = await x.state();
    await x.publish();
    const after = await x.state();
    const previous = before.runs.find((r) => r.id === x.overall.id)!;
    expect(after.runs.find((r) => r.id === x.overall.id)).toMatchObject({
      status: "needs_review",
      version: previous.version + 1,
      headVersion: previous.headVersion,
    });
    for (const id of x.terminalIds)
      expect(after.jobs.find((j) => j.id === id)).toEqual(before.jobs.find((j) => j.id === id));
    expect(after.runs.find((r) => r.id === x.archived.id)).toEqual(
      before.runs.find((r) => r.id === x.archived.id),
    );
    expect(after.budgets).toEqual(before.budgets);
    expect(after.attempts).toEqual(before.attempts);
  });
  it.each(["report", "report_audit"])(
    "rejects actual persisted %s content tampering after schema-order normalization",
    async (phase) => {
      const x = await publicationPropagationFixture(false);
      await withProfileTransaction(runtime.db, x.ctx, async (tx) => {
        const [attempt] = await tx
          .select()
          .from(p.cloudAttempts)
          .where(and(eq(p.cloudAttempts.jobId, x.publisherId), eq(p.cloudAttempts.phase, phase)));
        const changed =
          phase === "report"
            ? { ...attempt!.result, headline: "已篡改的内容" }
            : { ...attempt!.result, input_hash: "0".repeat(64) };
        await tx
          .update(p.cloudAttempts)
          .set({ result: changed })
          .where(eq(p.cloudAttempts.id, attempt!.id));
      });
      const before = await x.state();
      await expect(x.publish()).rejects.toThrow(
        phase === "report" ? "PUBLICATION_GENERATION_CHANGED" : "PUBLICATION_INTEGRITY",
      );
      expect(await x.state()).toEqual(before);
    },
  );
  it("rechecks the head after a concurrent overall upgrade and preserves its new independent report", async () => {
    const x = await publicationPropagationFixture(true);
    let unlock = () => {};
    let locked = () => {};
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const lockReady = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const contentHash = await requestHash(x.body);
    const currentJobId = randomUUID();
    const holder = withProfileTransaction(runtime.db, x.ctx, async (tx) => {
      await tx
        .select()
        .from(d.diagnosticRuns)
        .where(eq(d.diagnosticRuns.id, x.overall.id))
        .for("update");
      locked();
      await release;
      await tx.insert(p.cloudJobs).values({
        ...x.ctx,
        id: currentJobId,
        runId: x.overall.id,
        basisVersion: 3,
        fingerprint: randomUUID(),
        model: "zero-model-fixture",
        status: "completed",
        callCap: 0,
        input: x.makeInput(x.overall.id, x.topicB.id),
      });
      await tx.insert(d.diagnosticReportRevisions).values({
        ...x.ctx,
        runId: x.overall.id,
        version: 3,
        basisVersion: 3,
        status: "accepted",
        jobId: currentJobId,
        body: x.body,
        contentHash,
        inputHash: contentHash,
        policyVersion: "synthetic",
        promptVersion: "synthetic",
        model: "zero-model-fixture",
      });
      await tx
        .update(d.diagnosticRuns)
        .set({ version: 4, headVersion: 3, status: "ready" })
        .where(eq(d.diagnosticRuns.id, x.overall.id));
    });
    await lockReady;
    let publisherStarted = () => {};
    const started = new Promise<void>((resolve) => {
      publisherStarted = resolve;
    });
    let publisherPid = 0;
    const publication = x.publish(async (tx) => {
      const [row] = await tx.execute(sql`select pg_backend_pid() as pid`);
      publisherPid = Number(row!.pid);
      publisherStarted();
    });
    await started;
    let blocked = false;
    try {
      for (let i = 0; i < 100; i++) {
        const [row] = await identity.sql`select pg_blocking_pids(${publisherPid}) as blockers`;
        if (row!.blockers.length) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      unlock();
    }
    await holder;
    await publication;
    expect(blocked, "publication actually waited for the concurrent head transaction").toBe(true);
    const after = await x.state();
    expect(after.runs.find((r) => r.id === x.overall.id)).toMatchObject({
      status: "ready",
      version: 4,
      headVersion: 3,
    });
    expect(after.jobs.find((j) => j.id === currentJobId)).toMatchObject({ status: "completed" });
    expect((await services.repository.read(x.ctx, x.overall.id)).report).toEqual(x.body);
  });
  cloudCheckpointRegressions({
    db: () => runtime.db,
    context: () =>
      services.profiles.resolve({ provider: ACCOUNT_ISSUER, principalId: aUser }, aProfile),
    repository: () => services.repository,
  });
  cloudCoreSourceInvalidation({
    db: () => runtime.db,
    context: () =>
      services.profiles.resolve({ provider: ACCOUNT_ISSUER, principalId: aUser }, aProfile),
    otherContext: () =>
      services.profiles.resolve({ provider: ACCOUNT_ISSUER, principalId: bUser }, bProfile),
    corePost: (path, body, key) =>
      request(a, path, { method: "POST", body, profile: aProfile, key }),
  });
  cloudLifecycleContinuity({
    db: () => runtime.db,
    context: () =>
      services.profiles.resolve({ provider: ACCOUNT_ISSUER, principalId: aUser }, aProfile),
    repository: () => services.repository,
  });
  cloudProcessingContinuity({
    db: () => runtime.db,
    context: () =>
      services.profiles.resolve({ provider: ACCOUNT_ISSUER, principalId: aUser }, aProfile),
    repository: () => services.repository,
  });
  cloudRestoreContinuity({
    db: () => runtime.db,
    context: () =>
      services.profiles.resolve({ provider: ACCOUNT_ISSUER, principalId: aUser }, aProfile),
    repository: () => services.repository,
  });
  it("exports only the selected Profile and revokes the signed-out session", async () => {
    const own = await json(await request(a, "/api/data/export/sources", { profile: aProfile }));
    const other = await json(await request(b, "/api/data/export/sources", { profile: bProfile }));
    expect(own.items.some((s: any) => s.id === sourceId)).toBe(true);
    expect(other.items.some((s: any) => s.id === sourceId)).toBe(false);
    await json(await request(a, "/api/auth/sign-out", { method: "POST", body: {} }));
    expect((await request(a, "/api/profiles")).status).toBe(401);
    expect((await request(a2, "/api/profiles")).status).toBe(200);
  });
});
