import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import type { NativeReportService } from "../core/report-bridge.js";
import type { PrivateUnderstandingRepository } from "./repository.js";

/** Node-only adapter: the runtime explicitly injects this; Worker never imports it. */
export function createPrivateCoreReportService(
  repository: PrivateUnderstandingRepository,
): NativeReportService {
  const configured = repository.options.coreBridge;
  if (!configured || typeof configured.verifySource !== "function")
    throw new Error("CORE_SOURCE_LIFECYCLE_REQUIRED");
  const owner = configured.owner;
  async function scoped<T>(ctx: PersonalContext, run: () => Promise<T>): Promise<T> {
    if (ctx.tenantId !== owner.tenantId || ctx.subjectId !== owner.subjectId)
      throw new CoreError("REPORT_OWNER_MISMATCH", 403, "当前身份无权读取这份私有报告");
    try {
      return await run();
    } catch (e) {
      if (e instanceof CoreError) throw e;
      const code = e instanceof Error ? e.message : "";
      // Reuse U3's public error contract without exposing private paths or provider output.
      const status = [
        "STALE_REPORT_VERSION",
        "STALE_EXPLORATION_CONTEXT",
        "IDEMPOTENCY_CONFLICT",
        "REVISION_SOURCE_RACE",
        "SOURCE_LIFECYCLE_CONFLICT",
        "REPORT_SOURCE_BLOCKED",
        "SOURCE_RETIRED_REBIND_REQUIRED",
      ].includes(code)
        ? 409
        : ["FINDING_NOT_FOUND", "IDEMPOTENCY_KEY_REQUIRED"].includes(code)
          ? 400
          : 422;
      throw Object.assign(new Error("REPORT_ADAPTER_ERROR"), {
        publicCode: /^[A-Z0-9_]+$/.test(code) ? code : "UNDERSTANDING_INTEGRITY_ERROR",
        publicStatus: status,
      });
    }
  }
  return {
    sourceLifecycle: true,
    validateTarget: (ctx, target) => scoped(ctx, () => repository.validateCoreTarget(target)),
    read: (ctx) => scoped(ctx, () => repository.read()),
    history: (ctx, domain, limit) => scoped(ctx, () => repository.history(domain, limit)),
    version: (ctx, domain, version) => scoped(ctx, () => repository.version(domain, version)),
    retireSource: (ctx, input) => scoped(ctx, () => repository.retireSource(input)),
    rebindSource: (ctx, input, binding, note) =>
      scoped(ctx, () => repository.rebindSource(input, binding, note)),
    recoverTopic: (ctx, domain, version, recovery) =>
      scoped(ctx, () => repository.recoverTopic(domain, version, recovery)),
    evidences: (ctx, domain, version, ids) =>
      scoped(ctx, () => repository.evidences(domain, version, ids)),
    save: (ctx, input, key) => scoped(ctx, () => repository.save(input, key)),
    saveCore: (ctx, input, key, binding) =>
      scoped(ctx, () => repository.saveCore(input, key, binding)),
    process: (ctx, id, recovery) => scoped(ctx, () => repository.process(id, recovery)),
    processOverall: (ctx, request, recovery) =>
      scoped(ctx, () => repository.processOverall(request, recovery)),
  };
}
