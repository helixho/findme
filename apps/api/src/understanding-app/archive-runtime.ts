import type {
  UnderstandingAppView,
  UnderstandingExactEvidence,
  UnderstandingVersionView,
} from "@findme/core";
import {
  UNDERSTANDING_APP_VERSION,
  UNDERSTANDING_VERSION,
  UnderstandingReport,
} from "@findme/core";
import { UnderstandingAudit } from "@findme/core";
import type { PersonalContext } from "../core/exploration-service.js";
import {
  type Assigned,
  POLICY,
  validateAudit,
  validateReport,
} from "../domain/understanding/policy.js";
import type { Selection } from "../domain/understanding/types.js";
import { digest, sha256 } from "../shared/primitives.js";

export type UnderstandingRuntimeSnapshot = {
  format: "findme-understanding-runtime@1";
  source_archive_hash: string;
  view: UnderstandingAppView;
  versions: {
    domain: string;
    view: UnderstandingVersionView;
    evidence: UnderstandingExactEvidence[];
  }[];
};
export function validateRuntimeSnapshot(
  snapshot: UnderstandingRuntimeSnapshot,
): UnderstandingRuntimeSnapshot {
  if (
    snapshot.format !== "findme-understanding-runtime@1" ||
    !/^[a-f0-9]{64}$/.test(snapshot.source_archive_hash) ||
    snapshot.view.format !== UNDERSTANDING_APP_VERSION ||
    snapshot.view.capabilities.provider_enabled ||
    snapshot.view.capabilities.native_core !== "unavailable" ||
    snapshot.view.scope.exhaustive !== false ||
    snapshot.view.scope.owner_confirmed !== false
  )
    throw Error("RUNTIME_SNAPSHOT_INVALID");
  for (const topic of snapshot.view.topics)
    if (topic.report) UnderstandingReport.parse(topic.report);
  if (snapshot.view.overall.report) UnderstandingReport.parse(snapshot.view.overall.report);
  const keys = new Set<string>();
  for (const version of snapshot.versions) {
    const key = `${version.domain}:${version.view.version}`;
    if (keys.has(key) || version.view.domain !== version.domain || !version.view.report)
      throw Error("RUNTIME_VERSION_INVALID");
    keys.add(key);
    UnderstandingReport.parse(version.view.report);
    const report = version.view.report;
    const objects = [
      ...(report.current_understanding ? [report.current_understanding] : []),
      ...report.findings,
      ...report.resources_conditions_costs,
      ...report.nodes,
      ...report.links,
    ];
    const referenced = new Set(
      objects.flatMap((o) => [
        ...o.evidence_ids,
        ...("counterevidence_ids" in o ? o.counterevidence_ids : []),
        ...("context_ids" in o ? o.context_ids : []),
      ]),
    );
    const ids = new Set<string>();
    for (const e of version.evidence) {
      if (
        ids.has(e.id) ||
        e.offset_unit !== "utf16" ||
        !Number.isInteger(e.start) ||
        !Number.isInteger(e.end) ||
        e.end - e.start !== e.quote.length ||
        e.start < 0 ||
        !e.source_ids.length
      )
        throw Error("RUNTIME_EVIDENCE_INVALID");
      ids.add(e.id);
    }
    if (ids.size !== referenced.size || [...ids].some((id) => !referenced.has(id)))
      throw Error("RUNTIME_REPORT_EVIDENCE_MISMATCH");
    const current =
      version.domain === "overall"
        ? snapshot.view.overall
        : snapshot.view.topics.find((t) => t.domain === version.domain);
    if (
      !current?.report ||
      current.version !== version.view.version ||
      JSON.stringify(UnderstandingReport.parse(current.report)) !==
        JSON.stringify(UnderstandingReport.parse(report))
    )
      throw Error("RUNTIME_CURRENT_REPORT_MISMATCH");
  }
  return snapshot;
}
