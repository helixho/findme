import type { UnderstandingReport } from "@findme/core";
import { CloudApiError } from "../cloud-api";
export type Session = { user: { id: string; name: string; email: string } };
export type Profile = { id: string; name: string | null; status: string; version: number };
export type Run = {
  id: string;
  domain: string;
  question: string;
  version: number;
  head_version: number;
  status: string;
  created_at?: string;
  updated_at?: string;
  report?: UnderstandingReport | null;
  report_revision_id?: string | null;
  report_status?: string;
  report_origin?: {
    kind: string;
    report_version?: string;
    audit_hash?: string;
    audit_raw_replay?: boolean;
    provenance_available?: boolean;
    redacted?: boolean;
  } | null;
};
export type Job = {
  id: string;
  status: string;
  stage: string;
  calls_used: number;
  call_cap: number;
  error: string | null;
};
export type Source = {
  id: string;
  text: string | null;
  source_kind?: string;
  hash: string;
  status: string;
  assessment_version: number;
  eligibility: string;
};
export type Evidence = {
  evidence_id: string;
  quote: string;
  start: number;
  end: number;
  content_scope?: "full_source" | "quote_excerpt";
  stored_start?: number;
  stored_end?: number;
  original_position?: { start: number; end: number; offset_unit: "utf16" } | null;
  source_ids?: string[];
  session_id?: string | null;
  message_id?: string | null;
  qualifier?: string | null;
  about?: string | null;
  stance?: string | null;
  scope?: string | null;
  reported_at: string | null;
  occurred_at: string | null;
  content_author: string;
  source_id: string;
};
export type OwnerImportPreview = {
  id: string;
  input_hash: string;
  status: "preview" | "confirmed" | "committed";
  source_archive_hash: string;
  source_fingerprint: string;
  reports: {
    domain: string;
    version: string;
    report_hash: string;
    audit_hash: string;
    evidence_count: number;
  }[];
  overall_excluded: true;
  requires_confirmation: true;
};
export const labels: Record<string, string> = {
  awaiting_input: "等待输入",
  pending: "等待处理",
  review_pending: "审核中",
  ready: "当前可读",
  needs_review: "待重新核验",
  archived: "已归档",
  queued: "已排队",
  running: "处理中",
  completed: "完成",
  rejected: "审核未通过",
  failed: "处理失败",
  cancelled: "已取消",
  stale: "依据已变化",
  candidate: "候选",
  unavailable: "尚无报告",
  recorded: "已保存，尚未分析",
  accepted: "已通过审核",
  superseded: "已被后续版本替代",
  processed: "已处理",
};
export const message = (error: unknown) =>
  error instanceof CloudApiError ? error.code : error instanceof Error ? error.message : "操作失败";
export function download(name: string, body: Blob) {
  const url = URL.createObjectURL(body);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function jsonDownload(name: string, value: unknown) {
  download(name, new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
}

export const domainLabels: Record<string, string> = {
  overall: "整体认识",
  self_understanding: "自我理解",
  role_direction: "角色与方向",
  collaboration: "协作与边界",
  daily_conditions: "日常条件",
  relationships: "关系与表达",
};
