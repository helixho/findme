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
  /** Generation time of the current report revision (fixed, unlike updated_at). */
  report_created_at?: string | null;
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
const modelErrors: Record<string, string> = {
  LLM_TIMEOUT: "模型响应超时，可以稍后重新处理。",
  LLM_PROVIDER: "模型服务暂时无法响应，可以稍后重新处理。",
  LLM_QUOTA: "模型服务额度不足，请检查模型设置。",
  LLM_RATE_LIMIT: "模型服务请求受限，可以稍后重新处理。",
  LLM_AUTHENTICATION: "模型服务认证失败，请检查模型设置。",
  LLM_MODEL_NOT_FOUND: "所选模型不可用，请检查模型设置。",
  LLM_BAD_REQUEST: "模型服务未接受请求，请检查模型设置。",
  LLM_JSON_PARSE: "模型未返回可用结果，可以稍后重新处理。",
  PI_REQUEST_LIMIT_REACHED: "本轮请求次数已用完，输入已保存，可以稍后继续。",
  PI_COST_LIMIT_REACHED: "本轮费用上限已到，输入已保存。",
  PI_INPUT_LIMIT_REACHED: "本轮材料超过处理上限，原文已保存。",
  PI_USER_ABORTED: "本轮已停止，输入已保存，可以继续聊。",
  PI_MODEL_ERROR: "模型暂未完成回应，输入已保存。",
  PI_RECORD_FAILED: "本轮记录未保存完成，输入已保存。",
  PI_REPLY_FORMAT_INVALID: "模型未返回可用回应，输入已保存。",
  PI_SESSION_BUSY: "这个会话正在回应，请稍后继续。",
  PI_SOURCE_CHANGED_DURING_RUN: "相关材料已变化，请刷新后重新处理。",
  PI_ARCHIVE_STALE_DEPENDENCY: "相关材料已变化，请刷新后重新处理。",
  PI_ARCHIVE_STALE_REVISION: "会话已变化，请刷新后继续。",
  PI_OPENROUTER_ENDPOINT_REQUIRED: "当前模型地址不支持此运行方式。",
  SOURCE_NOT_ELIGIBLE: "当前输入不可用于对话，请检查来源状态。",
  LLM_SCHEMA_VALIDATION: "模型返回结果不符合要求，可以稍后重新处理。",
};
export const message = (error: unknown) =>
  error instanceof CloudApiError
    ? (modelErrors[error.code] ??
      (error.status >= 500 && (error.code === "internal" || /^HTTP_5\d{2}$/.test(error.code))
        ? "暂时无法确认处理结果，请先刷新状态。"
        : error.code))
    : error instanceof Error
      ? error.message
      : "操作失败";
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
