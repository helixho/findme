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
import type { NeonArchiveReader } from "../hosted/neon-archive-reader.js";
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
/** Reads a pinned, previously validated application snapshot; never replays local processing. */
export class ArchiveUnderstandingRuntime {
  constructor(
    private reader: NeonArchiveReader,
    private sourceArchiveHash: string,
    private processedReader?: NeonArchiveReader,
  ) {}
  async snapshot(ctx: PersonalContext) {
    const snapshot = validateRuntimeSnapshot(
      await this.reader.json<UnderstandingRuntimeSnapshot>(ctx, "batch/runtime/understanding.json"),
    );
    if (snapshot.source_archive_hash !== this.sourceArchiveHash)
      throw Error("RUNTIME_SOURCE_ARCHIVE_MISMATCH");
    return snapshot;
  }
  async read(ctx: PersonalContext) {
    return (await this.snapshot(ctx)).view;
  }
  async version(ctx: PersonalContext, domain: string, version: string) {
    const entry = (await this.snapshot(ctx)).versions.find(
      (x) => x.domain === domain && x.view.version === version,
    );
    if (!entry) throw Error("REPORT_VERSION_NOT_FOUND");
    return entry.view;
  }
  async history(ctx: PersonalContext, domain: string, limit = 30) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error("HISTORY_QUERY_INVALID");
    const versions = (await this.snapshot(ctx)).versions
      .filter((x) => x.domain === domain)
      .map(({ view: { report, ...meta } }) => meta);
    if (!versions.length) throw Error("REPORT_VERSION_NOT_FOUND");
    return { versions: versions.slice(0, limit), truncated: versions.length > limit };
  }
  async evidences(ctx: PersonalContext, domain: string, version: string, ids: string[]) {
    if (!ids.length || ids.length > 24 || new Set(ids).size !== ids.length)
      throw Error("EVIDENCE_QUERY_INVALID");
    const entry = (await this.snapshot(ctx)).versions.find(
      (x) => x.domain === domain && x.view.version === version,
    );
    if (!entry) throw Error("REPORT_VERSION_NOT_FOUND");
    return ids.map((id) => {
      const e = entry.evidence.find((x) => x.id === id);
      if (!e) throw Error("EVIDENCE_OUTSIDE_REPORT");
      return e;
    });
  }

  /** Loads only the retained U2 baseline/topic artifacts; original jobs and raw audit inputs are absent. */
  async approvedTopicProvenance(ctx: PersonalContext, domain: string, version: string) {
    if (!this.processedReader) throw Error("U2_PROCESSED_ARCHIVE_UNAVAILABLE");
    const snapshot = await this.snapshot(ctx);
    const current = snapshot.versions.find(
      (v) => v.domain === domain && v.view.version === version,
    );
    if (!current || current.view.status !== "accepted" || domain === "overall")
      throw Error("U2_TOPIC_NOT_ACCEPTED");
    const baselineVersion = snapshot.view.baseline_version;
    if (!/^[a-f0-9]{64}$/.test(baselineVersion)) throw Error("U2_BASELINE_VERSION_INVALID");
    const root = `u2/versions/${baselineVersion}`;
    const [manifest, baseline] = await Promise.all([
      this.processedReader.json<Record<string, unknown>>(ctx, `${root}/manifest.json`),
      this.processedReader.json<Record<string, unknown>>(ctx, `${root}/baseline.json`),
    ]);
    const files = manifest.files as Record<string, string> | undefined;
    if (
      manifest.format !== UNDERSTANDING_VERSION ||
      manifest.version !== baselineVersion ||
      manifest.input_hash !== baseline.input_hash ||
      baseline.format !== UNDERSTANDING_VERSION ||
      baseline.policy !== POLICY ||
      !files ||
      typeof files["baseline.json"] !== "string"
    )
      throw Error("U2_BASELINE_MANIFEST_INVALID");
    const baselineBytes = await this.processedReader.read(ctx, `${root}/baseline.json`);
    if (
      (await sha256(new TextDecoder().decode(baselineBytes))) !== files["baseline.json"] ||
      digest(baseline) !== baselineVersion
    )
      throw Error("U2_BASELINE_HASH_MISMATCH");
    const topics = baseline.topics as Array<Record<string, unknown>> | undefined;
    const topic = topics?.find((t) => t.domain === domain);
    if (!topic || topic.status !== "ready_candidate" || topic.version !== version || !topic.audit)
      throw Error("U2_AUDIT_ARTIFACT_UNAVAILABLE");
    const [topicRaw, topicBytes] = await Promise.all([
      this.processedReader.json<Record<string, unknown>>(ctx, `${root}/topics/${domain}.json`),
      this.processedReader.read(ctx, `${root}/topics/${domain}.json`),
    ]);
    if (
      typeof files[`topics/${domain}.json`] !== "string" ||
      (await sha256(new TextDecoder().decode(topicBytes))) !== files[`topics/${domain}.json`] ||
      digest(topicRaw) !== digest(topic)
    )
      throw Error("U2_TOPIC_ARTIFACT_HASH_MISMATCH");
    const report = UnderstandingReport.parse(topic.candidate);
    const audit = UnderstandingAudit.parse(topic.audit);
    const assigned = topic.assigned as Assigned[];
    const selection = topic.selection as { evidence?: { id: string }[] };
    validateReport(report, topic.selection as Selection);
    validateAudit(
      audit,
      audit.input_hash,
      assigned,
      (selection.evidence ?? []).map((e) => e.id),
    );
    if (
      digest(report) !== digest(current.view.report) ||
      digest([
        baseline.input_hash,
        POLICY,
        baseline.model,
        domain,
        topic.selection,
        topic.candidate,
        topic.audit,
        topic.status,
      ]) !== version
    )
      throw Error("U2_REPORT_AUDIT_VERSION_MISMATCH");
    return {
      baseline_version: baselineVersion,
      baseline_hash: files["baseline.json"],
      topic_hash: files[`topics/${domain}.json`],
      input_hash: baseline.input_hash,
      policy: baseline.policy,
      policy_hash: baseline.prompt_hash,
      model: baseline.model,
      topic_version: version,
      audit,
      audit_hash: digest(audit),
      assigned,
      selection: topic.selection,
      report_hash: digest(report),
      audit_raw_replay: false as const,
    };
  }
}
