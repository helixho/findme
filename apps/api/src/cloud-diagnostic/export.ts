import type { Db } from "@findme/db";
import { sql } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import { withProfileTransaction } from "./scope.js";
// Fixed server-owned table/ownership paths only; no arbitrary identifiers from query parameters.
const parts: Record<string, { table: string; owner: string; order: string | string[] }> = {
  archive_batches: {
    table: "av_processed_batches",
    owner: "t.tenant_id=$T and t.subject_id=$S",
    order: ["namespace", "batch_hash"],
  },
  archive_chunks: {
    table: "av_processed_chunks",
    owner: "t.tenant_id=$T and t.subject_id=$S",
    order: ["namespace", "batch_hash", "artifact_hash", "part"],
  },
  sources: { table: "source_items", owner: "t.tenant_id=$T and t.subject_id=$S", order: "id" },
  assessments: {
    table: "source_assessments",
    owner:
      "exists(select 1 from source_items s where s.id=t.source_item_id and s.tenant_id=$T and s.subject_id=$S)",
    order: "id",
  },
  evidence: {
    table: "evidence_spans",
    owner:
      "exists(select 1 from source_items s where s.id=t.source_item_id and s.tenant_id=$T and s.subject_id=$S)",
    order: "id",
  },
  source_links: {
    table: "source_links",
    owner:
      "exists(select 1 from source_items s where s.id=t.source_item_id and s.tenant_id=$T and s.subject_id=$S)",
    order: "id",
  },
  experiences: { table: "experiences", owner: "t.tenant_id=$T and t.subject_id=$S", order: "id" },
  experience_evidence: {
    table: "experience_evidence",
    owner:
      "exists(select 1 from experiences e where e.id=t.experience_id and e.tenant_id=$T and e.subject_id=$S)",
    order: "id",
  },
  explorations: { table: "explorations", owner: "t.tenant_id=$T and t.subject_id=$S", order: "id" },
  exploration_turns: {
    table: "exploration_turns",
    owner:
      "exists(select 1 from explorations e where e.id=t.exploration_id and e.tenant_id=$T and e.subject_id=$S)",
    order: "id",
  },
  exploration_questions: {
    table: "exploration_questions",
    owner:
      "exists(select 1 from explorations e where e.id=t.exploration_id and e.tenant_id=$T and e.subject_id=$S)",
    order: "id",
  },
  exploration_steps: {
    table: "exploration_steps",
    owner:
      "exists(select 1 from explorations e where e.id=t.exploration_id and e.tenant_id=$T and e.subject_id=$S)",
    order: "id",
  },
  gaps: {
    table: "knowledge_gaps",
    owner:
      "exists(select 1 from explorations e where e.id=t.exploration_id and e.tenant_id=$T and e.subject_id=$S)",
    order: "id",
  },
  claims: { table: "claims", owner: "t.tenant_id=$T and t.subject_id=$S", order: "id" },
  claim_revisions: {
    table: "claim_revisions",
    owner:
      "exists(select 1 from claims c where c.id=t.claim_id and c.tenant_id=$T and c.subject_id=$S)",
    order: "id",
  },
  claim_evidence: {
    table: "claim_evidence",
    owner:
      "exists(select 1 from claim_revisions r join claims c on c.id=r.claim_id where r.id=t.claim_revision_id and c.tenant_id=$T and c.subject_id=$S)",
    order: "id",
  },
  pi_session_archives: {
    table: "pi_session_archives",
    owner: "t.tenant_id=$T and t.subject_id=$S",
    order: "id",
  },
  operations: {
    table: "core_operations",
    owner: "t.tenant_id=$T and t.subject_id=$S",
    order: "id",
  },
  feedback: { table: "feedback_events", owner: "t.tenant_id=$T and t.subject_id=$S", order: "id" },
};
for (const [name, table] of Object.entries({
  runs: "diagnostic_runs",
  reports: "diagnostic_report_revisions",
  dependencies: "diagnostic_report_sources",
  responses: "diagnostic_responses",
  jobs: "cloud_diagnostic_jobs",
  attempts: "cloud_diagnostic_attempts",
  qualifications: "source_qualifications",
  imports: "core_import_batches",
  lifecycle: "core_lifecycle_actions",
  blobs: "source_blobs",
  frameworks: "cloud_framework_states",
  knowledge_processing_records: "knowledge_processing_records",
  specialist_sessions: "specialist_sessions",
  specialist_proposals: "specialist_proposals",
  specialist_trials: "specialist_trials",
}))
  parts[name] = {
    table,
    owner: "t.tenant_id=$T and t.subject_id=$S",
    order: name === "frameworks" ? "subject_id" : "id",
  };
export class CloudExportService {
  constructor(private db: Db) {}
  manifest() {
    return {
      format: "findme-personal-export@1",
      parts: Object.keys(parts),
      paging: true,
      snapshot: "per-page transaction; not an atomic cross-request backup",
      excluded: ["authentication secrets and sessions", "unhosted local originals"],
      original_blobs: "separate authenticated downloads by blob id",
      archive: {
        payload:
          "PostgreSQL bytea hex string (backslash + x prefix followed by exact payload bytes in hex); hashes remain lowercase SHA-256 hex",
        restore:
          "Explicit archive restore handoff: validate manifest, keys, part SHA-256 and artifact hashes before restoring batches then chunks; opaque processed artifacts are not personal claims and require the existing explicit preview/import qualification path",
      },
      restore:
        "source re-import requires explicit preview; derived reports are not automatically trusted",
    };
  }
  async page(ctx: PersonalContext, name: string, offset = 0) {
    const part = parts[name];
    if (!part || !Number.isSafeInteger(offset) || offset < 0)
      throw new Error("EXPORT_PART_INVALID");
    return withProfileTransaction(this.db, ctx, async (tx) => {
      // Scope placeholders are SQL parameters, while identifiers come only from the map above.
      const segments = part.owner.split(/(\$T|\$S)/);
      const where = sql.join(
        segments.map((v) =>
          v === "$T"
            ? sql`${ctx.tenantId}::uuid`
            : v === "$S"
              ? sql`${ctx.subjectId}::uuid`
              : sql.raw(v),
        ),
        sql.raw(""),
      );
      // Fix the wire representation independently of the session's bytea_output setting.
      const projection =
        name === "archive_chunks"
          ? sql`to_jsonb(t) || jsonb_build_object('payload', chr(92) || 'x' || encode(t.payload,'hex'))`
          : sql`to_jsonb(t)`;
      const rows = await tx.execute(
        sql`select ${projection} as row from ${sql.identifier(part.table)} t where ${where} order by ${sql.join(
          (Array.isArray(part.order) ? part.order : [part.order]).map((column) =>
            sql.identifier(column),
          ),
          sql.raw(", "),
        )} offset ${offset} limit 101`,
      );
      return {
        part: name,
        items: Array.from(rows)
          .slice(0, 100)
          .map((r) => r.row),
        next_cursor: rows.length > 100 ? offset + 100 : null,
      };
    });
  }
}
