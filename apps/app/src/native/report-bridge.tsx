import { CoreReportTarget } from "@findme/core";

export const bridgeStorage = "findme_core_report_exploration";

export type ReportBridgeState = {
  target: CoreReportTarget;
  explorationId?: string;
  event?: string;
  active: boolean;
};

export function readReportBridge(): ReportBridgeState | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(bridgeStorage) ?? "null");
    const target = CoreReportTarget.safeParse(stored?.target);
    return target.success && typeof stored.active === "boolean"
      ? {
          target: target.data,
          active: stored.active,
          explorationId:
            typeof stored.explorationId === "string" ? stored.explorationId : undefined,
          event: typeof stored.event === "string" ? stored.event : undefined,
        }
      : null;
  } catch {
    return null;
  }
}

export function storeReportBridge(value: ReportBridgeState) {
  try {
    sessionStorage.setItem(bridgeStorage, JSON.stringify(value));
  } catch {
    /* In-memory flow remains available. */
  }
}
