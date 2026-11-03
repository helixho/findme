import type { ErrorHandler } from "hono";
import { ZodError } from "zod";
import { CoreError } from "../core/errors.js";
import { classifyGlobalErrorCode, isPublicReportAdapterError } from "./error-catalog.js";

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
