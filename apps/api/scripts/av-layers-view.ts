// Read-only localhost viewer for generated L1/L2/L3 staging artifacts.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { RawSession } from "../src/dogfood/freeze.js";
import type { LayerEvidence } from "../src/dogfood/layers.js";
import { outsideRepo } from "../src/dogfood/store.js";
const root = await outsideRepo(
  process.argv[2] ?? "",
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const port = Number(process.argv[3] ?? 8797);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("INVALID_PORT");
const escapeHtml = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
async function data<T>(relative: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path.join(root, relative), "utf8")) as T;
  } catch {
    return fallback;
  }
}
async function rows<T>(relative: string): Promise<T[]> {
  try {
    return (await readFile(path.join(root, relative), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}
const shell = (body: string) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FindMe · AV 分层结果</title><style>body{font:16px/1.65 system-ui,sans-serif;background:#f7f6f2;color:#183c3b;margin:0}main{max-width:1120px;margin:auto;padding:28px}h1{font-size:30px;line-height:1.3}h2{font-size:21px}nav{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0}a{color:#006c67;overflow-wrap:anywhere}nav a{padding:8px 16px;background:white;border:1px solid #c9d6d1;border-radius:8px;text-decoration:none}article{background:white;border:1px solid #dce2dd;border-radius:12px;padding:20px;margin:18px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f0f3ef;padding:14px;border-radius:8px;font:inherit;font-size:14px}small,.muted{color:#5e706e}.tag{display:inline-block;padding:3px 10px;border-radius:6px;background:#e2efeb;font-size:13px}blockquote{border-left:3px solid #008f84;margin:14px 0;padding:6px 16px}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e0e6e1;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:170px 1fr;gap:8px}mark{background:#c3eee3}form{display:flex;gap:10px;flex-wrap:wrap}input,select,button{font:inherit;padding:7px;border:1px solid #bbc9c2;border-radius:6px}label{display:block}@media(max-width:620px){main{padding:16px}article{padding:14px}dl{grid-template-columns:1fr}table{display:block;overflow:auto}}</style></head><body><main><small>FINDME · AV LAYERS</small><h1>AV 分层处理结果</h1><p>所有认识均为待本人复核的候选。L2 是原会话情境归组，不等于已验证的独立生活经历。</p><nav><a href="/">进度与范围</a><a href="/?layer=L1">L1 · 原子证据</a><a href="/?layer=L2">L2 · 情境索引</a><a href="/?layer=L3">L3 · 当前认识</a></nav>${body}</main></body></html>`;
const reference = (id: string) =>
  `<a href="/evidence/${encodeURIComponent(id)}">${escapeHtml(id)}</a>`;
const app = new Hono();
app.use("*", async (c, next) => {
  if (c.req.header("host") !== `127.0.0.1:${port}`) return c.text("HOST_REJECTED", 403);
  const origin = c.req.header("origin");
  if (origin && origin !== `http://127.0.0.1:${port}`) return c.text("ORIGIN_REJECTED", 403);
  if (!["GET", "HEAD"].includes(c.req.method)) return c.text("READ_ONLY", 405);
  c.header("Cache-Control", "no-store");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  c.header("Referrer-Policy", "no-referrer");
  await next();
});
app.get("/health", (c) => c.json({ ready: true, readOnly: true }));
app.get("/", async (c) => {
  const layer = c.req.query("layer");
  let body = "";
  if (layer === "L1") {
    let all = await rows<LayerEvidence>("L1/evidence.jsonl");
    const total = all.length;
    const mode = c.req.query("mode") ?? "all";
    const text = c.req.query("q") ?? "";
    if (mode === "eligible") all = all.filter((e) => e.eligible);
    if (text)
      all = all.filter((e) => [e.quote, e.statement, e.project].some((s) => s.includes(text)));
    const page = Math.max(0, Math.min(10000, Number(c.req.query("page")) || 0));
    const selected = all.slice(page * 40, (page + 1) * 40);
    body = `<h2>L1 原子证据</h2><p>共 ${total} 条；当前过滤 ${all.length} 条。eligible 只表示可用于候选分析，不表示本人已确认。</p><form><input type="hidden" name="layer" value="L1"><select name="mode"><option value="all">全部（含引用/要求）</option value="eligible" ${mode === "eligible" ? "selected" : ""}>可用于本人表达分析</option></select><input name="q" value="${escapeHtml(text)}" placeholder="搜索原文、项目或候选描述"><button>筛选</button></form>`;
    body += selected
      .map(
        (e) =>
          `<article><span class="tag">${escapeHtml(e.author)} · ${escapeHtml(e.kind)} · ${e.eligible ? "可用于候选分析" : "背景/待澄清"}</span><h3>${escapeHtml(e.statement)}</h3><blockquote>${escapeHtml(e.quote)}</blockquote><p>范围：${escapeHtml(e.scope)}</p><small>${escapeHtml(e.project)} · ${escapeHtml(e.time)} · ${escapeHtml(e.sessionId)}</small><p>${reference(e.id)}</p></article>`,
      )
      .join("");
    body += `<nav>${page ? `<a href="/?layer=L1&mode=${encodeURIComponent(mode)}&q=${encodeURIComponent(text)}&page=${page - 1}">上一页</a>` : ""}${(page + 1) * 40 < all.length ? `<a href="/?layer=L1&mode=${encodeURIComponent(mode)}&q=${encodeURIComponent(text)}&page=${page + 1}">下一页</a>` : ""}</nav>`;
  } else if (layer === "L2") {
    const scenes = await rows<{
      id: string;
      project: string;
      sessionId: string;
      split: string;
      time: string;
      evidence_ids: string[];
      eligible_evidence_ids: string[];
      facets: Record<string, string[]>;
      coverage: { processed: number; segments: number };
    }>("L2/scenes.jsonl");
    const focus = c.req.query("scene");
    body = `<h2>L2 情境索引</h2><p>${scenes.length} 个原会话情境。来自 L1 类型、时间、项目和来源关系的确定性组织；不再次把原文交给模型重读。</p>`;
    if (focus) {
      const scene = scenes.find((s) => s.id === focus);
      if (scene)
        body += `<article><h3>${escapeHtml(scene.project)}</h3><p>${escapeHtml(scene.sessionId)} · ${escapeHtml(scene.split)}</p><p><a href="/session/${encodeURIComponent(scene.sessionId)}">完整人工会话与未抽取内容</a></p>${Object.entries(
          scene.facets,
        )
          .filter(([, ids]) => ids.length)
          .map(
            ([facet, ids]) =>
              `<h4>${escapeHtml(facet)}</h4><p>${ids.map(reference).join("<br>")}</p>`,
          )
          .join("")}</article>`;
    } else
      body += `<table><thead><tr><th>项目</th><th>时间</th><th>证据 / 合格</th><th>覆盖</th><th>分区</th></tr></thead><tbody>${scenes.map((s) => `<tr><td><a href="/?layer=L2&scene=${encodeURIComponent(s.id)}">${escapeHtml(s.project)}</a></td><td>${escapeHtml(s.time?.slice(0, 10))}</td><td>${s.evidence_ids.length} / ${s.eligible_evidence_ids.length}</td><td>${s.coverage.processed}/${s.coverage.segments}</td><td>${escapeHtml(s.split)}</td></tr>`).join("")}</tbody></table>`;
  } else if (layer === "L3") {
    const readiness = await data<{ complete?: boolean }>("completion.json", {});
    if (readiness.complete !== true)
      return c.html(
        shell(
          "<h2>L3 生成与完整性核验中</h2><p>已保留的旧候选暂不作为当前结果展示；全部引用核验通过后会显示新版本。</p>",
        ),
      );
    const result = await data<{
      overview?: string;
      claims?: {
        text: string;
        scope: string;
        kind: string;
        evidence_ids: string[];
        counterevidence_ids: string[];
        alternatives: string[];
        uncertainty: string;
        verification_question: string | null;
      }[];
      unknowns?: string[];
      data_limits?: string[];
    }>("L3/current-understanding.json", {});
    body = `<h2>L3 当前认识</h2><p>${escapeHtml(result.overview ?? "尚未生成；先完成 L1/L2。")}</p>`;
    body += (result.claims ?? [])
      .map(
        (claim, index) =>
          `<article><span class="tag">候选 · ${escapeHtml(claim.kind)}</span><h3>${index + 1}. ${escapeHtml(claim.text)}</h3><p><b>范围：</b>${escapeHtml(claim.scope)}</p><p><b>依据：</b>${claim.evidence_ids.map(reference).join(" · ")}</p><p><b>反例：</b>${claim.counterevidence_ids.length ? claim.counterevidence_ids.map(reference).join(" · ") : "未列出不代表不存在"}</p><p><b>替代解释：</b>${escapeHtml(claim.alternatives.join("；"))}</p><p><b>不确定性：</b>${escapeHtml(claim.uncertainty)}</p><p><b>验证问题：</b>${escapeHtml(claim.verification_question ?? "暂无")}</p></article>`,
      )
      .join("");
    body += `<h3>仍未知</h3><ul>${(result.unknowns ?? []).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul><h3>资料边界</h3><ul>${(result.data_limits ?? []).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
  } else {
    const progress = await data("progress.json", {});
    const completion = await data("completion.json", {});
    const plan = await data("layer-plan.json", {});
    body = `<h2>处理状态</h2><p>刷新本页只读取状态，不调用模型。实际 token 为 CLI 可见用量，不是 API 账单。</p><article><pre>${escapeHtml(JSON.stringify((completion as { complete?: boolean }).complete === true ? completion : progress, null, 2))}</pre></article><details><summary>执行范围与预算</summary><pre>${escapeHtml(JSON.stringify(plan, null, 2))}</pre></details>`;
  }
  return c.html(shell(body));
});
app.get("/session/:id", async (c) => {
  const raw = await data<RawSession[]>("raw.json", []);
  const session = raw.find((item) => item.id === c.req.param("id"));
  if (!session) return c.text("SOURCE_NOT_FOUND", 404);
  const messages = session.messages.filter((message) => message.role === "user");
  const page = Math.max(0, Math.min(10000, Number(c.req.query("page")) || 0));
  const coverage = await rows<{
    sessionId: string;
    messageId: string;
    start: number;
    end: number;
    author: string;
    disposition: string;
    note: string;
  }>("L1/coverage.jsonl");
  let body = `<h2>${escapeHtml(session.project ?? "会话")} · 人工原文</h2><p>${escapeHtml(session.id)} · ${messages.length} 条人工消息。原文提交不等于本人观点；分类仍待复核。</p>`;
  body += messages
    .slice(page * 40, (page + 1) * 40)
    .map((message) => {
      const classifications = coverage.filter(
        (row) => row.sessionId === session.id && row.messageId === message.id,
      );
      return `<article><h3>${escapeHtml(message.time ?? "时间未知")}</h3><small>${escapeHtml(message.id)}</small><p>${classifications.map((row) => `<span class="tag">${escapeHtml(row.author)} · ${escapeHtml(row.disposition)}</span> ${escapeHtml(row.note)}`).join("<br>") || "尚无已发布分类"}</p><details><summary>完整原文（包含未被抽成证据的内容）</summary><pre>${escapeHtml(message.text)}</pre></details></article>`;
    })
    .join("");
  body += `<nav>${page ? `<a href="/session/${encodeURIComponent(session.id)}?page=${page - 1}">上一页</a>` : ""}${(page + 1) * 40 < messages.length ? `<a href="/session/${encodeURIComponent(session.id)}?page=${page + 1}">下一页</a>` : ""}</nav>`;
  return c.html(shell(body));
});
app.get("/evidence/:id", async (c) => {
  const evidence = (await rows<LayerEvidence>("L1/evidence.jsonl")).find(
    (e) => e.id === c.req.param("id"),
  );
  if (!evidence) return c.text("EVIDENCE_NOT_FOUND", 404);
  const raw = await data<RawSession[]>("raw.json", []);
  const message = raw
    .find((s) => s.id === evidence.sessionId)
    ?.messages.find((m) => m.id === evidence.messageId);
  if (!message) return c.text("SOURCE_NOT_FOUND", 404);
  const before = message.text.slice(Math.max(0, evidence.start - 600), evidence.start);
  const after = message.text.slice(evidence.end, Math.min(message.text.length, evidence.end + 600));
  return c.html(
    shell(
      `<h2>证据与原文</h2><article><span class="tag">${escapeHtml(evidence.author)} · ${escapeHtml(evidence.kind)} · 待本人复核</span><h3>${escapeHtml(evidence.statement)}</h3><blockquote>${escapeHtml(evidence.quote)}</blockquote><p>范围：${escapeHtml(evidence.scope)}</p><pre>${escapeHtml(JSON.stringify({ ...evidence, quote: undefined, statement: undefined }, null, 2))}</pre><h3>原文相邻上下文</h3><pre>${escapeHtml(before)}<mark>${escapeHtml(message.text.slice(evidence.start, evidence.end))}</mark>${escapeHtml(after)}</pre><details><summary>完整原消息（引用仍不代表本人观点）</summary><pre>${escapeHtml(message.text)}</pre></details></article>`,
    ),
  );
});
app.onError((_error, c) => c.text("LAYER_VIEW_UNAVAILABLE", 500));
serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, readOnly: true }));
