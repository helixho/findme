import type { ErrorHandler } from "hono";
import { ZodError } from "zod";
import { CoreError } from "../core/errors.js";
import { type GatewayErrorKind, GatewayRequestError } from "../llm/gateway.js";
import { classifyGlobalErrorCode, isPublicReportAdapterError } from "./error-catalog.js";

const gatewayErrors = {
  timeout: { status: 504, message: "模型响应超时，请稍后重试" },
  provider: { status: 502, message: "模型服务暂时无法响应，请稍后重试" },
  quota: { status: 503, message: "模型服务额度不足，请检查模型设置" },
  rate_limit: { status: 503, message: "模型服务请求受限，请稍后重试" },
  authentication: { status: 503, message: "模型服务认证失败，请检查模型设置" },
  model_not_found: { status: 503, message: "所选模型不可用，请检查模型设置" },
  bad_request: { status: 503, message: "模型服务未接受请求，请检查模型设置" },
  json_parse: { status: 502, message: "模型未返回可用结果，可以稍后重新处理" },
  schema_validation: { status: 502, message: "模型返回结果不符合要求，可以稍后重新处理" },
} as const satisfies Record<GatewayErrorKind, { status: 502 | 503 | 504; message: string }>;

export const onError: ErrorHandler = (err, c) => {
  if (isPublicReportAdapterError(err)) {
    return c.json({ error: { code: err.publicCode } }, err.publicStatus);
  }
  if (err instanceof CoreError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ?? {}),
        },
      },
      err.status,
    );
  }

  if (err instanceof GatewayRequestError) {
    const contract = gatewayErrors[err.kind];
    // The fixed kind distinguishes provider/configuration/output failures
    // without logging prompts, raw provider responses or credentials.
    console.error("gateway_error", err.kind);
    return c.json(
      { error: { code: `LLM_${err.kind.toUpperCase()}`, message: contract.message } },
      contract.status,
    );
  }

  if (err instanceof ZodError || err instanceof SyntaxError)
    return c.json({ error: { code: "INVALID_INPUT" } }, 400);
  const code = err.message;
  const contract = code === "REPORT_ADAPTER_ERROR" ? undefined : classifyGlobalErrorCode(code);
  if (contract) return c.json({ error: { code } }, contract.status);
  // Keep database/provider details out of the response. Log only the error
  // class so production diagnostics cannot accidentally include user content.
  console.error("internal_error", err instanceof Error ? err.name : "unknown");
  return c.json({ error: { code: "internal", message: "服务暂不可用" } }, 500);
};
