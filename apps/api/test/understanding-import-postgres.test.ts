import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import { understandingImportFixture } from "./helpers/understanding-import-fixture.js";

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
    const { input_hash } = await prepareUnderstandingImport(input);
    const saved = await service.commit(ctx, input, input_hash);
    const id = String(saved.id);
    const view = await service.read(ctx, id);
    expect(view.sources).toHaveLength(5);
    expect(view.revisions.map((row) => row.status).sort()).toEqual(["candidate", "withdrawn"]);
    expect(view.revisions.every((row) => row.details.domains)).toBe(true);
    expect(view.feedback[0]!).toMatchObject({ feedbackType: "insight_usefulness", note: "" });
    expect(view.sources.find((row) => row.id === view.feedback[0]!.sourceItemId)?.content).toBe(
      input.sources[4]!.text,
    );
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
