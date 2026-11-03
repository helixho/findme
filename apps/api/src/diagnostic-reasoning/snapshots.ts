import { EvidencePacket } from "@findme/core";
import { hash } from "../dogfood/model.js";
import type { EvidenceSelection, InputSnapshot } from "./evidence.js";

// Persist only selected source snapshots, never a new copy of the whole AV corpus.
export function snapshotForSelection(
  input: InputSnapshot,
  selection: EvidenceSelection,
): InputSnapshot {
  const needed = new Set([
    ...selection.evidence.map((e) => e.source_id),
    ...selection.context.map((c) => c.source_id),
  ]);
  const evidence = selection.evidence.map((e) => {
    const { source: _source, reason: _reason, score: _score, aliases: _aliases, ...fact } = e;
    return fact;
  });
  return {
    dependency_hash: input.dependency_hash,
    packet: EvidencePacket.parse({
      format: input.packet.format,
      question: input.packet.question,
      question_origin: input.packet.question_origin,
      sources: input.packet.sources.filter((s) => needed.has(s.id)),
      evidence,
    }),
  };
}
export function snapshotFingerprint(input: InputSnapshot, selection: EvidenceSelection): string {
  return hash({ dependency_hash: input.dependency_hash, selection });
}
export function validateSelectionSnapshot(
  input: InputSnapshot,
  selection: EvidenceSelection,
): boolean {
  const packet = EvidencePacket.parse(input.packet);
  if (
    packet.question !== selection.question ||
    packet.question_origin !== selection.question_origin
  )
    return false;
  if (packet.evidence.length !== selection.evidence.length) return false;
  const sourceMap = new Map(packet.sources.map((source) => [source.id, source]));
  for (const selected of selection.evidence) {
    const source = sourceMap.get(selected.source_id);
    const fact = packet.evidence.find((e) => e.id === selected.id);
    const {
      source: _source,
      reason: _reason,
      score: _score,
      aliases: _aliases,
      ...actual
    } = selected;
    if (
      !source ||
      !fact ||
      source.split !== "dev" ||
      source.excluded ||
      fact.excluded ||
      fact.stale ||
      hash(fact) !== hash(actual)
    )
      return false;
    const { original_text: _original, ...metadata } = source;
    if (hash(metadata) !== hash(selected.source)) return false;
  }
  for (const span of selection.context) {
    const source = sourceMap.get(span.source_id);
    if (
      !source ||
      source.split !== "dev" ||
      source.excluded ||
      span.start < 0 ||
      span.end <= span.start ||
      source.original_text.slice(span.start, span.end) !== span.text
    )
      return false;
  }
  return true;
}
// The model sees selected material, not hundreds of unused ranking records.
export function promptSelection(selection: EvidenceSelection): EvidenceSelection {
  return { ...selection, pool: [] };
}
