import type { Fact, Selection } from "../domain/understanding/types.js";
export type { Fact, Selection } from "../domain/understanding/types.js";
import type { ReasoningEvidence, ReasoningSource, UseRepairs } from "@findme/core";
import type { Inputs } from "./input.js";
import { digest, fail } from "./io.js";
export const DOMAINS = {
  role_direction: ["career_role", "current_direction", "self_understanding"],
  collaboration: ["agent_collaboration", "rules_and_skills", "workflow_design"],
  judgment_learning: ["review_validation", "tool_selection", "knowledge_use"],
  information_systems: [
    "cleanup_retirement",
    "archive_recovery",
    "content_capture",
    "infrastructure_remote",
    "device_account_state",
    "information_structure",
  ],
  expression_design: ["document_presentation", "product_planning", "visual_identity"],
  resources_tradeoffs: ["financial_feasibility", "business_qualification", "personal_investing"],
  daily_conditions: ["media_library", "travel_routes", "interaction_efficiency", "data_privacy"],
  unresolved: ["other", "unknown", "other_unclear"],
} as const;
export type Domain = keyof typeof DOMAINS;
export const domainFor = (topic: string): Domain =>
  (Object.keys(DOMAINS) as Domain[]).find((d) =>
    (DOMAINS[d] as readonly string[]).includes(topic),
  ) ?? "unresolved";
const unique = <T>(xs: T[]) => [...new Set(xs)];
export type Navigation = ReturnType<typeof navigation>;
export function navigation(input: Inputs) {
  return input.inventory.canonical.map((c) => {
    const original = unique(
      input.destinations
        .filter((d) => d.canonical_id === c.id)
        .flatMap((d) => d.topic_mapping?.topics ?? []),
    );
    const suggestions = input.review.topic_review.filter((r) => r.canonical_id === c.id);
    const proposed = unique(
      suggestions.filter((r) => r.action === "propose_topic").flatMap((r) => r.suggested_topics),
    );
    const topics = unique([...original, ...proposed]);
    return {
      canonical_id: c.id,
      row_ids: c.rows.map((r) => r.id),
      original_topics: original,
      proposed_topics: proposed,
      topics,
      domains: unique((topics.length ? topics : ["unknown"]).map(domainFor)),
      split: c.split,
      facets: c.facets,
      projects: c.projects,
      dates: c.dates,
      destination:
        c.split !== "dev"
          ? "holdout_metadata"
          : c.blocked
            ? "blocked"
            : c.disputed
              ? "use_pending"
              : suggestions.some((s) => s.action === "retain_referent_gap")
                ? "referent_unknown"
                : c.eligible
                  ? "topic_candidate"
                  : "background",
      source_diversity_is_event_independence: false,
      proposed_by: "coordinator_model",
      owner_confirmed: false,
    };
  });
}
export function sourceSafe(source: ReasoningSource, start: number, end: number) {
  return (
    source.split === "dev" &&
    !source.excluded &&
    start >= 0 &&
    end > start &&
    end <= source.original_text.length &&
    !source.blocked_ranges.some((r) => r.start < end && r.end > start)
  );
}
export type RepairWindow = {
  source_id: string;
  start: number;
  end: number;
  text: string;
};
export type RepairRequest = {
  id: string;
  kind: "scoped_use" | "variant" | "project_report";
  canonical_id: string | null;
  windows: RepairWindow[];
  rows: ReasoningEvidence[];
  opinion: unknown;
  unavailable: string | null;
};
function localWindow(
  input: Inputs,
  source: ReasoningSource,
  start: number,
  end: number,
): RepairWindow {
  // Trim inward at surrogate boundaries; neighbours never exceed 160 UTF16 units.
  const lo = boundary(source.original_text, Math.max(0, start - 160), 1);
  const hi = boundary(source.original_text, Math.min(source.original_text.length, end + 160), -1);
  const safe =
    sourceSafe(source, lo, hi) &&
    !input.inventory.packet.evidence.some(
      (e) =>
        e.source_id === source.id &&
        e.start < hi &&
        e.end > lo &&
        (e.excluded ||
          e.stale ||
          e.content_author !== "subject" ||
          ["quotation", "system_wrapper", "unknown"].includes(e.kind)),
    );
  return {
    source_id: source.id,
    start: safe ? lo : start,
    end: safe ? hi : end,
    text: source.original_text.slice(safe ? lo : start, safe ? hi : end),
  };
}
export function repairRequests(input: Inputs): RepairRequest[] {
  const sources = new Map(input.inventory.packet.sources.map((s) => [s.id, s]));
  const requests: RepairRequest[] = [];
  for (const suggestion of input.review.sample_review.filter(
    (r) => r.adjudication === "propose_scoped_use_repair",
  )) {
    const sample = required(input.samples.find((s) => s.id === suggestion.sample_id));
    const source = sources.get(sample.source_id);
    const segment = input.inventory.segments.find((s) => s.id === sample.segment_id);
    if (
      !source ||
      !segment ||
      segment.sessionId !== sample.session_id ||
      segment.messageId !== sample.message_id ||
      !input.inventory.batch.sources.some(
        (s) =>
          s.id === source.id &&
          s.sessionId === sample.session_id &&
          s.originalMessageId === sample.message_id,
      )
    )
      fail("SAMPLE_SOURCE_REFERENCE_INVALID");
    const windows = sample.windows.map((w) => ({ source_id: source.id, ...w }));
    if (
      windows.some(
        (w) =>
          w.start < segment.start ||
          w.end > segment.end ||
          source.original_text.slice(w.start, w.end) !== w.text,
      )
    )
      fail("SAMPLE_WINDOW_FORGERY");
    const rows = input.inventory.packet.evidence.filter(
      (e) => e.source_id === source.id && windows.some((w) => w.start < e.end && w.end > e.start),
    );
    const roots = unique(
      rows.map((e) => input.inventory.canonical.find((c) => c.rows.some((r) => r.id === e.id))?.id),
    );
    if (sample.canonical_id && !roots.includes(sample.canonical_id))
      fail("SAMPLE_CANONICAL_FORGERY");
    requests.push({
      id: `sample:${sample.id}`,
      kind: "scoped_use",
      canonical_id: sample.canonical_id,
      windows,
      rows,
      opinion: suggestion,
      unavailable:
        windows.some((w) => !sourceSafe(source, w.start, w.end)) ||
        rows.some((e) => e.stale || e.excluded)
          ? "source_not_usable"
          : !rows.length
            ? "no_existing_L1_authorship_anchor"
            : null,
    });
  }
  for (const group of input.review.classification_variants.records) {
    const rows = input.inventory.packet.evidence.filter((e) => group.row_ids.includes(e.id));
    const windows = rows.map((e) => ({
      source_id: e.source_id,
      start: e.start,
      end: e.end,
      text: e.quote,
    }));
    requests.push({
      id: `variant:${group.canonical_id}`,
      kind: "variant",
      canonical_id: group.canonical_id,
      rows,
      windows,
      opinion: group,
      unavailable:
        !rows.length ||
        rows.some(
          (e) =>
            !sources.has(e.source_id) ||
            !sourceSafe(required(sources.get(e.source_id)), e.start, e.end) ||
            e.excluded ||
            e.stale,
        )
          ? "source_not_usable"
          : null,
    });
  }
  const covered = new Set(
    requests.flatMap((r) =>
      r.canonical_id
        ? [r.canonical_id]
        : input.inventory.canonical
            .filter((c) => c.rows.some((row) => r.rows.some((e) => e.id === row.id)))
            .map((c) => c.id),
    ),
  );
  for (const canonical of input.inventory.canonical) {
    if (canonical.split !== "dev" || canonical.blocked || covered.has(canonical.id)) continue;
    const aliases = input.inventory.packet.evidence.filter((e) =>
      canonical.rows.some((r) => r.id === e.id),
    );
    if (
      aliases.some(
        (e) =>
          e.excluded ||
          e.stale ||
          e.content_author !== "subject" ||
          ["quotation", "system_wrapper", "unknown"].includes(e.kind),
      )
    )
      continue;
    const rows = aliases.filter(
      (e) =>
        e.kind === "self_report" &&
        e.about === "project" &&
        sources.has(e.source_id) &&
        sourceSafe(required(sources.get(e.source_id)), e.start, e.end) &&
        !input.inventory.packet.evidence.some(
          (other) =>
            other.source_id === e.source_id &&
            other.start < e.end &&
            other.end > e.start &&
            (other.excluded ||
              other.stale ||
              other.content_author !== "subject" ||
              ["quotation", "system_wrapper", "unknown"].includes(other.kind)),
        ) &&
        required(sources.get(e.source_id)).original_text.slice(e.start, e.end) === e.quote,
    );
    if (!rows.length) continue;
    const seen = new Set<string>();
    const windows = rows.flatMap((e) => {
      // A copied original is one request window, even when its source ID differs.
      const key = JSON.stringify([e.start, e.end, e.quote]);
      if (seen.has(key)) return [];
      seen.add(key);
      return [localWindow(input, required(sources.get(e.source_id)), e.start, e.end)];
    });
    requests.push({
      id: `project:${canonical.id}`,
      kind: "project_report",
      canonical_id: canonical.id,
      windows,
      rows,
      opinion: {
        reason:
          "Review the original project self-report for scoped propositions; eligibility and meaning remain undecided.",
      },
      unavailable: null,
    });
  }
  if (new Set(requests.map((r) => r.id)).size !== requests.length) fail("DUPLICATE_REPAIR_REQUEST");
  return requests;
}
export type Overlay = {
  id: string;
  request_id: string;
  canonical_id: string;
  root_ids: string[];
  source_id: string;
  start: number;
  end: number;
  quote: string;
  content_author: ReasoningEvidence["content_author"];
  type: string;
  stance: ReasoningEvidence["stance"];
  about: ReasoningEvidence["about"];
  kind: ReasoningEvidence["kind"];
  use: "personal_expression" | "project_report" | "context";
  purpose: string;
  proposition: string;
  scope: string;
  reason: string;
  original: ReasoningEvidence[];
  provenance: "reviewed_model";
};
export function resolveRepairs(
  input: Inputs,
  requests: RepairRequest[],
  result: UseRepairs,
): Overlay[] {
  const requested = requests.filter((r) => !r.unavailable);
  if (
    result.repairs.length !== requested.length ||
    new Set(result.repairs.map((r) => r.request_id)).size !== requested.length ||
    result.repairs.some((r) => !requested.some((q) => q.id === r.request_id))
  )
    fail("INCOMPLETE_REPAIR_ACCOUNTING");
  const overlays: Overlay[] = [];
  for (const repair of result.repairs) {
    const request = required(requested.find((r) => r.id === repair.request_id));
    if ((repair.decision === "propositions") !== Boolean(repair.propositions.length))
      fail("REPAIR_DECISION_MISMATCH");
    for (const [i, p] of repair.propositions.entries()) {
      const source = input.inventory.packet.sources.find((s) => s.id === p.source_id);
      if (!source) fail("UNKNOWN_REPAIR_SOURCE");
      const windows = request.windows.filter((w) => w.source_id === p.source_id);
      const matches = new Set<number>();
      for (const w of windows) {
        let pos = w.text.indexOf(p.quote);
        while (pos >= 0) {
          matches.add(w.start + pos);
          pos = w.text.indexOf(p.quote, pos + 1);
        }
      }
      const exactDeclared =
        p.start !== null &&
        matches.has(p.start) &&
        (p.end === null || p.end === p.start + p.quote.length);
      const start = exactDeclared
        ? required(p.start)
        : matches.size === 1
          ? required([...matches][0])
          : -1;
      const end = start + p.quote.length;
      if (
        !matches.has(start) ||
        end !== start + p.quote.length ||
        !windows.some((w) => w.start <= start && w.end >= end) ||
        !sourceSafe(source, start, end) ||
        source.original_text.slice(start, end) !== p.quote
      )
        fail("REPAIR_EXACT_SPAN_INVALID");
      const anchors = request.rows.filter(
        (e) => e.source_id === p.source_id && e.start < end && e.end > start,
      );
      if (
        !anchors.length ||
        (p.evidence_id !== null && !anchors.some((e) => e.id === p.evidence_id)) ||
        anchors.some((e) => e.excluded || e.stale)
      )
        fail("REPAIR_ANCHOR_INVALID");
      const author = unique(anchors.map((e) => e.content_author));
      const candidateUse = ["personal_expression", "project_report"].includes(p.purpose);
      if (
        candidateUse &&
        (author.length !== 1 ||
          author[0] !== "subject" ||
          anchors.some((e) => ["quotation", "system_wrapper", "unknown"].includes(e.kind)) ||
          anchors.some((e) => e.classification_conflict) ||
          p.stance === "unknown" ||
          !["self_report", "evaluation", "choice"].includes(p.kind))
      )
        fail("REPAIR_AUTHOR_OR_USE_ESCALATION");
      if (
        p.purpose === "project_report" &&
        (p.about !== "project" ||
          p.kind !== "self_report" ||
          p.stance !== "reported" ||
          !["role", "goal", "constraint", "choice", "outcome", "state", "evaluation"].includes(
            p.type,
          ))
      )
        fail("PROJECT_REPORT_PURPOSE_REQUIRED");
      if (
        p.purpose === "personal_expression" &&
        ((p.about !== "self" &&
          !(
            ["project", "third_party"].includes(p.about) &&
            ["evaluation", "choice"].includes(p.kind) &&
            p.type === p.kind
          )) ||
          (anchors.some((e) => e.kind === "work_requirement") &&
            !["goal", "constraint"].includes(p.type)))
      )
        fail("COMMAND_IS_NOT_PREFERENCE");
      if (
        anchors.some((e) => e.stance !== "unknown" && e.stance !== p.stance) ||
        (anchors.some((e) => e.stance === "unknown") && ["endorsed", "opposed"].includes(p.stance))
      )
        fail("STANCE_ESCALATION");
      const canonical = input.inventory.canonical.find((c) =>
        c.rows.some((r) => r.id === required(anchors[0]).id),
      );
      if (
        !canonical ||
        canonical.split !== "dev" ||
        canonical.blocked ||
        anchors.some((e) => !canonical.rows.some((r) => r.id === e.id)) ||
        (request.canonical_id !== null && request.canonical_id !== canonical.id)
      )
        fail("REPAIR_CANONICAL_BLOCKED");
      const aliases = input.inventory.packet.evidence.filter((e) =>
        canonical.rows.some((r) => r.id === e.id),
      );
      const polarities = unique(
        aliases
          .filter((e) => ["endorsed", "opposed", "not_endorsed"].includes(e.stance))
          .map((e) => e.stance),
      );
      if (candidateUse && polarities.length > 1) fail("CANONICAL_STANCE_CONFLICT");
      if (
        candidateUse &&
        (aliases.length !== canonical.rows.length ||
          aliases.some(
            (e) =>
              e.content_author !== "subject" ||
              ["quotation", "unknown", "system_wrapper"].includes(e.kind) ||
              e.excluded ||
              e.stale,
          ))
      )
        fail("DISPUTED_AUTHOR_NOT_PROMOTABLE");
      if (
        candidateUse &&
        ["endorsed", "opposed"].includes(p.stance) &&
        aliases.some((e) => e.stance !== p.stance)
      )
        fail("STANCE_ESCALATION");
      if (
        candidateUse &&
        canonical.disputed &&
        (request.kind !== "variant" ||
          (
            request.opinion as {
              assessment?: string;
            }
          ).assessment !== "compatible_facets" ||
          unique(canonical.qualified.map((e) => e.content_author)).length !== 1 ||
          canonical.qualified.some((e) =>
            ["quotation", "unknown", "system_wrapper"].includes(e.kind),
          ))
      )
        fail("DISPUTED_AUTHOR_NOT_PROMOTABLE");
      overlays.push({
        id: `overlay-${digest([request.id, p, i]).slice(0, 24)}`,
        request_id: request.id,
        canonical_id: canonical.id,
        root_ids: anchors.map((e) => e.id),
        source_id: source.id,
        start,
        end,
        quote: p.quote,
        content_author: author.length === 1 ? required(author[0]) : "unknown",
        type: p.type,
        stance: p.stance,
        about: p.about,
        kind: p.kind,
        use:
          p.purpose === "personal_expression"
            ? "personal_expression"
            : p.purpose === "project_report"
              ? "project_report"
              : "context",
        purpose: p.purpose,
        proposition: p.proposition,
        scope: p.scope,
        reason: p.reason,
        original: anchors,
        provenance: "reviewed_model",
      });
    }
  }
  return overlays;
}

function boundary(text: string, position: number, direction: number) {
  return position > 0 &&
    /[\uD800-\uDBFF]/.test(text[position - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(text[position] ?? "")
    ? position + direction
    : position;
}
export function facts(input: Inputs, overlays: Overlay[]): Fact[] {
  const result: Fact[] = [];
  for (const c of input.inventory.canonical.filter((c) => c.split === "dev" && !c.blocked)) {
    const entries = [
      ...c.qualified.map((e) => ({
        ...e,
        root_ids: [e.id],
        scope: required(c.rows.find((r) => r.id === e.id)).scope,
        use: c.disputed ? ("context" as const) : e.use,
      })),
      ...overlays.filter((o) => o.canonical_id === c.id),
    ];
    for (const e of entries) {
      const s = required(input.inventory.packet.sources.find((s) => s.id === e.source_id));
      if (!sourceSafe(s, e.start, e.end) || ("stale" in e && (e.stale || e.excluded))) continue;
      const window = localWindow(input, s, e.start, e.end);
      const qualifier =
        window.start !== e.start || window.end !== e.end
          ? { start: window.start, end: window.end, text: window.text, use: "context" as const }
          : null;
      const originalFacet = required(c.rows.find((r) => e.root_ids.includes(r.id))).facet;
      const repaired = "type" in e;
      result.push({
        id: e.id,
        canonical_id: c.id,
        root_ids: e.root_ids,
        source_id: e.source_id,
        quote: e.quote,
        start: e.start,
        end: e.end,
        content_author: e.content_author,
        about: e.about,
        kind: e.kind,
        stance: e.stance,
        use: e.use,
        scope: e.scope,
        session_id: s.session_id,
        message_id: s.message_id,
        project: s.project,
        time: s.disclosed_at ?? s.occurred_at,
        group_id: s.group_id,
        facet: originalFacet,
        original_facet: originalFacet,
        proposition_type: repaired
          ? e.type
          : originalFacet === "decision"
            ? "choice"
            : originalFacet,
        proposition: repaired ? e.proposition : e.quote,
        purpose: repaired
          ? e.purpose
          : e.use === "personal_expression"
            ? "personal_expression"
            : "context_only",
        provenance: e.provenance,
        qualifier,
      });
    }
  }
  return result;
}

export function selectDomain(
  domain: Domain | "overall" | "old_claims",
  candidates: Fact[],
  targeted = new Set<string>(),
  limit = 24,
): Selection {
  const remaining = [...candidates];
  const evidence: Fact[] = [];
  const omitted: Selection["omitted"] = [];
  const seen = new Set<string>();
  const roots = new Set<string>();
  const strata = new Set<string>();
  let bytes = 0;
  const dimensions = (f: Fact) => [
    `project:${f.project}`,
    `time:${f.time?.slice(0, 10)}`,
    `facet:${f.proposition_type}`,
    `use:${f.use}`,
  ];
  const score = (f: Fact) =>
    // A repair is a retrieval priority, not proof of greater personal relevance.
    // Reserve at most one third of the context for newly reviewed contributions;
    // the rest still competes across existing expressions, dates and conditions.
    (f.use !== "context" &&
    targeted.has(f.canonical_id) &&
    [...roots].filter((id) => targeted.has(id)).length < Math.ceil(limit / 3)
      ? 100
      : 0) +
    (f.use !== "context" ? 8 : 0) +
    (f.content_author === "subject" ? 2 : 0) +
    (/[不仅但约束]|\b(?:not|unless|but|only)\b/i.test(f.quote) ? 2 : 0) +
    dimensions(f).filter((d) => !strata.has(d)).length * 3 -
    (/^(?:好[的吧]?|嗯|谢谢|ok|yes|thanks)[。.!\s]*$/i.test(f.quote) ? 30 : 0);
  while (remaining.length) {
    remaining.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    const f = required(remaining.shift());
    if (
      f.provenance !== "reviewed_model" &&
      candidates.some(
        (o) =>
          o.provenance === "reviewed_model" &&
          o.canonical_id === f.canonical_id &&
          o.start < f.end &&
          o.end > f.start,
      )
    ) {
      omitted.push({ id: f.id, reason: "superseded_by_audited_proposition" });
      continue;
    }
    const identity = JSON.stringify([
      f.canonical_id,
      f.start,
      f.end,
      f.quote,
      f.proposition_type,
      f.proposition,
      f.purpose,
      f.about,
      f.kind,
      f.stance,
      f.scope,
    ]);
    // Semantic propositions are distinct; all aliases/facets still share one canonical contribution.
    if (seen.has(identity)) {
      omitted.push({ id: f.id, reason: "duplicate_semantic_proposition" });
      continue;
    }
    const newRoots = roots.has(f.canonical_id) ? [] : [f.canonical_id];
    const size = Buffer.byteLength(JSON.stringify(f));
    if (roots.size + newRoots.length > limit || bytes + size > 36000) {
      omitted.push({ id: f.id, reason: "bounded_input_budget_unanalysed" });
      continue;
    }
    evidence.push(f);
    bytes += size;
    seen.add(identity);
    for (const id of newRoots) roots.add(id);
    for (const d of dimensions(f)) strata.add(d);
  }
  return {
    selection_version: "u2-domain-selection@2",
    domain,
    evidence,
    omitted,
    bytes,
    selected_original_atoms: roots.size,
    canonical_count: new Set(evidence.map((e) => e.canonical_id)).size,
    scope:
      "Only these selected original spans and local source contexts; not exhaustive personal understanding or independent events.",
    repair_inputs_unavailable: [],
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("MISSING_REQUIRED_REFERENCE");
  return value;
}
