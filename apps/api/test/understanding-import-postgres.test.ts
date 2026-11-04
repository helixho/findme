import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { StoredUnderstandingDetails } from "@findme/core";
import { coreSchema, createDb } from "@findme/db";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { ProfileService } from "../src/auth/profiles.js";
import { invalidateCloudSources } from "../src/cloud-diagnostic/effects.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import {
  UnderstandingImportService,
  prepareUnderstandingImport,
} from "../src/cloud-diagnostic/understanding-import.js";
import { requestHash } from "../src/core/operations.js";
import {
  understandingImportFixture,
  understandingImportV2Fixture,
} from "./helpers/understanding-import-fixture.js";

it("round-trips one immutable conversation import, scopes reads and redacts dependent dimensions", async () => {
  const config = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const runtime = createDb(config.runtime_url);
  const identity = createDb(config.identity_url);
  try {
    const profiles = new ProfileService(identity.db);
    const ctx = await profiles.resolve({
      provider: "understanding-import-test",
      principalId: randomUUID(),
    });
    const other = await profiles.resolve({
      provider: "understanding-import-test",
      principalId: randomUUID(),
    });
    const service = new UnderstandingImportService(runtime.db);
    const input = understandingImportFixture(randomUUID());
    input.feedback.push({
      key: "source-feedback",
      source_key: "u2",
      target: { type: "source", key: "a1" },
      purpose: "disagreement",
    });
    const { input_hash } = await prepareUnderstandingImport(input);
    const saved = await service.commit(ctx, input, input_hash);
    const id = String(saved.id);
    const view = await service.read(ctx, id);
    expect(view.sources).toHaveLength(5);
    expect(view.feedback).toHaveLength(2);
    expect(view.feedback.find((row) => row.targetType === "source")).toMatchObject({
      feedbackType: "disagreement",
      targetId: view.sources.find((row) => row.sourceMeta?.external_id === "a1")!.id,
      sourceItemId: view.sources.find((row) => row.sourceMeta?.external_id === "u2")!.id,
    });
    // Even with a valid feedback source, a different Profile cannot target this source.
    await expect(
      withProfileTransaction(runtime.db, other, async (tx) => {
        const [own] = await tx
          .insert(coreSchema.sourceItems)
          .values({
            ...other,
            sourceKind: "test",
            authorKind: "subject",
            content: "合成反馈",
          })
          .returning();
        await tx.insert(coreSchema.feedbackEvents).values({
          ...other,
          targetType: "source",
          targetId: view.sources[0]!.id,
          feedbackType: "disagreement",
          sourceItemId: own!.id,
          note: "",
        });
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    expect(view.revisions.map((row) => row.status).sort()).toEqual(["candidate", "withdrawn"]);
    expect(view.revisions.every((row) => row.details.domains)).toBe(true);
    expect(view.feedback.find((row) => row.feedbackType === "insight_usefulness")!).toMatchObject({
      feedbackType: "insight_usefulness",
      note: "",
    });
    expect(
      view.sources.find(
        (row) =>
          row.id ===
          view.feedback.find((row) => row.feedbackType === "insight_usefulness")!.sourceItemId,
      )?.content,
    ).toBe(input.sources[4]!.text);
    expect(await service.commit(ctx, input, input_hash)).toMatchObject({ replayed: true, id });
    expect((await service.read(ctx, id)).revisions).toHaveLength(2);
    await expect(service.read(other, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const conflicting = structuredClone(input);
    conflicting.sources[0]!.text += "附加文字";
    const changed = await prepareUnderstandingImport(conflicting);
    await expect(service.commit(ctx, conflicting, changed.input_hash)).rejects.toMatchObject({
      code: "SOURCE_VERSION_CONFLICT",
    });
    const source = view.sources.find((row) => row.sourceMeta?.external_id === "u1")!;
    await withProfileTransaction(runtime.db, ctx, async (tx) => {
      await tx
        .update(coreSchema.sourceItems)
        .set({ content: "", usageStatus: "deleted", sourceMeta: {} })
        .where(eq(coreSchema.sourceItems.id, source.id));
      await invalidateCloudSources(tx, ctx, [source.id], true);
    });
    const redacted = await service.read(ctx, id);
    expect(
      redacted.revisions.every((row) => row.text === "" && JSON.stringify(row.details) === "{}"),
    ).toBe(true);
    // Idempotent replay does not resurrect erased data.
    await service.commit(ctx, input, input_hash);
    expect((await service.read(ctx, id)).revisions.every((row) => row.text === "")).toBe(true);
  } finally {
    await Promise.all([runtime.sql.end(), identity.sql.end()]);
  }
});

it("stores answer bindings and experience groups, reads them back and keeps replay immutable (version 2)", async () => {
  const config = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const runtime = createDb(config.runtime_url);
  const identity = createDb(config.identity_url);
  try {
    const profiles = new ProfileService(identity.db);
    const ctx = await profiles.resolve({
      provider: "understanding-import-test",
      principalId: randomUUID(),
    });
    const other = await profiles.resolve({
      provider: "understanding-import-test",
      principalId: randomUUID(),
    });
    const service = new UnderstandingImportService(runtime.db);
    const input = understandingImportV2Fixture(randomUUID());
    const { input_hash } = await prepareUnderstandingImport(input);
    const saved = await service.commit(ctx, input, input_hash);
    const prefix = (await requestHash([input.namespace])).slice(0, 24);
    const batchGroup = `import:${prefix}`;
    const treadmill = `${batchGroup}:exp.treadmill`;
    const monitor = `${batchGroup}:exp.monitor_plan`;
    expect(saved).toMatchObject({ experiences: 2, answer_bindings: 1, replayed: false });
    expect(saved.experience_groups).toEqual([
      { key: "exp.treadmill", independence_group: treadmill },
      { key: "exp.monitor_plan", independence_group: monitor },
    ]);
    const view = await service.read(ctx, String(saved.id));
    const claimKey = (insightKey: string) => input.insights.find((i) => i.key === insightKey)!;
    const revisionOf = (insightKey: string) => {
      const text = claimKey(insightKey).revisions[0]!.text;
      return view.revisions.find((row) => row.text === text)!;
    };
    const groupsOf = (insightKey: string) => [
      ...new Set(
        view.evidence
          .filter((row) => row.claimRevisionId === revisionOf(insightKey).id)
          .map((row) => row.independenceGroup),
      ),
    ];
    // Same experience shares one group, different experiences are separate, unassigned stays batch-wide.
    expect(groupsOf("u.treadmill_usage")).toEqual([treadmill]);
    expect(groupsOf("u.treadmill_hanging")).toEqual([treadmill]);
    expect(groupsOf("q.treadmill_goal.B")).toEqual([treadmill]);
    expect(groupsOf("u.monitor_plan")).toEqual([monitor]);
    expect(groupsOf("u.running")).toEqual([batchGroup]);
    expect(groupsOf("u.course")).toEqual([batchGroup]);
    // The answer is elicited; the claim is a derived self-report that points back at the question.
    const answered = revisionOf("q.treadmill_goal.B");
    expect(answered.mode).toBe("self_report");
    expect(answered.text).toBe(claimKey("q.treadmill_goal.B").revisions[0]!.text);
    const details = StoredUnderstandingDetails.parse(answered.details);
    expect(details).toMatchObject({
      schema_version: "personal-understanding@2",
      text_basis: "derived_summary",
      answer_binding: claimKey("q.treadmill_goal.B").revisions[0]!.answer_binding,
      experiences: [{ key: "exp.treadmill", nature: "occurred", independence_group: treadmill }],
    });
    const answerRow = view.evidence.find(
      (row) =>
        row.claimRevisionId === answered.id &&
        row.relation === "supports" &&
        (row.locator as { start: number }).start === 0,
    )!;
    expect(answerRow.rationale).toContain("elicited_by");
    expect(
      view.evidence.find(
        (row) => row.relation === "supports" && row.claimRevisionId !== answered.id,
      )!.rationale,
    ).not.toContain("elicited_by");
    expect(StoredUnderstandingDetails.parse(revisionOf("u.running").details)).toMatchObject({
      experiences: [],
    });
    // "Agreement" is feedback on the proposition, not a second claim by the person.
    const proposition = revisionOf("a.relief_check");
    expect(proposition.mode).toBe("interpretation");
    expect(view.feedback).toHaveLength(1);
    expect(view.feedback[0]).toMatchObject({
      targetType: "claim_revision",
      targetId: proposition.id,
      feedbackType: "fact_agreement",
      sourceItemId: view.sources.find((row) => row.sourceMeta?.external_id === "u3")!.id,
    });
    expect(view.revisions.every((row) => row.status === "candidate")).toBe(true);
    // Replay returns the original receipt without writing again; changed content cannot overwrite.
    expect(await service.commit(ctx, input, input_hash)).toMatchObject({
      replayed: true,
      id: saved.id,
    });
    const again = await service.read(ctx, String(saved.id));
    expect(again.revisions).toHaveLength(view.revisions.length);
    expect(again.evidence).toHaveLength(view.evidence.length);
    const changed = structuredClone(input);
    (
      changed.insights.find((i) => i.key === "u.running")!.revisions[0]!.evidence[0] as {
        experience_key?: string;
      }
    ).experience_key = "exp.monitor_plan";
    (
      changed.insights.find((i) => i.key === "u.running")!.revisions[0]!.origin as {
        experience_key?: string;
      }
    ).experience_key = "exp.monitor_plan";
    const next = await prepareUnderstandingImport(changed);
    expect(next.input_hash).not.toBe(input_hash);
    await expect(service.commit(ctx, changed, next.input_hash)).rejects.toMatchObject({
      code: "SOURCE_VERSION_CONFLICT",
    });
    await expect(service.read(other, String(saved.id))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Deleting the assistant's question erases the derived claim and its bound fragments, but not unrelated claims.
    const question = view.sources.find((row) => row.sourceMeta?.external_id === "a1")!;
    await withProfileTransaction(runtime.db, ctx, async (tx) => {
      await tx
        .update(coreSchema.sourceItems)
        .set({ content: "", usageStatus: "deleted", sourceMeta: {} })
        .where(eq(coreSchema.sourceItems.id, question.id));
      await invalidateCloudSources(tx, ctx, [question.id], true);
    });
    const redacted = await service.read(ctx, String(saved.id));
    const erased = redacted.revisions.find((row) => row.id === answered.id)!;
    expect(erased.text).toBe("");
    expect(JSON.stringify(erased.details)).toBe("{}");
    expect(
      redacted.revisions.find((row) => row.id === revisionOf("u.treadmill_usage").id)!.text,
    ).not.toBe("");
    await service.commit(ctx, input, input_hash);
    expect(
      (await service.read(ctx, String(saved.id))).revisions.find((row) => row.id === answered.id)!
        .text,
    ).toBe("");
  } finally {
    await Promise.all([runtime.sql.end(), identity.sql.end()]);
  }
});
