import { useEffect, useState } from "react";
import { cloudFile, cloudMutation, cloudRequest, currentCloudProfile } from "../cloud-api";
import { type OwnerImportPreview, type Source, download, jsonDownload, message } from "./shared";

export function DataPanel() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [cursor, setCursor] = useState<number | null>(0);
  const [preview, setPreview] = useState<{
    id: string;
    input_hash: string;
    items: unknown[];
    holdout_omitted: number;
  } | null>(null);
  const [ownerImport, setOwnerImport] = useState<OwnerImportPreview | null>(null);
  const [ownerImportResult, setOwnerImportResult] = useState("");
  const [blobs, setBlobs] = useState<
    { id: string; status: string; media_type: string; byte_length: number }[]
  >([]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    const data = await cloudRequest<{ items: Source[]; next_cursor: number | null }>(
      "/api/data/sources",
    );
    setSources(data.items);
    setCursor(data.next_cursor);
    const files = await cloudRequest<{ items: typeof blobs }>("/api/blobs");
    setBlobs(files.items);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial load runs once; later reloads are explicit.
  useEffect(() => {
    void reload().catch((e) => setError(message(e)));
  }, []);
  async function exportAll() {
    const manifest = await cloudRequest<{ parts: string[]; [k: string]: unknown }>(
      "/api/data/export",
    );
    const sections: Record<string, unknown[]> = {};
    for (const part of manifest.parts) {
      let next: number | null = 0;
      const rows: unknown[] = [];
      while (next !== null) {
        const page: { items: unknown[]; next_cursor: number | null } = await cloudRequest<{
          items: unknown[];
          next_cursor: number | null;
        }>(`/api/data/export/${encodeURIComponent(part)}?cursor=${next}`);
        rows.push(...page.items);
        next = page.next_cursor;
      }
      sections[part] = rows;
    }
    jsonDownload("findme-personal-export.json", {
      ...manifest,
      exported_at: new Date().toISOString(),
      sections,
    });
  }
  return (
    <section>
      <h2>我的资料</h2>
      <p>
        普通文件导入只保存来源与候选；已通过的 U2
        专题须走下方固定归档的一次性导入。排除可恢复，删除原文不可撤回。
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="cloud-actions">
        <button type="button" disabled={busy} onClick={() => void action(reload)}>
          刷新资料
        </button>
        <button type="button" disabled={busy} onClick={() => void action(exportAll)}>
          导出完整结构化数据包
        </button>
      </div>
      <section className="home-section">
        <h3>导入已审核专题</h3>
        <p>
          从服务端固定归档读取原 U2
          审核结果、报告与精确引文。先预览，再确认并提交；不会调用模型，也不会导入未通过专题或缺失的综合总览。
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              setOwnerImportResult("");
              setOwnerImport(
                await cloudMutation<OwnerImportPreview>("/api/data/u2-import/preview", {}),
              );
            })
          }
        >
          预览固定归档
        </button>
        {ownerImport && (
          <div>
            <p>
              {ownerImport.reports.length} 个已审核专题 · 状态 {ownerImport.status} · 来源指纹{" "}
              {ownerImport.source_fingerprint.slice(0, 12)}…
            </p>
            <ul>
              {ownerImport.reports.map((report) => (
                <li key={`${report.domain}:${report.version}`}>
                  {report.domain} · 精确依据 {report.evidence_count} 条
                </li>
              ))}
            </ul>
            {ownerImport.status === "preview" && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    if (!window.confirm("确认这批已审核专题属于当前 Profile，并进入提交准备？"))
                      return;
                    const result = await cloudMutation<{ status: "confirmed" }>(
                      `/api/data/u2-import/${ownerImport.id}/confirm`,
                      { input_hash: ownerImport.input_hash, confirm: true },
                    );
                    setOwnerImport({ ...ownerImport, status: result.status });
                  })
                }
              >
                确认归属与范围
              </button>
            )}
            {ownerImport.status === "confirmed" && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    if (!window.confirm("将这批已审核专题写入当前 Profile？不调用模型。")) return;
                    const result = await cloudMutation<{
                      status: "committed";
                      imported: { domain: string }[];
                      model_calls: 0;
                    }>(`/api/data/u2-import/${ownerImport.id}/commit`, {
                      input_hash: ownerImport.input_hash,
                      confirm: true,
                    });
                    setOwnerImport({ ...ownerImport, status: result.status });
                    setOwnerImportResult(`已导入 ${result.imported.length} 个专题；未调用模型。`);
                    await reload();
                  })
                }
              >
                提交一次性导入
              </button>
            )}
          </div>
        )}
        {ownerImportResult && <output>{ownerImportResult}</output>}
      </section>
      <section className="home-section">
        <h3>导入来源</h3>
        <label>
          选择导入包、精确证据包或个人导出文件
          <input
            type="file"
            accept="application/json"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void action(async () => {
                  if (file.size > 2 * 1024 * 1024) throw new Error("请按每批不超过2MB分批导入");
                  const raw = JSON.parse(await file.text());
                  if (
                    raw.format === "diagnostic-evidence-packet@1" ||
                    raw.format === "findme-personal-export@1"
                  ) {
                    const namespace = window.prompt(
                      "导入命名空间（用于稳定去重）：",
                      "personal-import",
                    );
                    if (!namespace) return;
                    const prepared = await cloudMutation<{ chunks: unknown[] }>(
                      raw.format === "diagnostic-evidence-packet@1"
                        ? "/api/data/imports/prepare"
                        : "/api/data/imports/restore-prepare",
                      raw.format === "diagnostic-evidence-packet@1"
                        ? { namespace, packet: raw }
                        : { namespace, export: raw },
                    );
                    if (prepared.chunks.length !== 1) {
                      prepared.chunks.forEach((chunk, index) =>
                        jsonDownload(`findme-import-${index + 1}.json`, chunk),
                      );
                      throw new Error(
                        `已生成 ${prepared.chunks.length} 个导入分片，请逐个预览后提交。`,
                      );
                    }
                    setPreview(
                      await cloudMutation("/api/data/imports/preview", prepared.chunks[0]),
                    );
                  } else setPreview(await cloudMutation("/api/data/imports/preview", raw));
                });
            }}
          />
        </label>
        {preview && (
          <div>
            <p>
              预览项目 {preview.items.length} 条；留出资料略过 {preview.holdout_omitted} 条。
            </p>
            <pre>{JSON.stringify(preview.items, null, 2)}</pre>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  if (!window.confirm("确认将本次预览中的来源保存到当前 Profile？不调用模型。"))
                    return;
                  await cloudMutation(`/api/data/imports/${preview.id}/commit`, {
                    input_hash: preview.input_hash,
                    confirm: true,
                  });
                  setPreview(null);
                  await reload();
                })
              }
            >
              确认本批导入
            </button>
          </div>
        )}
      </section>
      <section>
        <h3>来源与使用状态</h3>
        {sources.map((s) => (
          <article key={s.id}>
            <p>{s.text ?? "原文已删除"}</p>
            <small>
              {s.source_kind === "u2_quote_excerpt" ? "归档引文片段（非原文全文） · " : ""}
              {s.status} · {s.eligibility}
            </small>
            <div className="cloud-actions">
              {s.status === "active" &&
                s.source_kind === "action_trial_review" &&
                s.eligibility === "needs_review" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        if (
                          !window.confirm(
                            "确认这份尝试回顾准确记录了你的报告，并允许作为专题候选来源？",
                          )
                        )
                          return;
                        await cloudMutation(`/api/core/sources/${s.id}/assessment`, {
                          expected_assessment_version: s.assessment_version,
                          assessment: {
                            attribution_status: "confirmed_subject",
                            context_completeness: "partial",
                            temporal_precision: "exact",
                            eligibility: "eligible",
                            rationale:
                              "本人确认这份结构化尝试回顾准确记录了自己的报告；实际作用仍待结合其他来源判断。",
                          },
                        });
                        await reload();
                      })
                    }
                  >
                    确认为本人回顾来源
                  </button>
                )}
              {s.status !== "deleted" && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await cloudMutation(`/api/data/sources/${s.id}/actions`, {
                          action: s.status === "excluded" ? "restore" : "exclude",
                          expected_hash: s.hash,
                          expected_assessment_version: s.assessment_version,
                        });
                        await reload();
                      })
                    }
                  >
                    {s.status === "excluded" ? "恢复为待核验来源" : "不再用于分析"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const replacement = window.prompt(
                          "输入当前 Profile 中已保存的替代来源 ID：",
                        );
                        if (!replacement) return;
                        await cloudMutation(`/api/data/sources/${s.id}/rebind`, {
                          expected_hash: s.hash,
                          replacement_source_id: replacement,
                        });
                        await reload();
                      })
                    }
                  >
                    重绑替代来源
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        if (
                          !window.confirm(
                            s.source_kind === "u2_quote_excerpt"
                              ? "删除这条归档引文片段并撤下依赖它的报告内容？原始归档另行处置。"
                              : "删除这条原文，并清除或撤下其依赖的报告内容？已单独托管的原档请另行删除。",
                          )
                        )
                          return;
                        await cloudMutation(`/api/data/sources/${s.id}/actions`, {
                          action: "delete",
                          expected_hash: s.hash,
                          expected_assessment_version: s.assessment_version,
                          confirmation: s.id,
                        });
                        await reload();
                      })
                    }
                  >
                    删除原文
                  </button>
                </>
              )}
            </div>
            <small>来源 ID：{s.id}</small>
          </article>
        ))}
        {cursor !== null && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const page = await cloudRequest<{ items: Source[]; next_cursor: number | null }>(
                  `/api/data/sources?cursor=${cursor}`,
                );
                setSources((xs) => [...xs, ...page.items]);
                setCursor(page.next_cursor);
              })
            }
          >
            更多来源
          </button>
        )}
      </section>
      <section className="home-section">
        <h3>托管原档</h3>
        <label>
          上传原始文件
          <input
            type="file"
            accept=".json,.jsonl,.txt,.pdf"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void action(async () => {
                  if (file.size > 50 * 1024 * 1024) throw new Error("原档上限50MB");
                  const bytes = await file.arrayBuffer();
                  const hash = await crypto.subtle.digest("SHA-256", bytes);
                  const content_sha256 = Array.from(new Uint8Array(hash), (n) =>
                    n.toString(16).padStart(2, "0"),
                  ).join("");
                  const media_type = file.name.endsWith(".jsonl")
                    ? "application/x-ndjson"
                    : file.type || "text/plain";
                  const declared = await cloudMutation<{ id: string; status: string }>(
                    "/api/blobs",
                    { content_sha256, byte_length: file.size, media_type },
                  );
                  if (declared.status === "declared")
                    await cloudFile(`/api/blobs/${declared.id}/content`, {
                      method: "PUT",
                      body: file,
                    });
                  await reload();
                });
            }}
          />
        </label>
        {blobs.map((b) => (
          <div key={b.id}>
            <p>
              {b.id} · {b.status} · {b.byte_length} bytes
            </p>
            <div className="cloud-actions">
              <button
                type="button"
                disabled={busy || b.status !== "available"}
                onClick={() =>
                  void action(async () =>
                    download(b.id, await (await cloudFile(`/api/blobs/${b.id}/content`)).blob()),
                  )
                }
              >
                下载原档
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await cloudMutation(`/api/blobs/${b.id}/recover`, {});
                    await reload();
                  })
                }
              >
                恢复未完成操作
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    if (!window.confirm("永久删除此托管原档？")) return;
                    await cloudMutation(`/api/blobs/${b.id}`, { confirm: true }, "DELETE");
                    await reload();
                  })
                }
              >
                删除原档
              </button>
            </div>
          </div>
        ))}
      </section>
      <details>
        <summary>清除当前 Profile 的个人数据</summary>
        <p>
          删除来源、诊断、反馈、框架状态和托管原档。账号与 Profile
          身份保留，费用累计不清零。已下载到其他设备的副本不会自动撤回。
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              if (!window.confirm("确认清除当前 Profile 的全部个人数据？此操作不可撤回。")) return;
              const storageKey = `findme_cloud:erase:${currentCloudProfile()}`;
              const key = localStorage.getItem(storageKey) ?? crypto.randomUUID();
              localStorage.setItem(storageKey, key);
              const result = await cloudRequest<{ completed: boolean; remaining_objects?: number }>(
                "/api/data/erase-profile",
                {
                  method: "POST",
                  headers: { "Idempotency-Key": key },
                  body: JSON.stringify({ confirm: true }),
                },
              );
              if (result.completed) {
                localStorage.removeItem(storageKey);
                for (let i = localStorage.length - 1; i >= 0; i--) {
                  const k = localStorage.key(i);
                  if (k?.startsWith("findme_cloud:draft:") && k.includes(currentCloudProfile()))
                    localStorage.removeItem(k);
                }
                await reload();
              } else
                setError(
                  `清理未完成，剩余原档 ${result.remaining_objects ?? "未知"} 个。再次点击将继续同一任务。`,
                );
            })
          }
        >
          清除数据／恢复未完成清理
        </button>
      </details>
    </section>
  );
}
