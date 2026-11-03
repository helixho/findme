const base = (import.meta.env.VITE_CORE_API_BASE ?? "").replace(/\/$/, "");
let profile = "";
let epoch = 0;
// Account-wide operations survive Profile switches, but never a session reset.
let sessionEpoch = 0;
const prefix = "findme_cloud:";
export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function selectCloudProfile(id: string) {
  profile = id;
  epoch++;
  sessionStorage.setItem(`${prefix}profile`, id);
}
export function currentCloudProfile() {
  return profile;
}
export function resetCloudSession() {
  sessionEpoch++;
  profile = "";
  epoch++;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith(prefix)) localStorage.removeItem(k);
  }
  sessionStorage.removeItem(`${prefix}profile`);
}
export async function cloudRequest<T>(
  path: string,
  init: RequestInit = {},
  scoped = true,
): Promise<T> {
  const start = epoch;
  const sessionStart = sessionEpoch;
  const selected = profile;
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string") headers.set("content-type", "application/json");
  if (scoped && profile) headers.set("X-FindMe-Profile", profile);
  const response = await fetch(base + path, {
    ...init,
    headers,
    credentials: "include",
    cache: "no-store",
    redirect: "error",
  });
  if (sessionStart !== sessionEpoch || (scoped && (start !== epoch || profile !== selected)))
    throw new CloudApiError(409, "PROFILE_CHANGED");
  const payload = response.ok ? await response.json() : await response.json().catch(() => null);
  if (sessionStart !== sessionEpoch || (scoped && (start !== epoch || profile !== selected)))
    throw new CloudApiError(409, "PROFILE_CHANGED");
  if (!response.ok) {
    throw new CloudApiError(
      response.status,
      payload?.error?.code ?? payload?.code ?? `HTTP_${response.status}`,
    );
  }
  return payload as T;
}
/** Read the complete source inventory before presenting a fixed selection. */
export async function cloudSources<T>() {
  const selected = profile;
  const start = epoch;
  const items: T[] = [];
  const seen = new Set<number>();
  let cursor: number | null = 0;
  while (cursor !== null) {
    if (seen.has(cursor)) throw new CloudApiError(502, "SOURCE_CURSOR_REPEATED");
    seen.add(cursor);
    const page: { items: T[]; next_cursor?: number | null } = await cloudRequest(
      `/api/data/sources?cursor=${cursor}`,
    );
    if (selected !== profile || start !== epoch) throw new CloudApiError(409, "PROFILE_CHANGED");
    items.push(...page.items);
    cursor = page.next_cursor ?? null;
  }
  return items;
}

/** True for a 202 "still processing" reply; its idempotency key must be kept. */
export function isProcessingReply(value: unknown): value is { status: "processing" } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "processing" &&
    !("phase" in value)
  );
}

export async function cloudMutation<T>(
  path: string,
  body: unknown,
  method = "POST",
  scoped = true,
): Promise<T> {
  const start = epoch;
  const sessionStart = sessionEpoch;
  const selected = profile;
  const serialized = JSON.stringify(body);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  const hash = Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
  if (sessionStart !== sessionEpoch || (scoped && (start !== epoch || selected !== profile)))
    throw new CloudApiError(409, "PROFILE_CHANGED");
  const cacheKey = prefix + [base, scoped ? profile : "account", method, path, hash].join(":");
  const key = localStorage.getItem(cacheKey) ?? crypto.randomUUID();
  localStorage.setItem(cacheKey, key);
  try {
    const result = await cloudRequest<T>(
      path,
      { method, headers: { "Idempotency-Key": key }, body: serialized },
      scoped,
    );
    // A request still running must be retried with the same key, never a new one.
    if (!isProcessingReply(result)) localStorage.removeItem(cacheKey);
    return result;
  } catch (error) {
    if (error instanceof CloudApiError && error.status < 500 && error.status !== 409)
      localStorage.removeItem(cacheKey);
    throw error;
  }
}
export async function cloudFile(path: string, init: RequestInit = {}) {
  const selected = profile;
  const start = epoch;
  const headers = new Headers(init.headers);
  if (profile) headers.set("X-FindMe-Profile", profile);
  const response = await fetch(base + path, {
    ...init,
    headers,
    credentials: "include",
    cache: "no-store",
  });
  if (start !== epoch || selected !== profile) throw new CloudApiError(409, "PROFILE_CHANGED");
  if (!response.ok) throw new CloudApiError(response.status, `HTTP_${response.status}`);
  return response;
}
export async function cloudFrameworkFetch(path: string, init: RequestInit = {}) {
  if (!path.startsWith("/api/understanding/frameworks/"))
    return new Response(null, { status: 403 });
  let body = init.body;
  const resumeOnly = path.endsWith("/continue?resume_only=1");
  if (path.endsWith("/continue") || resumeOnly) {
    if (
      !resumeOnly &&
      !window.confirm("本次框架处理最多使用 2 次 DeepSeek 请求（生成与独立审核）。确认继续？")
    )
      return new Response(JSON.stringify({ error: { code: "USER_CANCELLED" } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    body = JSON.stringify({
      ...JSON.parse(String(body ?? "{}")),
      provider_call_cap: resumeOnly ? 0 : 2,
    });
  }
  return cloudFile(path, { ...init, body });
}
