import type {
  CoreReportTarget,
  CoreReportTransferInput,
  UnderstandingAppView,
  UnderstandingExactEvidence,
  UnderstandingFeedbackInput,
  UnderstandingFeedbackReceipt,
  UnderstandingOverallRequest,
  UnderstandingRecoveryRequest,
  UnderstandingReportHistory,
  UnderstandingSourceAction,
  UnderstandingSourceRebind,
  UnderstandingVersionView,
} from "@findme/core";
import type {
  CompleteResponse,
  ContinueResponse,
  CurrentUnderstandingResponse,
  ExplorationListResponse,
  ExplorationView,
  RespondResponse,
  RevisionResponse,
  StartResponse,
  UnderstandingResponse,
} from "./types";

export const privateUnderstandingMode =
  document.querySelector('meta[name="findme-private-host"]')?.getAttribute("content") ===
  "understanding";
const TOKEN_KEY = privateUnderstandingMode
  ? "findme_private_understanding_token"
  : "findme_core_access_token";
const MUTATION_KEY_PREFIX = "findme_core_mutation:";
const API_BASE = privateUnderstandingMode ? "" : (import.meta.env.VITE_CORE_API_BASE ?? "");

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function getAccessToken() {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export async function hydrateAccessFromHash() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const directToken = params.get("access_token")?.trim();
  const bootstrap = params.get("bootstrap")?.trim();

  if (directToken) {
    setAccessToken(directToken);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    return true;
  }

  if (!bootstrap || privateUnderstandingMode) return false;
  const response = await fetch(`${API_BASE}/api/core/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: bootstrap }),
  });
  if (!response.ok) return false;
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) return false;
  setAccessToken(body.access_token);
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return true;
}

export function setAccessToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearAccessToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function parseApiError(response: Response) {
  const fallback = `request_failed_${response.status}`;
  const payload = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string; [key: string]: unknown };
  } | null;
  const error = payload?.error;
  const { code, message, ...details } = error ?? {};
  return new ApiError(
    response.status,
    typeof code === "string" ? code : fallback,
    typeof message === "string" ? message : fallback,
    details,
  );
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (privateUnderstandingMode && !path.startsWith("/api/understanding"))
    throw new ApiError(403, "NATIVE_CORE_UNAVAILABLE_PRIVATE_HOST", "私有理解入口暂不提供原生探索");
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);

  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (response.status === 401) {
    clearAccessToken();
    throw new ApiError(401, "unauthorized", "访问权限已失效");
  }
  if (!response.ok) throw await parseApiError(response);
  return response.json() as Promise<T>;
}

export const understandingApi = {
  process: (id: string, recovery: UnderstandingRecoveryRequest = {}) =>
    request<UnderstandingFeedbackReceipt>(
      `/api/understanding/feedback/${encodeURIComponent(id)}/process`,
      { method: "POST", body: JSON.stringify(recovery) },
    ),
  processOverall: (
    requestBody: UnderstandingOverallRequest,
    recovery: UnderstandingRecoveryRequest = {},
  ) =>
    request<UnderstandingAppView>("/api/understanding/overall/process", {
      method: "POST",
      body: JSON.stringify({ request: requestBody, recovery }),
    }),
  read: () => request<UnderstandingAppView>("/api/understanding"),
  history: (domain: string) =>
    request<UnderstandingReportHistory>(
      `/api/understanding/history?${new URLSearchParams({ domain, limit: "30" })}`,
    ),
  version: (domain: string, version: string) =>
    request<UnderstandingVersionView>(
      `/api/understanding/version?${new URLSearchParams({ domain, version })}`,
    ),
  retireSource: (body: UnderstandingSourceAction) =>
    request<UnderstandingAppView>("/api/understanding/sources/retire", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  rebindSource: (body: UnderstandingSourceRebind) =>
    request<UnderstandingAppView>(
      privateUnderstandingMode
        ? "/api/understanding/sources/rebind"
        : "/api/core/report-sources/rebind",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  recoverTopic: (domain: string, version: string, recovery: UnderstandingRecoveryRequest = {}) =>
    request<unknown>("/api/understanding/topics/recover", {
      method: "POST",
      body: JSON.stringify({ domain, version, recovery }),
    }),
  evidences: (domain: string, version: string, ids: string[]) => {
    const params = new URLSearchParams({ domain, version });
    for (const id of ids) params.append("id", id);
    return request<UnderstandingExactEvidence[]>(`/api/understanding/evidence/batch?${params}`);
  },
  evidence: (domain: string, version: string, id: string) =>
    request<UnderstandingExactEvidence>(
      `/api/understanding/evidence?${new URLSearchParams({ domain, version, id })}`,
    ),
  save: (body: UnderstandingFeedbackInput, key: string) =>
    request<UnderstandingFeedbackReceipt>("/api/understanding/feedback", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(body),
    }),
};

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function idempotencyKey(scope: string, body: Record<string, unknown>) {
  const fingerprint = await sha256(JSON.stringify(body));
  const storageKey = `${MUTATION_KEY_PREFIX}${scope}`;
  const previous = localStorage.getItem(storageKey);
  if (previous) {
    try {
      const parsed = JSON.parse(previous) as { fingerprint?: string; key?: string };
      if (parsed.fingerprint === fingerprint && parsed.key) {
        return { key: parsed.key, storageKey };
      }
    } catch {
      // Replace unreadable local state below.
    }
  }
  const key = crypto.randomUUID();
  localStorage.setItem(storageKey, JSON.stringify({ fingerprint, key }));
  return { key, storageKey };
}

function clearMutation(storageKey: string) {
  localStorage.removeItem(storageKey);
}

async function pollOperation<T>(operationId: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const operation = await request<{
      status: string;
      response_status: number | null;
      response_body: T | null;
    }>(`/api/core/operations/${operationId}`);

    if (operation.status === "completed" && operation.response_body) {
      return operation.response_body;
    }
    if (operation.status === "failed" || operation.status === "stale") {
      throw new ApiError(
        operation.status === "stale" ? 409 : 503,
        operation.status === "stale" ? "STALE_OPERATION" : "OPERATION_FAILED",
        operation.status === "stale" ? "操作基于过期版本" : "操作未完成",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new ApiError(504, "OPERATION_TIMEOUT", "操作仍在处理中，请稍后重试");
}

async function mutate<T>(scope: string, path: string, body: Record<string, unknown>): Promise<T> {
  if (privateUnderstandingMode)
    throw new ApiError(403, "NATIVE_CORE_UNAVAILABLE_PRIVATE_HOST", "私有理解入口暂不提供原生探索");
  const { key, storageKey } = await idempotencyKey(scope, body);
  const token = getAccessToken();
  const headers = new Headers({
    "content-type": "application/json",
    "Idempotency-Key": key,
  });
  if (token) headers.set("authorization", `Bearer ${token}`);

  // On a network exception the local idempotency key is intentionally kept: the
  // server may have committed even though the response was lost.
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (response.status === 401) {
    clearAccessToken();
    clearMutation(storageKey);
    throw new ApiError(401, "unauthorized", "访问权限已失效");
  }

  if (response.status === 202) {
    const pending = (await response.json()) as { operation_id: string };
    try {
      const result = await pollOperation<T>(pending.operation_id);
      clearMutation(storageKey);
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.code !== "OPERATION_TIMEOUT") {
        clearMutation(storageKey);
      }
      throw error;
    }
  }

  if (!response.ok) {
    const error = await parseApiError(response);
    // Keep the key only for transient/provider failures. Deterministic conflicts need a new request.
    if (response.status !== 503) clearMutation(storageKey);
    throw error;
  }

  const result = (await response.json()) as T;
  clearMutation(storageKey);
  return result;
}

type RawExplorationView = Omit<ExplorationView, "understanding" | "evidence"> & {
  understanding: ExplorationView["understanding"];
  evidence: Array<{
    key: string;
    spanId?: string;
    span_id?: string;
    sourceItemId?: string;
    source_item_id?: string;
    quote: string;
    authorKind?: string;
    author_kind?: string;
    eligibility: string;
    assessmentVersion?: number | null;
    assessment_version?: number | null;
    attributionStatus?: string;
    attribution_status?: string;
    contextCompleteness?: string;
    context_completeness?: string;
    temporalPrecision?: string;
    temporal_precision?: string;
    assessmentRationale?: string | null;
    assessment_rationale?: string | null;
  }>;
};

function normalizeExploration(raw: RawExplorationView): ExplorationView {
  return {
    ...raw,
    understanding: {
      ...raw.understanding,
      gaps: (raw.understanding?.gaps ?? []).map((gap) => ({
        ...gap,
        why_it_matters: gap.why_it_matters ?? gap.whyItMatters,
      })),
    },
    evidence: (raw.evidence ?? []).map((item) => ({
      key: item.key,
      spanId: item.spanId ?? item.span_id ?? "",
      sourceItemId: item.sourceItemId ?? item.source_item_id ?? "",
      quote: item.quote,
      authorKind: item.authorKind ?? item.author_kind ?? "unknown",
      eligibility: item.eligibility,
      assessmentVersion: item.assessmentVersion ?? item.assessment_version,
      attributionStatus: item.attributionStatus ?? item.attribution_status,
      contextCompleteness: item.contextCompleteness ?? item.context_completeness,
      temporalPrecision: item.temporalPrecision ?? item.temporal_precision,
      assessmentRationale: item.assessmentRationale ?? item.assessment_rationale,
    })),
  };
}

export const coreApi = {
  capabilities: () =>
    request<{ native_core: boolean; report_bridge: boolean }>("/api/core/capabilities"),
  reportFeedback: (id: string, body: CoreReportTransferInput) =>
    mutate<UnderstandingFeedbackReceipt>(
      `report-feedback:${id}`,
      `/api/core/explorations/${encodeURIComponent(id)}/report-feedback`,
      body,
    ),
  me: () => request<{ tenant_id: string; subject_id: string }>("/api/core/me"),
  current: () => request<CurrentUnderstandingResponse>("/api/core/understanding"),
  explorations: (status: "active" | "completed" | "abandoned" = "active", limit = 20) =>
    request<ExplorationListResponse>(
      `/api/core/explorations?status=${encodeURIComponent(status)}&limit=${limit}`,
    ),
  exploration: async (id: string) =>
    normalizeExploration(await request<RawExplorationView>(`/api/core/explorations/${id}`)),
  start: (event: string, reportTarget?: CoreReportTarget) =>
    mutate<StartResponse>("start", "/api/core/explorations", {
      event,
      ...(reportTarget ? { report_target: reportTarget } : {}),
    }),
  respond: (
    explorationId: string,
    expectedVersion: number,
    questionId: string,
    answer: string,
    selectedOptions: string[] = [],
  ) =>
    mutate<RespondResponse>(
      `respond:${explorationId}`,
      `/api/core/explorations/${explorationId}/respond`,
      {
        expected_version: expectedVersion,
        question_id: questionId,
        answer,
        selected_options: selectedOptions,
      },
    ),
  correct: (
    explorationId: string,
    expectedVersion: number,
    revisionIds: string[],
    correction: { type: string; note: string },
  ) =>
    mutate<RevisionResponse>(
      `correct:${explorationId}`,
      `/api/core/explorations/${explorationId}/correct`,
      {
        expected_version: expectedVersion,
        claim_revision_ids: revisionIds,
        correction,
      },
    ),
  continue: (explorationId: string, expectedVersion: number, forceDeeper = false) =>
    mutate<ContinueResponse>(
      `continue:${explorationId}`,
      `/api/core/explorations/${explorationId}/continue`,
      { expected_version: expectedVersion, force_deeper: forceDeeper },
    ),
  amend: (
    explorationId: string,
    expectedVersion: number,
    targetSourceId: string,
    type: "supplements" | "corrects" | "updates",
    note: string,
  ) =>
    mutate<{
      exploration_id: string;
      version: number;
      phase: "ready_to_plan";
      saved: true;
      amendment: { type: string; target_source_id: string; source_id: string };
    }>(`amend:${explorationId}`, `/api/core/explorations/${explorationId}/amend`, {
      expected_version: expectedVersion,
      target_source_id: targetSourceId,
      type,
      note,
    }),
  complete: (explorationId: string, expectedVersion: number) =>
    mutate<CompleteResponse>(
      `complete:${explorationId}`,
      `/api/core/explorations/${explorationId}/complete`,
      { expected_version: expectedVersion },
    ),
  sourceAssessment: (
    sourceId: string,
    expectedAssessmentVersion: number,
    assessment: {
      attribution_status: string;
      context_completeness: string;
      temporal_precision: string;
      eligibility: string;
      rationale: string;
    },
  ) =>
    mutate<{
      source_id: string;
      assessment_version: number;
      eligibility: string;
      attribution_status: string;
      affected_claim_revision_ids: string[];
      stale_claims: number;
      invalid_claims: number;
      affected_exploration_ids: string[];
    }>(`source-assessment:${sourceId}`, `/api/core/sources/${sourceId}/assessment`, {
      expected_assessment_version: expectedAssessmentVersion,
      assessment,
    }),
};
