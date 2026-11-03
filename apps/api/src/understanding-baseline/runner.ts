import { parallelMap } from "./parallel-map.js";
import { buildPublishedVersion, verifyPublishedVersion } from "./publication.js";
import { LIMITS, type TopicResult, modelSelection, reportMarkdown } from "./render.js";
import { runRepairJobs } from "./repair-jobs.js";
import { reportReviewer } from "./report-review.js";
import { registerUnderstandingRun } from "./run-registration.js";
import { runTopic } from "./topic-jobs.js";
export { DOMAIN_TITLES, modelSelection, reportMarkdown } from "./render.js";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { type UnderstandingReport as Report, UNDERSTANDING_VERSION } from "@findme/core";
import { BatchStore } from "../dogfood/store.js";
import type { createCodexGateway } from "../llm/codex-cli.js";
import type { createGateway } from "../llm/gateway.js";
import { type Inputs, loadInputs } from "./input.js";
import { atomic, digest, fail, prepareOutput, privateDirectory, sha256 } from "./io.js";
import { codexPatchCompatible, jobRunner } from "./jobs.js";
import {
  type Assigned,
  OldClaimReview,
  POLICY,
  PROMPTS,
  UnderstandingAudit,
  UnderstandingReport,
  reportObjects,
  validateAudit,
  validateOld,
  validateReport,
} from "./policy.js";
import {
  DOMAINS,
  type Domain,
  type Selection,
  facts,
  navigation,
  repairRequests,
  selectDomain,
} from "./prepare.js";
import { recoveryManifestDependencies } from "./recovery.js";
export type UnderstandingOptions = {
  batch: string;
  coverage: string;
  out: string;
  repoRoot: string;
  live?: boolean;
  retryFailed?: boolean;
  maxCalls?: number;
  maxCallsThisRun?: number;
  topic?: Domain;
  gateway?: ReturnType<typeof createCodexGateway> | ReturnType<typeof createGateway>;
  /** Persisted explicit semantic continuation model; never inferred from a changed gateway. */
  continuationModel?: string;
};
export async function runUnderstanding(options: UnderstandingOptions) {
  const maxCalls = options.maxCalls ?? 40;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 71)
    fail("MAX_CALLS_0_TO_71_REQUIRED");
  if (maxCalls > 40 && !options.retryFailed) fail("RECOVERY_BUDGET_REQUIRES_EXPLICIT_RETRY");
  if (options.topic && !(options.topic in DOMAINS)) fail("UNKNOWN_TOPIC");
  const out = await prepareOutput(options.out, [options.repoRoot, options.batch, options.coverage]);
  return new BatchStore(out).locked(async () => {
    // Invalidate current pointers first if loading discovers changed/forged inputs.
    let input: Inputs;
    try {
      input = await loadInputs(options.batch, options.coverage);
    } catch (e) {
      await rm(path.join(out, "latest-ready.json"), { force: true });
      await rm(path.join(out, "latest-partial.json"), { force: true });
      throw e;
    }
    try {
      const { model, continuationModel, runtimeModel, expectedSemanticModel } =
        await registerUnderstandingRun(out, input, options);
      const jobs = await jobRunner({
        ...options,
        out,
        model,
        continuationModel,
        runtimeModel:
          runtimeModel &&
          expectedSemanticModel &&
          runtimeModel !== expectedSemanticModel &&
          codexPatchCompatible(expectedSemanticModel, runtimeModel)
            ? runtimeModel
            : undefined,
        inputHash: input.input_hash,
        maxCalls,
        maxCallsThisRun: options.maxCallsThisRun,
        fresh: input.fresh,
      });
      const nav = navigation(input);
      const requests = repairRequests(input);
      const {
        rejectedRepairProposals,
        repairResults,
        repairs,
        overlays,
        repairAudit,
        unavailableRepairs,
        repairsReady,
      } = await runRepairJobs(input, requests, jobs);
      const allFacts = facts(input, overlays);
      const targetCanonicals = new Set(
        requests.flatMap((r) =>
          r.canonical_id
            ? [r.canonical_id]
            : r.rows.map((e) => required(nav.find((n) => n.row_ids.includes(e.id))).canonical_id),
        ),
      );
      const auditedReport = reportReviewer(jobs, options);
      const topics: TopicResult[] = [];
      const stageReasons: Record<string, string> = {};
      await parallelMap(Object.keys(DOMAINS) as Domain[], async (domain, domainIndex) => {
        const result = await runTopic({
          out,
          inputHash: input.input_hash,
          model,
          topic: options.topic,
          domain,
          nav,
          allFacts,
          targetCanonicals,
          unavailableRepairs,
          jobs,
          auditedReport,
        });
        stageReasons[domain] = result.stageReason;
        topics[domainIndex] = result.topic;
      });
      // Overall receives originals actually cited in accepted reports, not summaries as proof.
      const accepted = topics.filter((t) => t.status === "ready_candidate");
      const citedIds = new Set(
        accepted.flatMap((t) =>
          t.candidate
            ? reportObjects(t.candidate).flatMap((o) => [
                ...o.evidence_ids,
                ...("counterevidence_ids" in o ? o.counterevidence_ids : []),
                ...("context_ids" in o ? o.context_ids : []),
              ])
            : [],
        ),
      );
      const overallSelection = selectDomain(
        "overall",
        [
          ...allFacts,
          ...topics.flatMap((t) => t.recovery?.overlays.map((p) => p.projected) ?? []),
        ].filter((e) => citedIds.has(e.id)),
      );
      const topicLinks = topics.map((t) => ({
        domain: t.domain,
        version: t.version,
        status: t.status,
      }));
      const overallPayload = {
        task: "u2_overall_baseline",
        selection: modelSelection(overallSelection),
        navigation_only: accepted.map((t) => ({
          domain: t.domain,
          version: t.version,
          findings: t.candidate?.findings,
        })),
        all_topic_versions: topicLinks,
        semantic_scope: LIMITS,
      };
      let overall: Report | undefined;
      let overallAudit: unknown = null;
      let overallAssigned: Assigned[] = [];
      // Bounded debugging never publishes an apparently full baseline.
      const topicsReady = topics.every((t) =>
        ["ready_candidate", "no_evidence", "context_required"].includes(t.status),
      );
      if (!options.topic && topicsReady && repairsReady && overallSelection.evidence.length) {
        overall = await jobs.job("overall", overallPayload, UnderstandingReport, (r) =>
          validateReport(r, overallSelection),
        );
        if (overall) {
          const reviewed = await auditedReport(
            "overall",
            "u2_overall_audit",
            overallPayload,
            overallSelection,
            overall,
          );
          overall = reviewed.candidate;
          overallAssigned = reviewed.assigned;
          overallAudit = reviewed.audit;
        }
      }
      // Load original old support separately from topic membership/overall selection.
      const oldRefs = new Set(
        input.old.flatMap((o) => [...o.evidence_ids, ...o.counterevidence_ids]),
      );
      const oldSelection = selectDomain(
        "old_claims",
        allFacts.filter((e) => e.root_ids.some((id) => oldRefs.has(id))),
      );
      const qualifications = [...oldRefs]
        .map((id) => ({
          id,
          qualified: input.inventory.packet.evidence.find((e) => e.id === id),
          supplied_ids: oldSelection.evidence
            .filter((e) => e.root_ids.includes(id))
            .map((e) => e.id),
        }))
        .map((q) => ({
          id: q.id,
          supplied_ids: q.supplied_ids,
          qualification: q.qualified
            ? {
                content_author: q.qualified.content_author,
                about: q.qualified.about,
                kind: q.qualified.kind,
                use: q.qualified.use,
                excluded: q.qualified.excluded,
                stale: q.qualified.stale,
                classification_conflict: q.qualified.classification_conflict,
              }
            : null,
        }));
      if (qualifications.some((q) => !q.qualification)) fail("UNKNOWN_OLD_SOURCE_REFERENCE");
      const oldPayload = {
        task: "u2_old_five_reconciliation",
        old_claims: input.old,
        selection: modelSelection(oldSelection),
        original_reference_qualifications: qualifications,
        semantic_scope: LIMITS,
      };
      const oldReview = !options.topic
        ? await jobs.job("old", oldPayload, OldClaimReview, (r) =>
            validateOld(r, input.old, oldSelection.evidence),
          )
        : undefined;
      let oldAudit: unknown = null;
      if (oldReview) {
        const assigned = input.old.map((o) => ({
          id: o.id,
          key: o.id,
          category: "old_disposition",
        }));
        oldAudit = await jobs.job(
          "audit",
          {
            task: "u2_old_five_audit",
            analysis_input: oldPayload,
            analysis_input_hash: digest(oldPayload),
            candidate: oldReview,
            assigned,
          },
          UnderstandingAudit,
          (a) =>
            validateAudit(
              a,
              digest(oldPayload),
              assigned,
              oldSelection.evidence.map((e) => e.id),
              oldReview,
            ),
        );
      }
      const unresolved = [
        ...unavailableRepairs.map((r) => ({ kind: "repair_unavailable", ...r })),
        ...topics
          .filter((t) => !["ready_candidate", "no_evidence", "context_required"].includes(t.status))
          .map((t) => ({ kind: "topic_unfinished", domain: t.domain, status: t.status })),
        ...nav
          .filter((n) => ["referent_unknown", "use_pending", "background"].includes(n.destination))
          .map((n) => ({
            kind: "inventory_destination",
            canonical_id: n.canonical_id,
            destination: n.destination,
          })),
        ...(!overallAudit ? [{ kind: "overall_unavailable" }] : []),
        ...(!oldAudit ? [{ kind: "old_claim_audit_unavailable" }] : []),
        ...jobs.pending,
        ...rejectedRepairProposals.map((r) => ({
          kind: "repair_proposal_rejected_original_use_retained",
          request_id: r.request_id,
          reason: r.reason,
        })),
      ];
      const complete =
        !options.topic && repairsReady && topicsReady && Boolean(overallAudit) && Boolean(oldAudit);
      const baseline = {
        format: UNDERSTANDING_VERSION,
        projection_only: true,
        policy: POLICY,
        prompt_hash: digest(PROMPTS),
        model,
        ...(continuationModel ? { continuation_model: continuationModel } : {}),
        input_hash: input.input_hash,
        input_artifacts: input.artifacts,
        source_version_directory: input.source_version_directory,
        status: complete ? "ready_candidate" : "partial",
        owner_confirmed: false,
        frameworks: "not_run",
        overall: overallAudit ? (overall ?? null) : null,
        overall_draft: overall ?? null,
        overall_audit: overallAudit ?? null,
        overall_assigned: overallAssigned,
        overall_selection: overallSelection,
        all_topic_versions: topicLinks,
        topics,
        old_claim_review: oldAudit ? (oldReview ?? null) : null,
        unresolved,
        limits: LIMITS,
        coverage: {
          canonical_inventory: nav.length,
          mapped_inventory: nav.length,
          total_domains: topics.length,
          accepted_domains: accepted.length,
          selected_canonical_union: new Set(
            topics
              .filter((t) => t.status === "ready_candidate")
              .flatMap((t) => t.selection.evidence.map((e) => e.canonical_id)),
          ).size,
          eligible_scope_repair_requests: requests.length,
          applied_proposition_overlays: overlays.length,
          unavailable_repair_requests: unavailableRepairs.length,
          exhaustive_semantic_interpretation: false,
          old_claims: input.old.length,
        },
        jobs: [...jobs.usedJobs].sort((a, b) => a.job.localeCompare(b.job)),
        attempts: jobs.attempts.map((a) => ({
          id: a.id,
          job: a.job,
          status: a.status,
          usage: a.usage,
        })),
      };
      try {
        await input.fresh();
      } catch (e) {
        await rm(path.join(out, "latest-ready.json"), { force: true });
        await rm(path.join(out, "latest-partial.json"), { force: true });
        throw e;
      }
      baseline.unresolved.sort((a, b) => digest(a).localeCompare(digest(b)));
      const version = digest(baseline);
      const versions = path.join(out, "versions");
      const directory = path.join(versions, version);
      await privateDirectory(versions);
      const artifactNames = [
        "input-hashes.json",
        "plan.json",
        "source-refs.json",
        "repairs.json",
        "context.json",
        ...topics.map((t) => `topics/${t.domain}.json`),
        "baseline.json",
        "report.md",
        "old-claim-review.json",
        "unresolved.json",
      ];
      const existing = await verifyPublishedVersion(directory, version, artifactNames);
      if (!existing) {
        await buildPublishedVersion(
          versions,
          directory,
          async (temp) => {
            await atomic(path.join(temp, "input-hashes.json"), input.artifacts);
            await atomic(path.join(temp, "plan.json"), {
              navigation: nav,
              taxonomy: input.taxonomy,
              proposed_topics: input.review.new_topic_candidates,
              report_domains: DOMAINS,
              aggregation_basis:
                "editorial U1 topic aggregation, unknown topics preserved with fallback",
              topic: options.topic ?? null,
              selections: topics.map((t) => t.selection),
              cumulative_budget: maxCalls,
            });
            await atomic(path.join(temp, "source-refs.json"), [
              ...new Map(
                [...topics.flatMap((t) => t.selection.evidence), ...oldSelection.evidence].map(
                  (e) => [e.id, e],
                ),
              ).values(),
            ]);
            await atomic(path.join(temp, "repairs.json"), {
              requests: requests.map((r) => ({
                id: r.id,
                kind: r.kind,
                canonical_id: r.canonical_id,
                row_ids: r.rows.map((e) => e.id),
                unavailable: r.unavailable,
              })),
              candidate: repairs,
              audit: repairAudit,
              batches: repairResults,
              rejected_proposals: rejectedRepairProposals.sort((a, b) =>
                a.request_id.localeCompare(b.request_id),
              ),
              overlays,
              unavailable: unavailableRepairs,
            });
            await atomic(
              path.join(temp, "context.json"),
              topics
                .filter((t) => t.status === "ready_candidate")
                .map((t) => ({
                  domain: t.domain,
                  version: t.version,
                  assigned: t.assigned,
                  nodes: t.candidate?.nodes,
                  links: t.candidate?.links,
                })),
            );
            await privateDirectory(path.join(temp, "topics"));
            for (const topic of topics)
              await atomic(path.join(temp, "topics", `${topic.domain}.json`), topic);
            await atomic(path.join(temp, "baseline.json"), baseline);
            await atomic(
              path.join(temp, "report.md"),
              reportMarkdown({ ...baseline, stageReasons }),
              true,
            );
            await atomic(path.join(temp, "old-claim-review.json"), {
              original: input.old,
              selection: oldSelection,
              qualifications,
              candidate: oldReview ?? null,
              audit: oldAudit ?? null,
              status: oldAudit ? "ready_candidate" : "partial",
            });
            await atomic(path.join(temp, "unresolved.json"), unresolved);
            const fileHashes = Object.fromEntries(
              await Promise.all(
                artifactNames.map(async (name) => [
                  name,
                  sha256(await readFile(path.join(temp, name))),
                ]),
              ),
            );
            await atomic(path.join(temp, "manifest.json"), {
              format: UNDERSTANDING_VERSION,
              version,
              files: fileHashes,
              status: baseline.status,
              input_hash: input.input_hash,
              topics: topicLinks,
              jobs: [...jobs.usedJobs].sort((a, b) => a.job.localeCompare(b.job)),
              ...(topics.some((t) => t.recovery)
                ? { recovery_dependencies: recoveryManifestDependencies(topics) }
                : {}),
            });
          },
          input.fresh,
        );
      }
      await input.fresh();
      await atomic(path.join(out, complete ? "latest-ready.json" : "latest-partial.json"), {
        version,
        directory,
        input_hash: input.input_hash,
      });
      return {
        status: baseline.status,
        directory,
        version,
        calls_this_run: jobs.callsThisRun,
        calls_total: jobs.attempts.length,
        complete,
        selected_topic: options.topic ?? null,
      };
    } catch (error) {
      if (!(error instanceof Error && error.message === "OUTPUT_MODEL_CHANGED")) {
        await rm(path.join(out, "latest-ready.json"), { force: true });
        await rm(path.join(out, "latest-partial.json"), { force: true });
      }
      throw error;
    }
  });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("MISSING_REQUIRED_REFERENCE");
  return value;
}
