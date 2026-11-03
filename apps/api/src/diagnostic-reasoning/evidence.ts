import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  EvidencePacket,
  type ReasoningEvidence,
  type ReasoningSource,
  ReasoningStance,
} from "@findme/core";
import type { LayerEvidence } from "../dogfood/layers.js";
import { SpanDraft, expressionEligible, hash, sourceReview } from "../dogfood/model.js";
import { firstBy, groupBy, messageKey } from "../dogfood/ordered-index.js";
import { BatchStore } from "../dogfood/store.js";
import { lexicalScores, relevanceFirstOrder } from "./ranking.js";

export type InputSnapshot = { packet: EvidencePacket; dependency_hash: string };
export type EvidenceLoader = () => Promise<InputSnapshot>;
export type RetrievalScope = {
  mode?: "lexical" | "supplied";
  project?: string;
  before?: string;
  maxEvidence?: number;
  maxBytes?: number;
};
export type SelectedEvidence = ReasoningEvidence & {
  source: Omit<ReasoningSource, "original_text">;
  reason: string[];
  score: number;
  aliases: string[];
};
export type ContextSpan = {
  source_id: string;
  session_id: string;
  message_id: string;
  project: string;
  group_id: string;
  start: number;
  end: number;
  text: string;
  use: "context";
  content_author: "unknown";
  purpose: "adjacent_qualifier" | "referent_context";
};
export type EvidenceSelection = {
  question: string;
  question_origin: EvidencePacket["question_origin"];
  scope: RetrievalScope;
  evidence: SelectedEvidence[];
  context: ContextSpan[];
  pool: {
    id: string;
    canonical_id: string;
    score: number;
    use: string;
    group_id: string;
    reason: string[];
  }[];
  counts: {
    input: number;
    filtered: number;
    duplicates: number;
    relevant: number;
    selected: number;
    omitted: number;
    bytes: number;
    sessions: number;
    event_groups: number;
  };
  limitations: string[];
};

async function optionalState(directory: string) {
  try {
    return await readFile(path.join(directory, "state.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function dependencies(directory: string) {
  const [manifest, raw, state, l1] = await Promise.all([
    readFile(path.join(directory, "manifest.json"), "utf8"),
    readFile(path.join(directory, "raw.json"), "utf8"),
    optionalState(directory),
    readFile(path.join(directory, "L1", "evidence.jsonl"), "utf8"),
  ]);
  return { hash: hash([manifest, raw, state, l1]), l1 };
}

/** Only BatchStore.load (read-only API) and L1 are used; L3 is never opened. */
export function batchEvidenceLoader(
  directory: string,
  question: string,
  questionOrigin: EvidencePacket["question_origin"] = "user_request",
): EvidenceLoader {
  return async () => {
    const before = await dependencies(directory);
    const batch = await new BatchStore(directory).load();
    const rows = before.l1
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as LayerEvidence);
    const sessionsById = firstBy(batch.raw, (r) => r.id);
    const candidatesBySource = groupBy(batch.state.candidates, (c) => c.sourceId);
    const rawByMessage = firstBy(batch.sources, (s) =>
      messageKey(s.sessionId, s.originalMessageId),
    );
    const sources: ReasoningSource[] = batch.sources.map((s) => {
      const session = sessionsById.get(s.sessionId);
      const review = sourceReview(batch.state, s.id);
      return {
        id: s.id,
        session_id: s.originalSessionId ?? s.sessionId,
        message_id: s.originalMessageId ?? s.id,
        source_uuid: s.sourceUuid ?? null,
        project: session?.project || "unassigned",
        occurred_at: s.time,
        disclosed_at: null,
        group_id: s.groupId,
        split: s.split,
        original_text: s.text,
        revision: s.sourceRevision ?? s.fingerprint,
        review_revision: review.revision,
        review_notes: review.context,
        blocked_ranges: (candidatesBySource.get(s.id) ?? [])
          .filter(
            (c) =>
              c.sourceId === s.id &&
              (c.status === "excluded" ||
                c.provenanceStatus === "stale" ||
                (c.contextSourceIds ?? []).some((id) => sourceReview(batch.state, id).excluded)),
          )
          .map((c) => ({ start: c.start, end: c.end })),
        excluded: review.excluded,
      };
    });
    const sourcesById = firstBy(sources, (s) => s.id);
    const evidence: ReasoningEvidence[] = [];
    for (const row of rows) {
      const rawSource = rawByMessage.get(messageKey(row.sessionId, row.messageId));
      const s = rawSource ? sourcesById.get(rawSource.id) : undefined;
      if (
        !s ||
        !rawSource ||
        row.split !== s.split ||
        row.groupId !== s.group_id ||
        row.project !== s.project ||
        row.time !== s.occurred_at ||
        row.sourceUuid !== s.source_uuid ||
        row.end <= row.start ||
        s.original_text.slice(row.start, row.end) !== row.quote
      )
        throw new Error("EVIDENCE_SOURCE_MISMATCH");
      // Filters are applied before ranking/context. An ambiguous overlapping correction fails closed.
      const overlaps = (candidatesBySource.get(s.id) ?? []).filter(
        (c) => c.sourceId === s.id && c.start < row.end && c.end > row.start,
      );
      const reviews = overlaps.filter((c) => c.judgedBy === "owner");
      const exact = reviews.filter(
        (c) =>
          c.start === row.start &&
          c.end === row.end &&
          c.quote === row.quote &&
          c.provenanceStatus !== "stale" &&
          c.checksum === hash(row.quote),
      );
      const corrected = exact.length === 1 ? exact[0] : undefined;
      const blocked = reviews.some((c) => c.status === "excluded");
      const correctionAmbiguous =
        reviews.length > 0 && (!corrected || reviews.some((c) => c.id !== corrected.id));
      const stale =
        correctionAmbiguous ||
        overlaps.some(
          (c) =>
            c.provenanceStatus === "stale" ||
            (c.contextSourceIds ?? []).some((id) => sourceReview(batch.state, id).excluded),
        ) ||
        sourceReview(batch.state, s.id).revision > 0;
      const attribution = corrected ?? row;
      const classificationConflict = !corrected && Boolean(row.conflictStatus);
      const stanceCandidate = attribution.stance;
      // Free-text stance remains a candidate, never silently promoted to an enum claim.
      const parsedStance = ReasoningStance.safeParse(stanceCandidate);
      const eligible =
        !classificationConflict &&
        (corrected !== undefined || row.eligible === true) &&
        expressionEligible(
          SpanDraft.pick({ author: true, about: true, kind: true, stance: true })
            .strip()
            .parse(attribution),
        );
      evidence.push({
        id: row.id,
        canonical_id: row.canonicalId,
        source_id: s.id,
        start: row.start,
        end: row.end,
        quote: row.quote,
        content_author: attribution.author as ReasoningEvidence["content_author"],
        about: attribution.about as ReasoningEvidence["about"],
        kind: attribution.kind as ReasoningEvidence["kind"],
        stance: parsedStance.success ? parsedStance.data : "unknown",
        stance_candidate: stanceCandidate,
        provenance: corrected ? "owner_review" : "model_candidate",
        attribution_notes: corrected?.context ?? [],
        use: eligible ? "personal_expression" : "context",
        revision: hash([
          row,
          corrected ?? null,
          sourceReview(batch.state, s.id),
          batch.state.feedback.filter(
            (f) => f.targetId === s.id || overlaps.some((c) => c.id === f.targetId),
          ),
        ]),
        excluded: s.excluded || blocked,
        stale,
        classification_conflict: classificationConflict,
      });
    }
    const packet = EvidencePacket.parse({
      format: "diagnostic-evidence-packet@1",
      question,
      question_origin: questionOrigin,
      sources,
      evidence,
    });
    if ((await dependencies(directory)).hash !== before.hash)
      throw new Error("SOURCE_CHANGED_DURING_READ");
    return { packet, dependency_hash: before.hash };
  };
}
export function packetEvidenceLoader(filename: string, question?: string): EvidenceLoader {
  return async () => {
    const text = await readFile(filename, "utf8");
    const packet = EvidencePacket.parse(JSON.parse(text));
    if (question !== undefined && packet.question !== question)
      throw new Error("PACKET_QUESTION_MISMATCH");
    return { packet, dependency_hash: hash(text) };
  };
}

const contrast = (text: string) =>
  /\b(?:not|never|but|unless|instead|however)\b|不|并非|但是|除非|而是|否认|仅当/i.test(text);
function sourceInScope(s: ReasoningSource, scope: RetrievalScope) {
  return (
    s.split === "dev" &&
    !s.excluded &&
    (!scope.project || scope.project === s.project) &&
    (!scope.before ||
      (s.occurred_at !== null && Date.parse(s.occurred_at) < Date.parse(scope.before)))
  );
}
function boundary(text: string, offset: number, direction: -1 | 1) {
  if (
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(text[offset] ?? "")
  )
    return offset + direction;
  return offset;
}

export function selectEvidence(
  input: EvidencePacket,
  scope: RetrievalScope = {},
): EvidenceSelection {
  const packet = EvidencePacket.parse(input);
  const maxEvidence = scope.maxEvidence ?? 12;
  const maxBytes = scope.maxBytes ?? 24000;
  if (
    !Number.isSafeInteger(maxEvidence) ||
    maxEvidence < 1 ||
    maxEvidence > 12 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 24000 ||
    (scope.before && !Number.isFinite(Date.parse(scope.before)))
  )
    throw new Error("INVALID_RETRIEVAL_POLICY");
  const sources = new Map(packet.sources.map((s) => [s.id, s]));
  const available = packet.evidence.filter((e) => {
    const s = sources.get(e.source_id);
    return s && sourceInScope(s, scope) && !e.excluded && !e.stale;
  });
  const parent = new Map(available.map((e) => [e.id, e.id]));
  const find = (id: string): string => {
    const p = parent.get(id);
    if (!p || p === id) return id;
    const r = find(p);
    parent.set(id, r);
    return r;
  };
  const links = new Map<string, string>();
  for (const e of available) {
    const source = sources.get(e.source_id);
    const identities = [
      `canonical:${e.canonical_id}`,
      ...(source?.source_uuid ? [`original:${source.source_uuid}:${e.start}:${e.end}`] : []),
    ];
    for (const identity of identities) {
      const other = links.get(identity);
      if (other) parent.set(find(e.id), find(other));
      else links.set(identity, e.id);
    }
  }
  const canonical = new Map<string, ReasoningEvidence[]>();
  for (const e of available) {
    const key = find(e.id);
    canonical.set(key, [...(canonical.get(key) ?? []), e]);
  }
  const scored = lexicalScores(
    packet.question,
    [...canonical.values()].flatMap((rows) =>
      [...rows].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 1),
    ),
  );
  const pool: SelectedEvidence[] = [];
  for (const aliases of canonical.values()) {
    const e = [...aliases].sort((a, b) => a.id.localeCompare(b.id))[0];
    if (!e) continue;
    if (aliases.some((a) => a.quote !== e.quote)) throw new Error("CANONICAL_QUOTE_CONFLICT");
    const conflicting =
      new Set(
        aliases.map((a) =>
          hash([a.content_author, a.about, a.kind, a.stance, a.stance_candidate, a.use]),
        ),
      ).size > 1 || aliases.some((a) => a.classification_conflict);
    const s = sources.get(e.source_id);
    if (!s) throw new Error("MISSING_SOURCE");
    const matched = scored.get(e.id) ?? { score: 0, terms: [] };
    const matches = matched.terms;
    if (scope.mode !== "supplied" && !matches.length) continue;
    const { original_text: _text, ...source } = s;
    pool.push({
      ...e,
      ...(conflicting
        ? {
            use: "context" as const,
            content_author: "unknown" as const,
            classification_conflict: true,
          }
        : {}),
      source,
      aliases: aliases.map((a) => a.id),
      score: scope.mode === "supplied" ? 1 : matched.score,
      reason: [
        `lexical:${matches.join(",")}`,
        ...(contrast(e.quote)
          ? ["contrast_or_negation_candidate; not established counterevidence"]
          : []),
      ],
    });
  }
  pool.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const ordered = relevanceFirstOrder(pool, pool.length);
  const selected: SelectedEvidence[] = [];
  const context: ContextSpan[] = [];
  let bytes = 0;
  const contextSources = new Set<string>();
  const contextCovered = (id: string, start: number, end: number) =>
    context.some((c) => c.source_id === id && c.start <= start && c.end >= end);
  const safeContext = (
    s: ReasoningSource,
    start: number,
    end: number,
    purpose: ContextSpan["purpose"],
  ): ContextSpan | null => {
    if (
      !sourceInScope(s, scope) ||
      s.blocked_ranges.some((range) => range.start < end && range.end > start) ||
      packet.evidence.some(
        (e) => e.source_id === s.id && (e.excluded || e.stale) && e.start < end && e.end > start,
      )
    )
      return null;
    return {
      source_id: s.id,
      session_id: s.session_id,
      message_id: s.message_id,
      project: s.project,
      group_id: s.group_id,
      start,
      end,
      text: s.original_text.slice(start, end),
      use: "context",
      content_author: "unknown",
      purpose,
    };
  };
  for (const e of ordered) {
    if (selected.length >= maxEvidence) break;
    const s = sources.get(e.source_id);
    if (!s) continue;
    const proposed: ContextSpan[] = [];
    {
      const start = boundary(s.original_text, Math.max(0, e.start - 280), -1);
      const end = boundary(s.original_text, Math.min(s.original_text.length, e.end + 280), 1);
      const qualifier = safeContext(s, start, end, "adjacent_qualifier");
      if (qualifier && !contextCovered(s.id, start, end) && (start !== e.start || end !== e.end))
        proposed.push(qualifier);
    }
    if (/\b(?:this|that|it|above)\b|这个|那个|上述|它/i.test(e.quote)) {
      const index = packet.sources.findIndex((source) => source.id === s.id);
      for (const adjacent of [packet.sources[index - 1], packet.sources[index + 1]]) {
        if (
          !adjacent ||
          adjacent.session_id !== s.session_id ||
          adjacent.group_id !== s.group_id ||
          adjacent.project !== s.project ||
          contextSources.has(adjacent.id)
        )
          continue;
        const span = safeContext(
          adjacent,
          0,
          boundary(adjacent.original_text, Math.min(adjacent.original_text.length, 560), -1),
          "referent_context",
        );
        if (span?.text) proposed.push(span);
      }
    }
    const quoteBytes = Buffer.byteLength(e.quote);
    if (bytes + quoteBytes > maxBytes) continue;
    // Reference-only snippets require their bounded context when available; no silent omission.
    const contextBytes = proposed.reduce((n, c) => n + Buffer.byteLength(c.text), 0);
    if (bytes + quoteBytes + contextBytes > maxBytes) continue;
    selected.push(e);
    bytes += quoteBytes + contextBytes;
    for (const c of proposed) {
      context.push(c);
      contextSources.add(c.source_id);
    }
  }
  return {
    question: packet.question,
    question_origin: packet.question_origin,
    scope,
    evidence: selected,
    context,
    pool: pool.map((e) => ({
      id: e.id,
      canonical_id: e.canonical_id,
      score: e.score,
      use: e.use,
      group_id: e.source.group_id,
      reason: e.reason,
    })),
    counts: {
      input: packet.evidence.length,
      filtered: packet.evidence.length - available.length,
      duplicates: available.length - canonical.size,
      relevant: pool.length,
      selected: selected.length,
      omitted: pool.length - selected.length,
      bytes,
      sessions: new Set(selected.map((e) => e.source.session_id)).size,
      event_groups: new Set(selected.map((e) => e.source.group_id)).size,
    },
    limitations: [
      "Supplied packets use their explicit bounded set; AV uses stopword-filtered weighted lexical recall only; semantic recall is unproven and absence of a hit is not absence of counterevidence.",
      "Bounded dev evidence; group and session diversity do not prove event independence. No whole-corpus personality inference.",
      "Attribution and free-text stance remain candidates with provenance; context is never personal support.",
      "Dependency invalidation conservatively includes all frozen manifest/raw/state/L1 bytes, including unrelated changes.",
    ],
  };
}
