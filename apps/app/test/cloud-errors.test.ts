import { describe, expect, it } from "vitest";
import { CloudApiError } from "../src/cloud-api";
import { message } from "../src/cloud/shared";

describe("model error recovery messages", () => {
  it.each([
    ["LLM_TIMEOUT", "模型响应超时"],
    ["LLM_PROVIDER", "模型服务暂时无法响应"],
    ["LLM_QUOTA", "模型服务额度不足"],
    ["LLM_RATE_LIMIT", "模型服务请求受限"],
    ["LLM_AUTHENTICATION", "模型服务认证失败"],
    ["LLM_MODEL_NOT_FOUND", "所选模型不可用"],
    ["LLM_BAD_REQUEST", "模型服务未接受请求"],
    ["LLM_JSON_PARSE", "模型未返回可用结果"],
    ["LLM_SCHEMA_VALIDATION", "模型返回结果不符合要求"],
  ])("explains %s", (code, text) => {
    expect(message(new CloudApiError(503, code))).toContain(text);
  });
  it("offers a status refresh when an unstructured failure leaves the result unknown", () => {
    expect(message(new CloudApiError(502, "HTTP_502"))).toContain("请先刷新状态");
    expect(message(new CloudApiError(500, "internal"))).toContain("请先刷新状态");
    expect(message(new CloudApiError(502, "HTTP_502"))).not.toContain("已保存");
  });
  it("preserves other error contracts", () => {
    expect(message(new CloudApiError(503, "TEMPORARY_FAILURE"))).toBe("TEMPORARY_FAILURE");
    expect(message(new CloudApiError(409, "STALE_VERSION"))).toBe("STALE_VERSION");
    expect(message(new Error("ordinary error"))).toBe("ordinary error");
  });
});
