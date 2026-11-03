import { AuthorKind, CoreImportEnvelope, EvidencePacket, SourceKind } from "@findme/core";
import { z } from "zod";
import { requestHash } from "../core/operations.js";

/** Convert a previously authorised exact EvidencePacket; never reads AV or invokes inference. */
export async function prepareEvidencePacketImport(raw: unknown, namespace: string) {
  const packet = EvidencePacket.parse(raw);
  const skipped: { source_id: string; reason: string }[] = [];
  const sourceRows = [];
  for (const source of packet.sources) {
    if (source.split === "holdout") {
      skipped.push({ source_id: source.id, reason: "holdout_omitted" });
      continue;
    }
    // Partial blocked ranges cannot be repaired by importing the entire source as eligible.
    // Preserve the full original only as excluded until an explicit source-level correction.
    if (!source.disclosed_at) {
      skipped.push({ source_id: source.id, reason: "source_reported_time_required" });
      continue;
    }
    const refs = packet.evidence.filter((e) => e.source_id === source.id && !e.stale);
    const authors = new Set(refs.map((e) => e.content_author));
    const author =
      authors.size === 1 ? ([...authors][0] ?? "unknown") : authors.size ? "mixed" : "unknown";
    const abouts = new Set(refs.map((e) => e.about));
    const stances = new Set(refs.map((e) => e.stance));
    const externalId = await requestHash([source.id, source.revision]);
    sourceRows.push({
      external_id: externalId,
      version: 1,
      root_id: await requestHash(source.source_uuid ?? source.id),
      text: source.original_text,
      author,
      kind: "conversation_import" as const,
      reported_at: source.disclosed_at,
      occurred_at: source.occurred_at,
      split: "dev" as const,
      excluded: source.excluded || source.blocked_ranges.length > 0,
      about: abouts.size === 1 ? ([...abouts][0] ?? "unknown") : ("unknown" as const),
      stance: stances.size === 1 ? ([...stances][0] ?? "unknown") : ("unknown" as const),
      spans: [
        ...new Map(
          refs.map((e) => [`${e.start}:${e.end}`, { start: e.start, end: e.end, quote: e.quote }]),
        ).values(),
      ],
    });
  }
  const chunks: CoreImportEnvelope[] = [];
  let current: typeof sourceRows = [];
  for (const row of sourceRows) {
    const proposed = {
      format: "findme-core-ingest@1" as const,
      namespace,
      sources: [...current, row],
      historical_reports: [],
    };
    if (
      current.length &&
      (current.length >= 100 || new TextEncoder().encode(JSON.stringify(proposed)).length > 1800000)
    ) {
      chunks.push(
        CoreImportEnvelope.parse({
          format: "findme-core-ingest@1",
          namespace,
          sources: current,
          historical_reports: [],
        }),
      );
      current = [];
    }
    current.push(row);
  }
  if (current.length)
    chunks.push(
      CoreImportEnvelope.parse({
        format: "findme-core-ingest@1",
        namespace,
        sources: current,
        historical_reports: [],
      }),
    );
  return {
    format: "findme-ingest-preparation@1",
    source_packet_hash: await requestHash(raw),
    chunks,
    skipped,
    model_calls: 0,
    historical_reports_not_promoted: true,
  };
}

// Validate the exported fields we consume; unrelated export sections and old metadata are
// archival only. Present but invalid attribution must not silently become "unknown".
const RestoreExport = z.object({
  format: z.literal("findme-personal-export@1"),
  sections: z.object({
    sources: z.array(
      z
        .object({
          id: z.string().min(1).max(160),
          content: z.string(),
          author_kind: AuthorKind,
          source_kind: SourceKind,
          // sourceItems.capturedAt is stored as the SQL column created_at.
          // captured_at remains accepted for older assembled export envelopes.
          created_at: z.string().datetime({ offset: true }).optional(),
          captured_at: z.string().datetime({ offset: true }).optional(),
          occurred_at: z.string().datetime({ offset: true }).nullish(),
          usage_status: z.enum(["active", "excluded", "deleted"]),
          source_meta: z
            .object({
              root_id: z.string().min(1).optional(),
              about: z.enum(["self", "project", "third_party", "unknown"]).optional(),
              stance: z
                .enum(["endorsed", "not_endorsed", "opposed", "reported", "unknown"])
                .optional(),
            })
            .nullish(),
        })
        .refine(
          (s) =>
            !!(s.created_at ?? s.captured_at) &&
            (!s.created_at ||
              !s.captured_at ||
              Date.parse(s.created_at) === Date.parse(s.captured_at)),
          "exported reported time is missing or contradictory",
        ),
    ),
    evidence: z
      .array(
        z.object({
          source_item_id: z.string().min(1).max(160),
          quote: z.string(),
          locator: z
            .object({
              start: z.number().int().nonnegative().optional(),
              end: z.number().int().positive().optional(),
              whole_source: z.boolean().optional(),
            })
            .nullish(),
        }),
      )
      .optional(),
  }),
});

/** Restore original attribution claims, never old qualifications or report authority. */
export function prepareExportRestore(raw: unknown, namespace: string) {
  const parsed = RestoreExport.safeParse(raw);
  if (!parsed.success) throw new Error("RESTORE_EXPORT_INVALID");
  const data = parsed.data;
  const rows = data.sections.sources.filter((s) => s.usage_status !== "deleted");
  if (new Set(rows.map((s) => s.id)).size !== rows.length)
    throw new Error("RESTORE_EXPORT_INVALID");
  // Exported roots can already include a namespace and exceed the ingest root limit.
  // Map each group to its smallest source identity, independent of order or chunking.
  // Ingest adds the NEW namespace so separate restores cannot merge roots by accident.
  const roots = new Map<string, string>();
  for (const source of rows) {
    const root = source.source_meta?.root_id ?? source.id;
    const first = roots.get(root);
    if (!first || source.id < first) roots.set(root, source.id);
  }
  const chunks: CoreImportEnvelope[] = [];
  for (let offset = 0; offset < rows.length; offset += 100) {
    const sources = rows.slice(offset, offset + 100).map((s) => {
      const spans = (data.sections.evidence ?? [])
        .filter((e) => e.source_item_id === s.id)
        .flatMap((e) => {
          const start = e.locator?.whole_source ? 0 : e.locator?.start;
          const end = e.locator?.whole_source ? s.content.length : e.locator?.end;
          return typeof start === "number" && typeof end === "number"
            ? [{ start, end, quote: e.quote }]
            : [];
        });
      return {
        external_id: s.id,
        version: 1,
        root_id: roots.get(s.source_meta?.root_id ?? s.id),
        text: s.content,
        author: s.author_kind,
        kind: s.source_kind,
        reported_at: s.created_at ?? s.captured_at,
        occurred_at: s.occurred_at ?? null,
        split: "dev",
        excluded: s.usage_status !== "active",
        about: s.source_meta?.about ?? "unknown",
        stance: s.source_meta?.stance ?? "unknown",
        spans,
      };
    });
    chunks.push(
      CoreImportEnvelope.parse({
        format: "findme-core-ingest@1",
        namespace,
        sources,
        historical_reports: [],
      }),
    );
  }
  return {
    chunks,
    restored_as: "needs_review",
    credentials_restored: false,
    generated_reports_not_promoted: true,
  };
}
