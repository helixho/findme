import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type Db, coreSchema as c, createDb, platformSchema as p } from "@findme/db";
import {
  type ProfileTransaction,
  withProfileTransaction,
} from "../../src/cloud-diagnostic/scope.js";
import type { PersonalContext } from "../../src/core/exploration-service.js";

// Deliberately no .env fallback and no skipped suite: coordinator supplies the existing
// local schema/role configuration via the DB test runner.
export async function knowledgeEnvironment() {
  const file = process.env.FINDME_ACCOUNT_VERIFY_CONFIG;
  if (!file)
    throw new Error(
      "KNOWLEDGE_DB_CONFIG_REQUIRED: run the DB manifest with FINDME_ACCOUNT_VERIFY_CONFIG (isolated PostgreSQL account roles)",
    );
  const cfg = JSON.parse(await readFile(file, "utf8"));
  if (cfg.database !== "findme_test" || !["127.0.0.1", "localhost"].includes(cfg.host)) {
    throw new Error("KNOWLEDGE_LOCAL_TEST_DATABASE_REQUIRED");
  }
  for (const key of ["runtime_url", "identity_url"]) {
    const url = new URL(cfg[key]);
    if (url.hostname !== cfg.host || url.pathname !== `/${cfg.database}`)
      throw new Error("KNOWLEDGE_ISOLATED_URL_MISMATCH");
  }
  const runtime = createDb(cfg.runtime_url, { max: 4 });
  const identity = createDb(cfg.identity_url, { max: 1 });
  const within = <T>(ctx: PersonalContext, work: (tx: ProfileTransaction) => Promise<T>) =>
    withProfileTransaction(runtime.db, ctx, work);
  async function profile() {
    const ctx = { tenantId: randomUUID(), subjectId: randomUUID() };
    await identity.db.transaction(async (tx) => {
      await tx.insert(c.tenants).values({ id: ctx.tenantId });
      await tx.insert(c.subjects).values({
        id: ctx.subjectId,
        tenantId: ctx.tenantId,
        displayName: "Synthetic knowledge test",
      });
      await tx.insert(p.profileMemberships).values({
        ...ctx,
        provider: "knowledge-test",
        principalId: randomUUID(),
        creationKey: randomUUID(),
      });
    });
    return ctx;
  }
  async function fixture(existingContext?: PersonalContext) {
    const ctx = existingContext ?? (await profile());
    const source = randomUUID();
    const span = randomUUID();
    const claim = randomUUID();
    const revision = randomUUID();
    await within(ctx, async (tx) => {
      await tx.insert(c.sourceItems).values({
        ...ctx,
        id: source,
        sourceKind: "quick_note",
        authorKind: "subject",
        content: "合成：短时任务中更容易开始",
        sourceMeta: { stance: "本人观察", context: { task: "合成短时任务" } },
      });
      await tx.insert(c.sourceAssessments).values({
        sourceItemId: source,
        version: 1,
        attributionStatus: "confirmed_subject",
        contextCompleteness: "sufficient",
        temporalPrecision: "exact",
        eligibility: "eligible",
        rationale: "合成测试",
      });
      await tx.insert(c.evidenceSpans).values({
        id: span,
        sourceItemId: source,
        quote: "合成原话：短时任务中更容易开始",
        authorKind: "subject",
      });
      await tx
        .insert(c.claims)
        .values({ ...ctx, id: claim, claimKey: randomUUID(), claimKind: "pattern" });
      await tx.insert(c.claimRevisions).values({
        id: revision,
        claimId: claim,
        version: 1,
        mode: "observation",
        text: "合成认识：短时任务中更容易开始",
        scope: "只限合成任务",
        confidenceLevel: "low",
        confidenceBasis: "单个合成样例",
      });
      await tx.insert(c.claimEvidence).values(link(revision, span));
    });
    return { ctx, source, span, claim, revision };
  }
  return {
    runtime,
    within,
    profile,
    fixture,
    close: async () => {
      await runtime.sql.end();
      await identity.sql.end();
    },
  };
}
export const link = (revision: string, span: string, relation = "supports") => ({
  claimRevisionId: revision,
  evidenceSpanId: span,
  relation,
  directness: "direct",
  contribution: "high",
  independenceGroup: span,
  scopeMatch: "合成范围",
  rationale: "合成证据",
});
export type KnowledgeEnvironment = Awaited<ReturnType<typeof knowledgeEnvironment>>;
export const serviceDb = (tx: ProfileTransaction) => tx as unknown as Db;
