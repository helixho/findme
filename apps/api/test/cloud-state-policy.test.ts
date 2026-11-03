import { describe, expect, it } from "vitest";
import {
  type CloudJobStatus,
  claimQueuedJob,
  invalidatesQueuedJob,
  jobReservationBlocked,
  processingFailureStatus,
  profileCapExhausted,
  recoveryDecision,
  reuseProcessingJob,
} from "../src/cloud-diagnostic/processing-policy.js";

const now = new Date("2026-10-31T00:00:00Z");
const base = {
  status: "failed" as CloudJobStatus,
  leaseUntil: null,
  error: null,
  callsUsed: 2,
  callCap: 4,
};

describe("cloud job decisions (pure characterization, no database/model guarantees)", () => {
  it.each<[CloudJobStatus, boolean, boolean, string | null]>([
    ["queued", true, true, null],
    ["running", false, true, null],
    ["completed", false, true, "EXPLICIT_RECOVERY_NOT_AVAILABLE"],
    ["failed", false, true, null],
    ["cancelled", false, false, "EXPLICIT_RECOVERY_NOT_AVAILABLE"],
    ["stale", false, false, "EXPLICIT_RECOVERY_NOT_AVAILABLE"],
    ["rejected", false, true, "EXPLICIT_RECOVERY_NOT_AVAILABLE"],
  ])(
    "%s: queue claim / explicit process reuse / explicit resume",
    (status, claim, reuse, error) => {
      expect(claimQueuedJob(status)).toBe(claim);
      expect(reuseProcessingJob(status)).toBe(reuse);
      expect(recoveryDecision({ ...base, status }, 4, 8, now).error).toBe(error);
    },
  );

  it("retains decisions for an unrecognized database text status", () => {
    expect(claimQueuedJob("future_status")).toBe(false);
    expect(reuseProcessingJob("future_status")).toBe(true);
    expect(recoveryDecision({ ...base, status: "future_status" }, 4, 8, now).error).toBe(
      "EXPLICIT_RECOVERY_NOT_AVAILABLE",
    );
  });

  it.each([
    [null, null],
    [new Date(now.getTime() - 1), null],
    [now, null],
    [new Date(now.getTime() + 1), "EXPLICIT_RECOVERY_NOT_AVAILABLE"],
  ])("running lease %s: recovery only after lease expires", (leaseUntil, error) => {
    expect(recoveryDecision({ ...base, status: "running", leaseUntil }, 4, 8, now).error).toBe(
      error,
    );
  });

  it.each(["queued", "failed"] as const)("%s ignores a retained future lease", (status) => {
    expect(
      recoveryDecision({ ...base, status, leaseUntil: new Date(now.getTime() + 1) }, 4, 8, now),
    ).toEqual({ error: null, checkProfileBudget: false });
  });

  it.each([
    [null, false],
    ["PROVIDER_TIMEOUT", false],
    ["PROVIDER_RATE_LIMIT", false],
    ["INTERRUPTED", false],
    ["PROCESSING_FAILED", false],
    ["JOB_CALL_CAP_EXHAUSTED", true],
    ["PROFILE_CALL_CAP_EXHAUSTED", true],
  ])("recoverable error %s retains profile budget decision", (error, checkProfileBudget) => {
    expect(recoveryDecision({ ...base, error }, 5, 8, now)).toEqual({
      error: null,
      checkProfileBudget,
    });
  });

  it.each([
    "SOURCE_CHANGED",
    "TOPIC_CHANGED",
    "PROCESSING_VERSION_CHANGED",
    "REPORT_INVALID",
    "USER_CANCELLED",
    "PROVIDER_timeout",
    "xPROVIDER_TIMEOUT",
  ])("%s requires new input, even with a higher cap", (error) => {
    expect(recoveryDecision({ ...base, error }, 5, 8, now).error).toBe("NEW_INPUT_REQUIRED");
  });

  it.each([
    [1, null, "JOB_BUDGET_INVALID"],
    [2, null, null],
    [4, null, null],
    [8, null, null],
    [9, null, "JOB_BUDGET_INVALID"],
    [3, "JOB_CALL_CAP_EXHAUSTED", "JOB_BUDGET_INVALID"],
    [4, "JOB_CALL_CAP_EXHAUSTED", "JOB_BUDGET_INVALID"],
    [5, "JOB_CALL_CAP_EXHAUSTED", null],
    [4, "PROFILE_CALL_CAP_EXHAUSTED", "JOB_BUDGET_INVALID"],
    [5, "PROFILE_CALL_CAP_EXHAUSTED", null],
  ])("resume cap %s error %s -> %s", (cap, error, expected) => {
    expect(recoveryDecision({ ...base, error }, cap, 8, now).error).toBe(expected);
  });

  it("preserves rejection precedence and cumulative usage even when caps rise", () => {
    expect(
      recoveryDecision({ ...base, status: "completed", error: "SOURCE_CHANGED" }, 0, 8, now).error,
    ).toBe("EXPLICIT_RECOVERY_NOT_AVAILABLE");
    expect(recoveryDecision({ ...base, error: "SOURCE_CHANGED" }, 0, 8, now).error).toBe(
      "NEW_INPUT_REQUIRED",
    );
    expect(
      recoveryDecision({ ...base, callsUsed: 7, error: "JOB_CALL_CAP_EXHAUSTED" }, 6, 8, now).error,
    ).toBe("JOB_BUDGET_INVALID");
  });

  it.each([
    [0, 0, true],
    [3, 4, false],
    [4, 4, true],
    [5, 4, true],
  ] as const)("profile calls %s / cap %s", (used, limit, exhausted) => {
    expect(profileCapExhausted(used, limit)).toBe(exhausted);
  });

  it.each<[CloudJobStatus, string | null, number, number, boolean]>([
    ["running", "owner", 3, 4, false],
    ["running", "owner", 4, 4, true],
    ["running", "owner", 5, 4, true],
    ["running", "other", 0, 4, true],
    ["running", null, 0, 4, true],
    ["queued", "owner", 0, 4, true],
    ["completed", "owner", 0, 4, true],
    ["failed", "owner", 0, 4, true],
    ["cancelled", "owner", 0, 4, true],
    ["stale", "owner", 0, 4, true],
    ["rejected", "owner", 0, 4, true],
  ])("reservation %s / %s / %s / %s", (status, execution, callsUsed, callCap, blocked) => {
    expect(jobReservationBlocked({ status, execution, callsUsed, callCap }, "owner")).toBe(blocked);
  });

  it.each([
    ["SOURCE_CHANGED", true, "stale"],
    ["TOPIC_CHANGED", true, "stale"],
    ["PROCESSING_VERSION_CHANGED", true, "stale"],
    ["STALE_VERSION", false, "failed"],
    ["PUBLICATION_BASIS_CHANGED", false, "failed"],
    ["QUALIFICATION_INVALID", false, "rejected"],
    ["REPORT_INVALID", false, "rejected"],
    ["AUDIT_FAILED", false, "rejected"],
    ["REFERENCE_INVALID", false, "rejected"],
    ["CONTEXT_INVALID", false, "rejected"],
    ["PROVIDER_TIMEOUT", false, "failed"],
    ["JOB_CALL_CAP_EXHAUSTED", false, "failed"],
    ["PROFILE_CALL_CAP_EXHAUSTED", false, "failed"],
    ["QUALIFICATION_SOURCE_CHANGED", false, "stale"],
    ["xSOURCE_CHANGED", false, "stale"],
    ["CHECKPOINT_CHANGED", false, "failed"],
  ])("%s: queued invalidation %s, execution failure %s", (code, queued, failure) => {
    expect(invalidatesQueuedJob(code)).toBe(queued);
    expect(processingFailureStatus(code)).toBe(failure);
  });
});
