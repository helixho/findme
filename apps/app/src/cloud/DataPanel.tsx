import { useEffect, useState } from "react";
import { cloudFile, cloudMutation, cloudRequest, currentCloudProfile } from "../cloud-api";
import { type Source, download, jsonDownload, message } from "./shared";

export function DataPanel() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [cursor, setCursor] = useState<number | null>(0);
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
      <p>这里是参与形成理解的原话和文件。“不再用于分析”可以恢复，删除原文不可撤回。</p>
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
                    { content_sha256, byte_length: file.size, media_type, file_name: file.name },
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
