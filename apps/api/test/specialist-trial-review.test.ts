import { randomUUID } from "node:crypto";
import type { Db, specialistSchema } from "@findme/db";
import { describe, expect, it, vi } from "vitest";
import { digest } from "../src/shared/primitives.js";
import { executionLabels, outcomeLabels } from "../src/specialist/policy.js";
import { ownedTrial } from "../src/specialist/repository.js";
import { reviewTrial } from "../src/specialist/trials.js";

vi.mock("../src/specialist/repository.js", () => ({ ownedTrial: vi.fn(), ownedProposal: vi.fn() }));
type Trial = typeof specialistSchema.specialistTrials.$inferSelect;
const ctx = { tenantId: randomUUID(), subjectId: randomUUID() };
const input = {
  expected_version: 2,
  execution: "completed" as const,
  outcome: "helpful" as const,
  continue_trial: false,
};
describe("specialist review state / mocked repository, no PostgreSQL", () => {
  it("reports an already completed trial as a conflict before creating a source", async () => {
    vi.mocked(ownedTrial).mockResolvedValue({
      id: randomUUID(),
      status: "completed",
      version: 2,
      reviewHistory: [],
    } as unknown as Trial);
    const transaction = vi.fn();
    expect(await reviewTrial({ transaction } as unknown as Db, ctx, randomUUID(), input)).toEqual({
      status: 409,
      body: { error: "trial_completed" },
    });
    expect(transaction).not.toHaveBeenCalled();
  });
  it("replays exactly the acknowledged review without a new write or invalidation", async () => {
    const source = { id: randomUUID() };
    const trial = {
      id: randomUUID(),
      status: "completed",
      version: 3,
      reviewHistory: [
        {
          ...input,
          prior_trial_version: 2,
          // Wording is in the review source; history keeps only its hash.
          self_report_hash: digest(
            [
              "本人行动尝试回顾",
              `执行情况：${executionLabels.completed}。`,
              `实际作用：${outcomeLabels.helpful}。`,
              "后续选择：结束本次尝试。",
            ].join("\n"),
          ),
          related_claim_revision_id: null,
          source_id: source.id,
        },
      ],
    } as unknown as Trial;
    vi.mocked(ownedTrial).mockResolvedValue(trial);
    const transaction = vi.fn();
    const db = {
      transaction,
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [source] }) }) }),
    } as unknown as Db;
    expect(await reviewTrial(db, ctx, trial.id, input)).toMatchObject({
      status: 200,
      body: { replayed: true, source, trial },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(await reviewTrial(db, ctx, trial.id, { ...input, outcome: "worse" })).toMatchObject({
      status: 409,
      body: { error: "version_conflict" },
    });
  });
  it("does not mistake a pause after an earlier matching review for a replay", async () => {
    const trial = {
      id: randomUUID(),
      status: "paused",
      version: 3,
      reviewHistory: [
        {
          ...input,
          prior_trial_version: 1,
          burden: null,
          observation: null,
          related_claim_revision_id: null,
        },
      ],
    } as unknown as Trial;
    vi.mocked(ownedTrial).mockResolvedValue(trial);
    expect(await reviewTrial({} as Db, ctx, trial.id, input)).toMatchObject({
      status: 409,
      body: { error: "version_conflict" },
    });
  });
});
