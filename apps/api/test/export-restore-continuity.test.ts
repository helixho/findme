import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareExportRestore } from "../src/cloud-diagnostic/ingest-adapter.js";

const time = "2026-01-02T03:04:05.000Z";
function source(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    content: "这是合成原话。",
    author_kind: "subject",
    source_kind: "quick_note",
    captured_at: time,
    occurred_at: "2025-12-01T00:00:00.000Z",
    usage_status: "active",
    source_meta: { root_id: "old-namespace:shared-root", about: "self", stance: "not_endorsed" },
    ...overrides,
  };
}
function archive(sources = [source()]) {
  return { format: "findme-personal-export@1", sections: { sources, evidence: [] } };
}

describe("personal export restore continuity / no database or model", () => {
  it("retains source restrictions, author, event time and exclusion while ignoring old authority", () => {
    const original = source({
      author_kind: "third_party",
      usage_status: "excluded",
      source_meta: {
        root_id: "old-root",
        about: "third_party",
        stance: "not_endorsed",
        owner_confirmed: true,
        target_context: { report_id: randomUUID(), role: "accepted" },
        qualification: { status: "eligible" },
      },
    });
    const raw = {
      ...archive([original]),
      sections: {
        ...archive([original]).sections,
        reports: [{ status: "accepted", body: { old: "generated" } }],
        qualifications: [{ status: "eligible" }],
      },
    };
    const prepared = prepareExportRestore(raw, "new-restore");
    expect(prepared).toMatchObject({
      restored_as: "needs_review",
      generated_reports_not_promoted: true,
    });
    expect(prepared.chunks[0]!.sources[0]).toEqual({
      external_id: original.id,
      version: 1,
      root_id: original.id,
      text: original.content,
      author: "third_party",
      kind: "quick_note",
      reported_at: time,
      occurred_at: original.occurred_at,
      split: "dev",
      excluded: true,
      about: "third_party",
      stance: "not_endorsed",
      spans: [],
    });
    expect(prepared.chunks[0]!.historical_reports).toEqual([]);
  });
  it("accepts the real SQL export created_at and the old captured_at alias without changing reported time", () => {
    const current = source({ captured_at: undefined, created_at: time });
    expect(
      prepareExportRestore(archive([current]), "sql-export").chunks[0]!.sources[0]!.reported_at,
    ).toBe(time);
    expect(() =>
      prepareExportRestore(archive([source({ captured_at: undefined })]), "no-time"),
    ).toThrow("RESTORE_EXPORT_INVALID");
    expect(() =>
      prepareExportRestore(
        archive([source({ created_at: "2024-01-01T00:00:00Z" })]),
        "conflicting-time",
      ),
    ).toThrow("RESTORE_EXPORT_INVALID");
  });
  it("keeps shared roots across chunks and source order, including long previously namespaced roots", () => {
    const rows = Array.from({ length: 101 }, () =>
      source({
        source_meta: {
          root_id: "previous-namespace:".repeat(20),
          about: "self",
          stance: "opposed",
        },
      }),
    );
    const first = prepareExportRestore(archive(rows), "restore-a");
    const second = prepareExportRestore(archive([...rows].reverse()), "restore-b");
    const roots = first.chunks.flatMap((c) => c.sources.map((s) => s.root_id));
    expect(first.chunks).toHaveLength(2);
    expect(new Set(roots)).toEqual(new Set([rows.map((s) => s.id).sort()[0]]));
    expect(new Set(second.chunks.flatMap((c) => c.sources.map((s) => s.root_id)))).toEqual(
      new Set(roots),
    );
    expect(first.chunks[0]!.namespace).not.toBe(second.chunks[0]!.namespace);
  });
  it.each([undefined, null, {}])("uses explicit unknown for missing old metadata %j", (meta) => {
    const original = source({ source_meta: meta, occurred_at: undefined });
    const parsed = prepareExportRestore(archive([original]), "old-export");
    expect(parsed.chunks[0]!.sources[0]).toMatchObject({
      root_id: original.id,
      about: "unknown",
      stance: "unknown",
      occurred_at: null,
    });
  });
  it.each([
    { source_meta: { about: "other" } },
    { source_meta: { about: false } },
    { source_meta: { stance: "accepted" } },
    { source_meta: { stance: null } },
    { source_meta: { root_id: 17 } },
    { source_meta: { root_id: "" } },
    { source_meta: [] },
    { author_kind: "owner" },
    { usage_status: "accepted" },
    { occurred_at: 123 },
  ])("rejects present malformed fields instead of erasing their meaning: %j", (change) => {
    expect(() => prepareExportRestore(archive([source(change)]), "bad-export")).toThrow(
      "RESTORE_EXPORT_INVALID",
    );
  });
  it.each([
    null,
    [],
    {},
    { format: "findme-personal-export@2", sections: { sources: [] } },
    { format: "findme-personal-export@1", sections: { sources: "wrong" } },
    { format: "findme-personal-export@1", sections: { sources: [null] } },
  ])("rejects malformed export structure %j", (raw) => {
    expect(() => prepareExportRestore(raw, "bad-export")).toThrow("RESTORE_EXPORT_INVALID");
  });
  it("retains exact exported evidence and omits deleted originals", () => {
    const original = source();
    const raw = archive([original, source({ usage_status: "deleted", content: "" })]);
    (raw.sections.evidence as unknown[]) = [
      { source_item_id: original.id, quote: original.content, locator: { whole_source: true } },
    ];
    const parsed = prepareExportRestore(raw, "evidence-restore");
    expect(parsed.chunks[0]!.sources).toHaveLength(1);
    expect(parsed.chunks[0]!.sources[0]!.spans).toEqual([
      { start: 0, end: original.content.length, quote: original.content },
    ]);
    (raw.sections.evidence as any[])[0].locator.whole_source = "true";
    expect(() => prepareExportRestore(raw, "bad-export")).toThrow("RESTORE_EXPORT_INVALID");
  });
  it("rejects duplicate source identities even if they would cross a chunk boundary", () => {
    const original = source();
    expect(() => prepareExportRestore(archive([original, original]), "duplicates")).toThrow(
      "RESTORE_EXPORT_INVALID",
    );
  });
});
