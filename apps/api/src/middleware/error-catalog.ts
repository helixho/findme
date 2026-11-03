/** This catalog describes the global onError fallback, not route-local responses.
 * CoreError carries its own status. Account middleware, report adapters and the
 * archive router intentionally have separate HTTP contracts.
 */
export type GlobalErrorCategory =
  | "auth"
  | "profile"
  | "stale"
  | "budget"
  | "input"
  | "availability"
  | "conflict";
export type GlobalErrorContract = Readonly<{
  status: 400 | 409 | 503;
  category: GlobalErrorCategory;
}>;

// Exact entries avoid deriving these meanings from overlapping words such as
// REQUIRED/UNAVAILABLE or PROFILE/CAP. Statuses retain the existing wire contract.
export const globalErrorCatalog = {
  ACCOUNT_CONTEXT_REQUIRED: { status: 400, category: "auth" },
  ACCOUNT_SESSION_UNAVAILABLE: { status: 503, category: "auth" },
  ACCOUNT_ORIGIN_REQUIRED: { status: 400, category: "auth" },
  ACCOUNT_DISABLED: { status: 503, category: "auth" },
  PROFILE_NOT_FOUND: { status: 409, category: "profile" },
  PROFILE_CREATE_FAILED: { status: 409, category: "profile" },
  PROFILE_DELETE_CONFIRMATION_REQUIRED: { status: 400, category: "profile" },
  PROFILE_DELETE_ALREADY_PENDING: { status: 409, category: "profile" },
  PROFILE_DELETE_STATE_CHANGED: { status: 409, category: "stale" },
  PROFILE_CALL_CAP_EXHAUSTED: { status: 503, category: "budget" },
  JOB_CALL_CAP_EXHAUSTED: { status: 503, category: "budget" },
  JOB_BUDGET_EXCEEDS_SERVER_LIMIT: { status: 503, category: "budget" },
  JOB_BUDGET_INSUFFICIENT: { status: 503, category: "budget" },
  FRAMEWORK_INVOCATION_CAP_EXHAUSTED: { status: 503, category: "budget" },
  PROCESSING_VERSION_CHANGED: { status: 409, category: "stale" },
  SOURCE_CHANGED: { status: 409, category: "stale" },
  REPORT_CONTENT_CHANGED: { status: 409, category: "stale" },
  QUALIFICATION_INPUT_VERSION_CHANGED: { status: 409, category: "stale" },
  QUALIFICATION_PROOF_CHANGED: { status: 409, category: "stale" },
  QUALIFICATION_ATTRIBUTION_CHANGED: { status: 409, category: "stale" },
  SOURCE_INPUT_REQUIRED: { status: 400, category: "input" },
  SOURCE_UNAVAILABLE: { status: 503, category: "availability" },
  SOURCE_EXCERPT_NOT_FULL_TEXT: { status: 409, category: "input" },
  QUALIFICATION_INPUT_BOUND_EXCEEDED: { status: 400, category: "input" },
  REPORT_REFERENCE_INVALID: { status: 400, category: "input" },
  IMPORT_TOO_LARGE: { status: 400, category: "input" },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, category: "input" },
  IDEMPOTENCY_KEY_REUSED: { status: 409, category: "conflict" },
  REPORT_QUALIFICATION_REQUIRED: { status: 400, category: "input" },
} as const satisfies Record<string, GlobalErrorContract>;
export type CatalogGlobalErrorCode = keyof typeof globalErrorCatalog;

const publicCode =
  /^(SOURCE_|PROFILE_|REPORT_|QUALIFICATION_|CANDIDATE_|CHECKPOINT_|PUBLICATION_|PROCESSING_|TOPICS_|OVERALL_|JOB_|EXPLICIT_|NEW_INPUT_|IMPORT_|EXPORT_|BLOB_|DELETE_|IDEMPOTENCY_|FRAMEWORK_|ACCOUNT_|USER_)[A-Z0-9_]+$/;

export function classifyGlobalErrorCode(code: string): GlobalErrorContract | undefined {
  if (Object.hasOwn(globalErrorCatalog, code))
    return globalErrorCatalog[code as CatalogGlobalErrorCode];
  if (!publicCode.test(code)) return undefined;
  // Compatibility fallback for uncatalogued legacy/runtime codes. Keep the
  // historical precedence, including availability before invalid/required.
  if (/DISABLED|UNAVAILABLE|BUDGET|CAP_/.test(code))
    return { status: 503, category: "availability" };
  if (/REQUIRED|INVALID|TOO_LARGE|BOUND_EXCEEDED/.test(code))
    return { status: 400, category: "input" };
  return { status: 409, category: "conflict" };
}

export function isPublicReportAdapterError(
  err: Error,
): err is Error & { publicCode: string; publicStatus: 400 | 409 | 422 } {
  if (err.message !== "REPORT_ADAPTER_ERROR") return false;
  const candidate = err as Error & { publicCode?: unknown; publicStatus?: unknown };
  return (
    typeof candidate.publicCode === "string" &&
    /^[A-Z0-9_]+$/.test(candidate.publicCode) &&
    (candidate.publicStatus === 400 ||
      candidate.publicStatus === 409 ||
      candidate.publicStatus === 422)
  );
}
