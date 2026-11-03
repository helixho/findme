import type { UnderstandingFeedbackReceipt } from "@findme/core";
import { expect, it } from "vitest";
import { feedbackFact } from "../src/understanding-app/dependencies.js";

it("Core evidence uses original disclosure time, not event time or transfer time", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const feedback: UnderstandingFeedbackReceipt = {
    id: "synthetic-feedback",
    source_id: id,
    revision: 1,
    saved_at: "2026-10-07T08:00:00.000Z",
    status: "pending_analysis",
    error: null,
    result_version: null,
    input: {
      baseline_version: "synthetic",
      input_hash: "a".repeat(64),
      domain: "collaboration",
      report_version: "synthetic-report",
      type: "supplement",
      note: "这段经历发生在去年，我现在补充说明。",
    },
    core_source: {
      tenant_id: id,
      subject_id: id,
      exploration_id: id,
      source_id: id,
      assessment_version: 1,
      content_hash: "b".repeat(64),
      occurred_at: "2025-02-01T00:00:00.000Z",
      disclosed_at: "2026-10-06T08:00:00.000Z",
      attribution_basis: "synthetic typed input; meaning remains to be qualified",
    },
  };
  const fact = feedbackFact(feedback);
  expect(fact.time).toBe(feedback.core_source?.disclosed_at);
  expect(fact.time).not.toBe(feedback.core_source?.occurred_at);
  expect(fact.time).not.toBe(feedback.saved_at);
  expect(fact.canonical_id).toBe(id);
  expect(fact.root_ids).toEqual([id]);
  expect(feedback.core_source?.occurred_at).toBe("2025-02-01T00:00:00.000Z");
  expect(feedbackFact({ ...feedback, core_source: undefined }).time).toBe(feedback.saved_at);
});
