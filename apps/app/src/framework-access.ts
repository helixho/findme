import { clearAccessToken, getAccessToken, privateUnderstandingMode } from "./api";
import type { FrameworkAuthFetch } from "./framework-api";

/** Private composition only. Never forwards a private owner token to a remote API. */
export const frameworkAuthFetch: FrameworkAuthFetch = async (input, init = {}) => {
  if (!privateUnderstandingMode || !input.startsWith("/api/understanding/frameworks/")) {
    return new Response(JSON.stringify({ error: { code: "FRAMEWORK_RUNTIME_UNAVAILABLE" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  const headers = new Headers(init.headers);
  const token = getAccessToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers, redirect: "error", cache: "no-store" });
  if (response.status === 401) clearAccessToken();
  return response;
};
