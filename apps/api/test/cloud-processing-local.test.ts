import { randomUUID } from "node:crypto";
import { type Db, coreSchema as c, diagnosticSchema as d, platformSchema as p } from "@findme/db";
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { CloudProcessingService } from "../src/cloud-diagnostic/processing.js";
import {
  PipelineInput,
  cloudFacts,
  cloudQualificationInput,
  qualificationProof,
  sourceAttribution,
} from "../src/cloud-diagnostic/provenance.js";
import { cloudSourceHash } from "../src/cloud-diagnostic/repository.js";
import type { ProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import { qualificationAssigned } from "../src/understanding-app/qualification.js";
import { digest } from "../src/understanding-baseline/io.js";

const ctx = { tenantId: randomUUID(), subjectId: randomUUID() };
const options = {
  enabled: true,
  profileCallLimit: 12,
  maxCallsPerJob: 4,
  maxOutputTokens: 1000,
  timeoutMs: 10000,
};
const text = "我喜欢先核对依据。";
function input() {
  return PipelineInput.parse({
    run_id: randomUUID(),
    run_version: 1,
    domain: "collaboration",
    question: "如何协作？",
    policy: "old-policy",
    sources: [
      {
        id: randomUUID(),
        hash: "source-hash",
        assessment_version: 1,
        text,
        reported_at: "2026-01-01T00:00:00.000Z",
        occurred_at: null,
        root_id: "root",
        kind: "quick_note",
        author: "subject",
        about: "self",
        stance: "endorsed",
      },
    ],
  });
}
function candidate(sourceId: string) {
  return {
    notes: [
      {
        note_id: sourceId,
        reason: "合成命题",
        propositions: [
          {
            quote: text,
            start: 0,
            end: text.length,
            author: "subject" as const,
            about: "self" as const,
            kind: "evaluation" as const,
            stance: "endorsed" as const,
            type: "preference" as const,
            purpose: "personal_expression" as const,
            proposition: text,
            scope: "本次合成协作",
            reason: "合成原话",
          },
        ],
      },
    ],
  };
}

// A deterministic transaction adapter exercises the real service and Drizzle predicates.
// It is not a substitute for PostgreSQL/RLS integration: failed callbacks roll back writes.
function memoryDb() {
  let state: Record<string, any[]> = {};
  const dialect = new PgDialect();
  const name = (table: any) => getTableName(table);
  const matches = (table: any, row: any, condition: any) => {
    if (!condition) return true;
    const query = dialect.sqlToQuery(condition);
    const columns = getTableColumns(table) as Record<string, any>;
    const field = (column: string) => Object.keys(columns).find((k) => columns[k].name === column)!;
    const equals = [...query.sql.matchAll(/"(\w+)"\."(\w+)" = \$(\d+)/g)];
    if (
      equals.some(
        (m) => m[1] === name(table) && row[field(m[2]!)] !== query.params[Number(m[3]) - 1],
      )
    )
      return false;
    const statuses = query.sql.match(/"status" in \('([^']+)'(?:,'([^']+)')?\)/);
    if (statuses && !statuses.slice(1).includes(row.status)) return false;
    return true;
  };
  const transaction = async (work: any) => {
    const draft = structuredClone(state);
    const tx: any = {
      execute: async () => [{ allowed: true }],
      select: () => {
        let table: any;
        let condition: any;
        let cap = Number.POSITIVE_INFINITY;
        const query: any = {
          from: (t: any) => {
            table = t;
            return query;
          },
          innerJoin: () => query,
          where: (w: any) => {
            condition = w;
            return query;
          },
          limit: (n: number) => {
            cap = n;
            return query;
          },
          for: () => query,
          orderBy: () => query,
          then: (resolve: any, reject: any) =>
            Promise.resolve(
              (draft[name(table)] ?? []).filter((r) => matches(table, r, condition)).slice(0, cap),
            ).then(resolve, reject),
        };
        return query;
      },
      update: (table: any) => {
        let values: any;
        let condition: any;
        const apply = () => {
          const rows = (draft[name(table)] ?? []).filter((r) => matches(table, r, condition));
          for (const row of rows) Object.assign(row, values);
          return rows;
        };
        const query: any = {
          set: (v: any) => {
            values = v;
            return query;
          },
          where: (w: any) => {
            condition = w;
            return query;
          },
          returning: async () => apply(),
          then: (resolve: any, reject: any) => Promise.resolve(apply()).then(resolve, reject),
        };
        return query;
      },
      insert: (table: any) => {
        let value: any;
        const apply = () => {
          draft[name(table)] ??= [];
          const rows = draft[name(table)]!;
          if (table === p.cloudJobs && rows.some((r) => r.fingerprint === value.fingerprint))
            return [];
          const row = {
            id: randomUUID(),
            status: "queued",
            stage: "qualification",
            callsUsed: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            error: null,
            execution: null,
            leaseUntil: null,
            ...value,
          };
          rows.push(row);
          return [row];
        };
        const query: any = {
          values: (v: any) => {
            value = v;
            return query;
          },
          onConflictDoNothing: () => query,
          returning: async () => apply(),
          then: (resolve: any, reject: any) => Promise.resolve(apply()).then(resolve, reject),
        };
        return query;
      },
    };
    const result = await work(tx);
    state = draft;
    return result;
  };
  return {
    db: { transaction } as unknown as Db,
    seed: (table: any, rows: any[]) => {
      state[name(table)] = rows;
    },
    rows: (table: any) => state[name(table)] ?? [],
  };
}

describe("cloud source attribution / no database or model", () => {
  it("puts all retained attribution into the real generation/audit input and resulting facts", () => {
    const source = input();
    const q = cloudQualificationInput(source);
    expect(q.notes[0]!.source_attribution).toEqual(sourceAttribution(source.sources[0]!));
    const facts = cloudFacts(source, candidate(source.sources[0]!.id));
    expect(facts[0]).toMatchObject({
      content_author: "subject",
      about: "self",
      stance: "endorsed",
    });
    expect(facts[1]).toMatchObject({ source_attribution: sourceAttribution(source.sources[0]!) });
    for (const [key, value] of Object.entries({
      author: "assistant",
      kind: "external_summary",
      occurred_at: "2025-01-01T00:00:00.000Z",
      about: "third_party",
      stance: "not_endorsed",
    })) {
      const changed = structuredClone(source);
      Object.assign(changed.sources[0]!, { [key]: value });
      expect(digest(cloudQualificationInput(changed)), key).not.toBe(digest(q));
    }
  });
  it("distinguishes identical subject and third-party text, and endorsement from non-endorsement", () => {
    const own = input();
    expect(cloudFacts(own, candidate(own.sources[0]!.id))[1]!.use).toBe("personal_expression");
    for (const change of [
      { author: "third_party" },
      { stance: "not_endorsed" },
      { about: "third_party" },
    ]) {
      const other = PipelineInput.parse({ ...own, sources: [{ ...own.sources[0], ...change }] });
      expect(() => cloudFacts(other, candidate(other.sources[0]!.id))).toThrow(
        "QUALIFICATION_ATTRIBUTION_CHANGED",
      );
      const context = candidate(other.sources[0]!.id);
      context.notes[0]!.propositions[0]!.purpose = "context_only" as any;
      expect(cloudFacts(other, context)[1]!.use).toBe("context");
    }
  });
  it("parses old snapshots as unknown but refuses an old audit for the expanded input", async () => {
    const old = input();
    const raw = structuredClone(old) as any;
    delete raw.sources[0].about;
    delete raw.sources[0].stance;
    const parsed = PipelineInput.parse(raw);
    expect(parsed.sources[0]).toMatchObject({ about: "unknown", stance: "unknown" });
    const q = cloudQualificationInput(parsed);
    const qualified = candidate(parsed.sources[0]!.id);
    const review = {
      input_hash: digest(q),
      checks: qualificationAssigned(q, qualified).map((a) => ({
        id: a.id,
        checked: true,
        rationale: "合成审核",
        same_context: false,
        concrete_incompatibility: false,
      })),
      issues: [],
    };
    const store = memoryDb();
    const jobId = randomUUID();
    store.seed(p.cloudJobs, [{ id: jobId, ...ctx, input: raw }]);
    store.seed(p.cloudAttempts, [
      {
        ...ctx,
        jobId,
        status: "ok",
        phase: "qualification",
        raw: JSON.stringify(qualified),
        result: qualified,
        inputHash: "legacy-input",
      },
      {
        ...ctx,
        jobId,
        status: "ok",
        phase: "qualification_audit",
        raw: JSON.stringify(review),
        result: review,
        inputHash: "legacy-audit",
      },
    ]);
    await expect(
      store.db.transaction((tx) => qualificationProof(tx as ProfileTransaction, ctx, jobId)),
    ).rejects.toThrow("QUALIFICATION_INPUT_VERSION_CHANGED");
  });
});

describe("cloud consume freshness / real service + synthetic transactions", () => {
  async function setup() {
    const store = memoryDb();
    const runId = randomUUID();
    const sourceId = randomUUID();
    store.seed(c.subjects, [{ id: ctx.subjectId, ...ctx, ext: {} }]);
    store.seed(p.profileMemberships, [{ id: randomUUID(), ...ctx, status: "active" }]);
    store.seed(d.diagnosticRuns, [
      {
        id: runId,
        ...ctx,
        version: 1,
        headVersion: 0,
        status: "pending",
        domain: "collaboration",
        question: "合成协作？",
      },
    ]);
    store.seed(c.sourceItems, [
      {
        id: sourceId,
        ...ctx,
        sourceKind: "quick_note",
        authorKind: "subject",
        content: text,
        capturedAt: new Date("2026-01-01"),
        occurredAt: null,
        externalRef: null,
        sourceMeta: { about: "self", stance: "endorsed" },
        usageStatus: "active",
      },
    ]);
    store.seed(c.sourceAssessments, [
      { sourceItemId: sourceId, version: 1, isCurrent: true, eligibility: "eligible" },
    ]);
    store.seed(p.cloudBudgets, [{ ...ctx, callsUsed: 3 }]);
    const extract = vi.fn();
    const send = vi.fn(async () => {});
    const service = new CloudProcessingService(
      store.db,
      { extract, describe: () => ({ model: "synthetic" }) } as any,
      options,
      send,
    );
    const request = {
      expected_version: 1,
      source_ids: [sourceId],
      topic_run_ids: [],
      provider_call_cap: 4,
    };
    const first = await service.enqueue(ctx, runId, request);
    return { store, service, extract, send, runId, sourceId, request, first };
  }
  it.each(["run", "source", "assessment"])(
    "commits stale after %s changes, with no attempt, budget increase or resend; a fresh enqueue gets a new job",
    async (change) => {
      const x = await setup();
      const before = structuredClone(x.store.rows(p.cloudJobs)[0]);
      expect(before.status).toBe("queued");
      if (change === "run") x.store.rows(d.diagnosticRuns)[0].version = 2;
      if (change === "source") x.store.rows(c.sourceItems)[0].sourceMeta.stance = "not_endorsed";
      if (change === "assessment") x.store.rows(c.sourceAssessments)[0].version = 2;
      await expect(
        x.service.consume({
          type: "cloud_diagnostic",
          job_id: x.first.id,
          tenant_id: ctx.tenantId,
          subject_id: ctx.subjectId,
        }),
      ).resolves.toBeUndefined();
      const stale = x.store.rows(p.cloudJobs).find((j) => j.id === x.first.id);
      expect(stale).toMatchObject({
        status: "stale",
        error: "SOURCE_CHANGED",
        callsUsed: before.callsUsed,
        callCap: before.callCap,
        execution: null,
        leaseUntil: null,
      });
      expect(x.store.rows(p.cloudAttempts)).toHaveLength(0);
      expect(x.store.rows(p.cloudBudgets)[0].callsUsed).toBe(3);
      expect(x.extract).not.toHaveBeenCalled();
      expect(x.send).toHaveBeenCalledTimes(1);
      const next = await x.service.enqueue(ctx, x.runId, {
        ...x.request,
        expected_version: change === "run" ? 2 : 1,
      });
      expect(next.id).not.toBe(x.first.id);
      expect(next.status).toBe("queued");
      expect(x.store.rows(p.cloudJobs).find((j) => j.id === x.first.id).status).toBe("stale");
    },
  );
  it("does not reuse a stale job when the original source returns to the same hash", async () => {
    const x = await setup();
    const source = x.store.rows(c.sourceItems)[0];
    const originalHash = await cloudSourceHash(source);
    source.content = "已变更";
    await x.service.consume({
      type: "cloud_diagnostic",
      job_id: x.first.id,
      tenant_id: ctx.tenantId,
      subject_id: ctx.subjectId,
    });
    x.store.rows(c.sourceItems)[0].content = text;
    expect(await cloudSourceHash(x.store.rows(c.sourceItems)[0])).toBe(originalHash);
    const next = await x.service.enqueue(ctx, x.runId, x.request);
    expect(next.id).not.toBe(x.first.id);
    expect(next.status).toBe("queued");
    expect(x.extract).not.toHaveBeenCalled();
  });
});
