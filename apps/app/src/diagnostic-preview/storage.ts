import type { CaseId } from "./scenarios";
import { PreviewError, applyCommand, createPreviewState, parsePreviewState } from "./state";
import type { Command, PreviewState } from "./state";

export interface PreviewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export const storageKey = (caseId: CaseId) => `findme:synthetic-diagnostic:c1:v1:${caseId}`;
export type LoadResult =
  | { kind: "ready"; state: PreviewState; saved: boolean }
  | { kind: "corrupt"; raw: string; message: string }
  | { kind: "unavailable"; message: string };
export function loadPreview(storage: PreviewStorage, caseId: CaseId): LoadResult {
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey(caseId));
  } catch {
    return {
      kind: "unavailable",
      message: "无法读取本机存储。可以浏览示例，输入暂未保存；请保留或导出。",
    };
  }
  if (raw === null) return { kind: "ready", state: createPreviewState(caseId), saved: false };
  try {
    return { kind: "ready", state: parsePreviewState(JSON.parse(raw), caseId), saved: true };
  } catch {
    return {
      kind: "corrupt",
      raw,
      message: "本例存储损坏或版本不兼容。原内容保留；请先导出，或确认后重置本例。",
    };
  }
}
export class StorageWriteError extends Error {
  constructor(
    public unsaved: PreviewState,
    public cause: unknown,
  ) {
    super("本机写入失败，未保存。输入与修改保留在此页，请导出或重试保存。");
  }
}
// Read immediately before mutation. No fallback overwrite on corrupt/stale storage.
export function commitPreview(
  storage: PreviewStorage,
  shown: PreviewState,
  command: Command,
): PreviewState {
  const loaded = loadPreview(storage, shown.case_id);
  if (loaded.kind !== "ready") throw new PreviewError("invalid", loaded.message);
  const latest = loaded.state;
  if (!loaded.saved && shown.run.version !== 1)
    throw new PreviewError("stale", "本例被另一页重置。输入仍保留，请重新读取本例。");
  const next = applyCommand(latest, command);
  if (next === latest && loaded.saved) return next;
  try {
    storage.setItem(storageKey(shown.case_id), JSON.stringify(next));
  } catch (error) {
    throw new StorageWriteError(next, error);
  }
  return next;
}
export function resetPreview(storage: PreviewStorage, caseId: CaseId): PreviewState {
  // Caller confirms the exact selected case. Never localStorage.clear().
  const next = createPreviewState(caseId);
  try {
    storage.setItem(storageKey(caseId), JSON.stringify(next));
  } catch (error) {
    throw new StorageWriteError(next, error);
  }
  return next;
}
export function exportPreview(state: PreviewState) {
  const parsed = parsePreviewState(state, state.case_id);
  return JSON.stringify(
    {
      label: "合成示例 · 非本人诊断 · 本机预览",
      storage_scope: storageKey(state.case_id),
      ...parsed,
    },
    null,
    2,
  );
}
