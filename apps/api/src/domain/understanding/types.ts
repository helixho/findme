import type { ReasoningEvidence } from "@findme/core";

export type Fact = {
  id: string;
  canonical_id: string;
  root_ids: string[];
  source_id: string;
  quote: string;
  start: number;
  end: number;
  content_author: ReasoningEvidence["content_author"];
  about: ReasoningEvidence["about"];
  kind: ReasoningEvidence["kind"];
  stance: ReasoningEvidence["stance"];
  use: "personal_expression" | "project_report" | "context";
  scope: string;
  session_id: string;
  message_id: string;
  project: string;
  time: string | null;
  group_id: string;
  facet: string;
  proposition_type: string;
  proposition: string;
  purpose: string;
  original_facet: string;
  provenance: string;
  qualifier: {
    start: number;
    end: number;
    text: string;
    use: "context";
  } | null;
};
export type Selection = {
  selection_version?: string;
  domain: string;
  evidence: Fact[];
  omitted: {
    id: string;
    reason: string;
  }[];
  bytes: number;
  selected_original_atoms: number;
  canonical_count: number;
  scope: string;
  repair_inputs_unavailable: string[];
};
export type OldClaim = {
  id: string;
  text: string;
  scope: string;
  kind: string;
  type?: string;
  evidence_ids: string[];
  counterevidence_ids: string[];
  alternatives?: string[];
  uncertainty?: string;
};
