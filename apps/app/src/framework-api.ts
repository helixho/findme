import type { FrameworkAnswer, FrameworkCatalog, FrameworkRunView } from "@findme/core";

export type FrameworkAuthFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type FrameworkEvidence = FrameworkAnswer & {
  text: string;
  question: string;
  offset_unit: "UTF-16";
};
export class FrameworkApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
/** Required authenticated same-origin fetch. No token storage, preview or production fallback. */
export function createFrameworkApi(authFetch: FrameworkAuthFetch) {
  const root = "/api/understanding/frameworks";
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await authFetch(root + path, init);
    const body = await response.json();
    if (!response.ok)
      throw new FrameworkApiError(body?.error?.code ?? "FRAMEWORK_REQUEST_FAILED", response.status);
    return body as T;
  }
  const post = (path: string, body: unknown, key: string) =>
    request<FrameworkRunView>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
  return {
    catalog: () => request<FrameworkCatalog>("/definitions"),
    definition: (key: string, version: string) =>
      request<FrameworkCatalog["definitions"][number]>(
        `/definitions/${encodeURIComponent(key)}/${encodeURIComponent(version)}`,
      ),
    get: (id: string) => request<FrameworkRunView>(`/runs/${encodeURIComponent(id)}`),
    start: (
      body: { key: string; definition_version: string; definition_hash: string },
      key: string,
    ) => post("/runs", body, key),
    respond: (run: FrameworkRunView, text: string, key: string) =>
      post(
        `/runs/${run.id}/respond`,
        {
          expected_version: run.version,
          question_id: run.open_question?.id,
          text,
        },
        key,
      ),
    skip: (run: FrameworkRunView, key: string) =>
      post(
        `/runs/${run.id}/respond`,
        {
          expected_version: run.version,
          question_id: run.open_question?.id,
          text: "",
          skipped: true,
        },
        key,
      ),
    pause: (run: FrameworkRunView, key: string) =>
      post(`/runs/${run.id}/pause`, { expected_version: run.version }, key),
    continue: (run: FrameworkRunView, recovery: boolean, key: string) =>
      post(
        `/runs/${run.id}/continue${run.status === "paused" && run.open_question ? "?resume_only=1" : ""}`,
        {
          expected_version: run.version,
          recovery,
        },
        key,
      ),
    amend: (
      run: FrameworkRunView,
      source: string,
      action: "correct" | "exclude",
      text: string,
      reason: string,
      key: string,
    ) =>
      post(
        `/runs/${run.id}/amend`,
        {
          expected_version: run.version,
          source_id: source,
          action,
          ...(action === "correct" ? { text } : {}),
          reason,
        },
        key,
      ),
    abandon: (run: FrameworkRunView, key: string) =>
      post(`/runs/${run.id}/abandon`, { expected_version: run.version }, key),
    evidence: (run: string, source: string) =>
      request<FrameworkEvidence>(
        `/runs/${encodeURIComponent(run)}/evidence/${encodeURIComponent(source)}`,
      ),
  };
}
