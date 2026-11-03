import { randomUUID } from "node:crypto";
import type { Db } from "@findme/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { specialistRoutes } from "../src/routes/specialist.js";

// Contract test without a database: exercise the HTTP route and optimistic update;
// account membership/RLS are covered by the separate isolated DB integration suite.
vi.mock("../src/cloud-diagnostic/scope.js", () => ({
  withProfileTransaction: async (db: Db, _ctx: unknown, work: (db: Db) => unknown) => work(db),
}));
// Session wording lives in personal sources; an in-memory store stands in for source_items.
const sources = new Map<string, { id: string; sourceMeta: Record<string, unknown> }>();
vi.mock("../src/core/personal-source.js", () => ({
  readPersonalSources: async (_db: Db, _ctx: unknown, ids: string[]) =>
    new Map(ids.flatMap((id) => (sources.has(id) ? [[id, sources.get(id)]] : []))),
  recordPersonalSource: async (
    _db: Db,
    _ctx: unknown,
    input: { meta: Record<string, unknown> },
  ) => {
    const source = { id: randomUUID(), sourceMeta: input.meta };
    sources.set(source.id, source);
    return source;
  },
}));
const dialect = new PgDialect();
function fixture() {
  const tenantId = randomUUID();
  const subjectId = randomUUID();
  const id = randomUUID();
  const contextSourceId = randomUUID();
  sources.set(contextSourceId, {
    id: contextSourceId,
    sourceMeta: {
      fields: {
        goal: "开始任务",
        setting: null,
        difficulty: null,
        environment: null,
        existingSupports: null,
        burden: null,
      },
    },
  });
  let row: Record<string, unknown> = {
    id,
    tenantId,
    subjectId,
    pathway: "adhd",
    status: "open",
    version: 1,
    contextSourceId,
    difficultyCategories: [],
    environmentCategories: [],
    selfReportedDiagnosis: null,
    scopeFlags: [],
    skippedSteps: ["setting"],
  };
  let writes = 0;
  let collide = false;
  const predicates: string[] = [];
  function matches(where: SQL) {
    const q = dialect.sqlToQuery(where);
    predicates.push(q.sql);
    return [tenantId, subjectId, id].every((value) => q.params.includes(value));
  }
  const db = {
    select: () => ({
      from: () => ({
        where: (where: SQL) => ({ limit: async () => (matches(where) ? [row] : []) }),
      }),
    }),
    update: () => ({
      set: (changes: Record<string, unknown>) => ({
        where: (where: SQL) => ({
          returning: async () => {
            if (!matches(where) || collide) return [];
            row = { ...row, ...changes };
            writes++;
            return [row];
          },
        }),
      }),
    }),
  } as unknown as Db;
  const app = specialistRoutes(db, async () => ({ tenantId, subjectId }));
  const patch = (body: unknown, target = id) =>
    app.request(`/adhd/sessions/${target}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    patch,
    row: () => row,
    writes: () => writes,
    predicates,
    setRow: (next: Record<string, unknown>) => {
      row = { ...row, ...next };
    },
    collision: () => {
      collide = true;
    },
  };
}
describe("specialist context completion on the same event", () => {
  it("updates context and version while retaining the session identity and omitted fields", async () => {
    const f = fixture();
    const id = f.row().id;
    const r = await f.patch({
      expected_version: 1,
      setting: "在家处理邮件",
      difficulty: "难以开始",
      difficulty_categories: ["task_start"],
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.session).toMatchObject({
      id,
      version: 2,
      setting: "在家处理邮件",
      goal: "开始任务",
      difficultyCategories: ["task_start"],
    });
    expect(f.writes()).toBe(1);
    expect(
      f.predicates.every(
        (sql) =>
          sql.includes('"tenant_id"') && sql.includes('"subject_id"') && sql.includes('"id"'),
      ),
    ).toBe(true);
  });
  it("acknowledges a response-lost retry without creating another revision", async () => {
    const f = fixture();
    const body = { expected_version: 1, setting: "在家处理邮件" };
    await f.patch(body);
    const r = await f.patch(body);
    expect(r.status).toBe(200);
    expect((await r.json()).replayed).toBe(true);
    expect(f.writes()).toBe(1);
  });
  it("rejects a changed stale retry and a racing optimistic write", async () => {
    const f = fixture();
    await f.patch({ expected_version: 1, setting: "在家" });
    expect((await f.patch({ expected_version: 1, setting: "在办公室" })).status).toBe(409);
    f.collision();
    expect((await f.patch({ expected_version: 2, difficulty: "卡住" })).status).toBe(409);
  });
  it("rejects another event id and completed sessions", async () => {
    const f = fixture();
    expect((await f.patch({ expected_version: 1, setting: "在家" }, randomUUID())).status).toBe(
      404,
    );
    f.setRow({ status: "completed" });
    expect((await f.patch({ expected_version: 1, setting: "在家" })).status).toBe(409);
    expect(f.writes()).toBe(0);
  });
  it("allows clearing a field and updating a paused event", async () => {
    const f = fixture();
    f.setRow({ status: "paused", environment: "旧描述" });
    const r = await f.patch({
      expected_version: 1,
      environment: "",
      scope_flags: ["safety_constraint"],
    });
    expect(r.status).toBe(200);
    expect((await r.json()).session).toMatchObject({
      status: "paused",
      environment: null,
      scopeFlags: ["safety_constraint"],
    });
  });
  it("requires a version and context fields; rejects pathway, consent, and invalid categories", async () => {
    const f = fixture();
    for (const body of [
      { setting: "在家" },
      { expected_version: 1 },
      { expected_version: 1, pathway: "general" },
      { expected_version: 1, voluntary: true },
      { expected_version: 1, difficulty_categories: ["unrecognized"] },
    ])
      expect((await f.patch(body)).status).toBe(400);
    expect(f.writes()).toBe(0);
  });
});
