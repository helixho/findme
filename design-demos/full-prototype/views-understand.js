/* 首页、当前认识、纠正与修订 */
const claimText = (id, old = false) =>
  state.revised && CLAIMS[id].revisedText && !old ? CLAIMS[id].revisedText : CLAIMS[id].text;
const claimNote = (id) =>
  state.revised && CLAIMS[id].revisedNote ? CLAIMS[id].revisedNote : CLAIMS[id].note;
const version = (key) => (state.revised && (key === "work" || key === "overall") ? 2 : 1);
function topicTag(key) {
  const t = TOPICS[key];
  if (key === "work" && state.revised) return tag("已纳入修订", "current");
  if (state.corrections.some((c) => CLAIMS[c.claim].topic === key && c.status !== "done"))
    return tag("有纠正待核验", "pending");
  return {
    evidence: tag("有依据 · 待澄清"),
    early: tag("刚开始 · 范围很窄"),
    unknown: tag("资料不足 · 保持未知"),
  }[t.status];
}
function topicCard(key) {
  const t = TOPICS[key];
  return link(
    `topic/${key}`,
    `${topicTag(key)}<h3>${t.label}</h3><p>${t.card}</p><div class="foot"><span class="muted small">${t.origin}</span>${icon("right")}</div>`,
    "card",
  );
}
function subtabs(active) {
  const items = [
    ["understand", "整体认识"],
    ["understand/topics", `专题 <span class="count">${Object.keys(TOPICS).length}</span>`],
    ["understand/framework", "框架报告"],
    ["understand/changes", "变化记录"],
  ];
  return `<nav class="subtabs" aria-label="当前认识">${items.map(([r, l]) => link(r, l, active === r ? "active" : "", active === r ? 'aria-current="page"' : "")).join("")}</nav>`;
}
function claimCard(id, { old = false, showTopic = false } = {}) {
  const c = CLAIMS[id];
  const revised = state.revised && c.revisedText && !old;
  const sources = revised ? c.revisedSources : c.sources;
  const counter = revised ? c.revisedCounter : c.counter;
  const pending = !old && state.corrections.find((x) => x.claim === id && x.status !== "done");
  return `<article class="claim ${revised ? "revised" : ""}" aria-label="判断">
    <div class="claim-top">${revised ? tag("已修订 · 版本 2", "current") : pending ? tag("你的纠正待核验", "pending") : tag("待你核对的判断")}${showTopic ? `<span class="small muted">${TOPICS[c.topic].label}</span>` : ""}</div>
    <h3>${esc(claimText(id, old))}</h3>
    <p>${esc(old ? c.note : claimNote(id))}</p>
    <div class="claim-scope"><div><small>适用范围</small><span>${esc(c.scope)}</span></div><div><small>依据</small><span>${sources.length} 段记录${counter ? ` · 含 ${counter} 个反例` : ""}</span></div></div>
    <div class="actions">
      <button type="button" class="button quiet small" data-action="evidence" data-claim="${id}" data-old="${old ? 1 : 0}">查看依据与反例</button>
      ${old ? "" : `${link(`correct/${id}`, "纠正或补充", "button small primary")}${link(`explore/continue/${id}`, "继续理解", "text-button")}`}
    </div>
  </article>`;
}

VIEWS.home = () => ({
  title: "今天想聊什么", nav: "home",
  body: `<section class="daily-home"><div class="daily-heading"><span class="eyebrow">FINDME · 日常商量</span><h1>今天，想从哪里说起？</h1><p class="muted">一个问题，一点近况，或者还没想清楚的念头。</p></div>
  ${chatComposer("new", true)}
  <section class="recent-talks"><div class="section-heading"><h2>接着聊</h2>${link("chat/new", "聊件新的 ＋", "text-button")}</div>
  ${chatSessions().map(t => link(`chat/${t.id}`, `<div><h3>${esc(t.title)}</h3><p>${esc(t.messages.filter(m=>m.role==='user').at(-1)?.text || '还没开始，随时说')}</p></div><span>${icon("right")}</span>`, "recent-talk")).join("")}</section>
  <div class="daily-bottom"><div><h3>慢慢认识自己</h3><p class="muted">理解可以修改，不需要每次聊天都得出结论。</p></div>${link("understand", "看看已有认识 →", "text-button")}</div>
  <p class="small muted">交互原型 · 虚构示例 · 输入仅保留在当前浏览器标签页，不调用模型。</p></section>`
});
function pendingSummary() {
  const c = state.corrections.filter((x) => x.status !== "done").length;
  const t = state.trials.filter((x) => x.status === "active").length;
  const e = (state.savedExplorations || []).filter((x) => x.status === "pending").length;
  return [c ? `${c} 条纠正待核验` : "", e ? `${e} 次探索待核验` : "", t ? `${t} 个尝试在进行` : ""]
    .filter(Boolean)
    .join(" · ");
}
function zeroHome() {
  const savedExplorations = (state.savedExplorations || []).filter(
    (item) => item.status === "pending",
  );
  return {
    title: "首页",
    nav: "home",
    body: `
    <section class="page-title" style="max-width:820px">
      <div class="eyeline">还没有形成认识</div>
      <h1>从一件具体的事开始。</h1>
      <p class="lead">不用先想清楚要问什么，也不用先导入历史记录。挑一件最近的事说说，一次只问一个问题，随时可以停下。</p>
    </section>
    ${entryGrid()}
    <div class="actions">${link("explore/start/free", "我想自己写", "button quiet")}${link("me/sources", "我有历史记录，想先导入", "text-button")}</div>
    ${savedExplorations.length ? `<a class="clarify" href="#pending">${icon("clock")}<div class="copy"><h3>已保存 ${savedExplorations.length} 次探索待核验</h3><p>原输入会保留在待处理页面，不会自动变成认识。</p></div>${icon("right")}</a>` : ""}
    <section class="section">
      <div class="unknown"><h3>说完之后会得到什么</h3><p>一段整理好的经历、一个有范围的观察，以及一个留着的问题。资料不够时只整理经历，不会急着下结论。</p></div>
    </section>`,
  };
}
function entryGrid() {
  const entries = [
    ["sunrise", "一件顺利的事", "推进得比预想顺，或者一下子就做完了"],
    ["target", "一段很投入的时刻", "忘了时间、不想被打断的时候"],
    ["heart", "一个满意的选择", "事后回想，仍然觉得选对了"],
    ["knot", "一件让你卡住的事", "拖着没做，或者做到一半停了"],
  ];
  return `<div class="entry-grid">${entries.map(([ic, t, d], i) => `<a class="entry" href="#explore/start/${i}">${icon(ic)}<strong>${t}</strong><span>${d}</span></a>`).join("")}</div>`;
}

VIEWS.pending = () => {
  const corr = state.corrections.filter((c) => c.status !== "done");
  const trials = state.trials.filter((t) => t.status === "active");
  const explorations = state.savedExplorations || [];
  const statusLabel = {
    saved: tag("已保存 · 未处理", "pending"),
    pending: tag("待核验", "pending"),
    processing: tag("处理中", "current"),
  };
  return {
    title: "待处理与进行中",
    nav: "home",
    body: `
    ${link("home", `${icon("left")}首页`, "back-link")}
    <section class="page-title"><h1>待处理与进行中</h1><p class="lead">这里只是提醒。没有截止时间，放着不会影响阅读。</p></section>
    <section class="section"><div class="section-heading"><h2>你的纠正</h2><span class="small">${corr.length} 条</span></div>
      ${
        corr.length
          ? `<div class="list">${corr.map((c) => link(`receipt/${c.id}`, `${icon("pen", "lead-icon")}<div class="grow"><h3>“${esc(c.text.slice(0, 32))}${c.text.length > 32 ? "…" : ""}”</h3><p>回应：${esc(TOPICS[CLAIMS[c.claim].topic].label)} · ${c.date}</p></div><div class="side">${statusLabel[c.status] || ""}${icon("right", "chev")}</div>`, "row")).join("")}</div>`
          : `<div class="empty">${icon("check")}<h3>没有待核验的纠正</h3><p>在任何一句判断上点“纠正或补充”，保存后会出现在这里。</p></div>`
      }
    </section>
    <section class="section"><div class="section-heading"><h2>已保存的探索</h2><span class="small">${explorations.length} 次</span></div>
      ${explorations.length ? `<div class="list">${explorations.map((item) => `<details class="card compact"><summary><strong>${esc(item.title)}</strong><span class="side">${tag("待核验", "pending")}<span class="small muted">${esc(item.date)}</span></span></summary><div class="section"><small>你写下的经历</small><p>${esc(item.answers.q1 || "没有写")}</p><small>补充回答</small><p>${esc([item.answers.q2, item.answers.q2x, item.answers.q3, item.answers.q3x].filter(Boolean).join("；") || "没有补充")}</p><small>本次有限观察</small><p>${esc(item.observation)}</p><p class="hint">这次探索仍待核验，不会自动成为认识。</p></div></details>`).join("")}</div>` : `<div class="empty"><p>还没有保存的探索。完成后选择“保存这次探索”，记录会留在这里。</p></div>`}
    </section>
    <section class="section"><div class="section-heading"><h2>处理中的任务</h2></div>
      ${
        state.processing
          ? `<div class="list">${link(`receipt/${state.processing}`, `${icon("spark", "lead-icon")}<div class="grow"><h3>复核“工作与投入”的一条纠正</h3><p>最多 3 次调用 · 已确认</p></div><div class="side">${tag("处理中", "current")}</div>`, "row")}</div>`
          : `<div class="empty"><p>没有正在处理的任务。处理只会在你确认用途与次数之后开始。</p></div>`
      }
    </section>
    <section class="section"><div class="section-heading"><h2>进行中的尝试</h2>${link("explore/trials", "全部尝试", "text-button")}</div>
      ${
        trials.length
          ? `<div class="list">${trials.map((t) => link(`explore/trial/${t.id}`, `${icon("flag", "lead-icon")}<div class="grow"><h3>${esc(t.title)}</h3><p>开始于 ${t.started} · 计划 ${t.review} 回顾</p></div><div class="side">${tag("可以回顾了")}${icon("right", "chev")}</div>`, "row")).join("")}</div>`
          : `<div class="empty"><p>没有进行中的尝试。</p></div>`
      }
    </section>`,
  };
};

VIEWS.understand = (r) => {
  if (r.a === "topics") return topicsList();
  if (r.a === "framework") return frameworkReport();
  if (r.a === "changes") return changes();
  if (!state.hasData) return emptyUnderstanding();
  return {
    title: "整体认识",
    nav: "understand",
    body: `${subtabs("understand")}
    <div class="reading-layout">
      <article class="reading">
        <div class="meta"><span>整体认识</span>${tag(`版本 ${version("overall")}`, "current")}<span>阶段性理解，可以继续修订</span></div>
        <h1>投入需要空间，也需要清晰的边界。</h1>
        <p class="intro">这份整体认识来自 3 个已审核专题和 1 次探索。它说明的是现阶段、在这些材料范围内的理解，不是对你的定论。</p>
        <section class="reading-section"><h2>当前状态</h2><p>在工作里，你有一套能让自己持续推进的条件：目标清楚、可以自己安排顺序。${state.revised ? "协作中的迟疑主要出现在职责不清的时候；分工明确后，你会主动承担。" : "协作中出现过迟疑，但当时的分工是否清楚，还需要你补充背景。"}</p></section>
        <section class="reading-section"><h2>重要的取舍</h2><p>在一次邀请里，你把可支配的时间放在外部认可之前，事后仍然满意。这只是一件事，还不能说明你一贯这样排序。</p><p class="aside">来自“选择与取舍”专题，范围很窄。</p></section>
        <section class="reading-section"><h2>优势与有利条件</h2><p>目标明确时，你能自己理清顺序并推进到底。这依赖条件，而不是一种在任何环境都成立的能力。</p></section>
        <section class="reading-section"><h2>可能的限制与相互影响</h2><p>“工作与投入”和“关系与表达”共用同一段协作记录。它们相连，是因为引用了同一次经历，不代表两份独立证据，也不代表一方导致另一方。</p>
          <details class="relation"><summary><div><span>这些专题，为什么放在一起？</span><small>展开查看共同情境；关系图不是阅读前提</small></div>${icon("down")}</summary>
            <div class="relation-body"><div class="connection"><div class="event">同一段记录：职责不清的协作讨论</div><a href="#topic/work">工作与投入</a><a href="#topic/relation">关系与表达</a><div class="none">精力与节奏：没有共同情境，不画连线</div></div>
            <div><h3>一个情境，两个观察角度。</h3><p class="muted" style="font-size:15px;margin-top:8px">连线只表示引用了同一段经历。系统不会因为两条线连在一起，就推断出因果关系。</p></div></div>
          </details>
        </section>
        ${claimCard("J1", { showTopic: true })}
        <div class="unknown"><h3>仍然未知</h3><p>高频沟通下的投入、投入之后的恢复成本、工作以外的关系与表达。现有材料没有覆盖这些方面，这不代表它们是问题。</p><div class="actions" style="margin-top:12px">${link("explore/start", "从一件经历补充", "text-button accent")}</div></div>
      </article>
      <aside class="margin-notes" aria-label="边注">
        <section><h3>理解的范围</h3><p>2024年3月—2026年9月的对话记录中，已审核的 3 个专题，加上 1 次探索。</p></section>
        <section><h3>依据</h3><p>4 段记录${state.revised ? "、1 条你的补充" : ""}。同一段记录在多个专题出现时只算一次。</p></section>
        <section><h3>最近变化</h3><p>${state.revised ? "10月27日，一条判断因你的补充收窄了范围。" : "10月12日建立基线，之后没有修订。"}</p>${link("understand/changes", "查看变化记录", "text-button")}</section>
        <section><h3>你可以不同意</h3><p>指出事实、背景或解释的问题。新的补充需要核验，认可也不会自动变成证据。</p></section>
      </aside>
    </div>`,
  };
};
function emptyUnderstanding() {
  return {
    title: "当前认识",
    nav: "understand",
    body: `${subtabs("understand")}<div class="empty">${icon("understand")}<h3>还没有形成认识</h3><p>完成一次探索或导入历史记录后，这里会出现有依据、可修订的整体认识。资料不够时不会拼出一份假总览。</p><div class="actions">${link("explore/start", "从一件经历开始", "button primary")}${link("me/sources", "导入历史记录", "text-button")}</div></div>`,
  };
}
function topicsList() {
  return {
    title: "专题",
    nav: "understand",
    body: `${subtabs("understand/topics")}
    <section class="page-title"><h1>专题</h1><p class="lead">每个专题只讨论一个方面，各自保留依据与范围。来源不同的专题放在一起，标注来自哪里。</p></section>
    ${state.hasData ? `<div class="grid-2">${Object.keys(TOPICS).map(topicCard).join("")}</div>` : `<div class="empty"><h3>还没有专题</h3><p>从一件经历开始，或导入历史记录。</p></div>`}`,
  };
}

VIEWS.topic = (r) => {
  const key = TOPICS[r.a] ? r.a : "work";
  const t = TOPICS[key];
  const others = `<nav class="next-topics" aria-label="其他专题"><h2>其他专题</h2><div class="list" style="border-top:0">${Object.entries(
    TOPICS,
  )
    .filter(([k]) => k !== key)
    .map(([k, x]) =>
      link(
        `topic/${k}`,
        `<div class="grow"><h3>${x.label}</h3><p>${x.card}</p></div>${icon("right", "chev")}`,
        "row",
      ),
    )
    .join("")}</div></nav>`;
  return {
    title: t.label,
    nav: "understand",
    body: `${subtabs("understand/topics")}
    <div class="reading-layout">
      <article class="reading">
        <div class="meta"><span>${t.label}</span>${tag(`版本 ${version(key)}`, version(key) > 1 ? "current" : "")}<span>${t.origin}</span></div>
        <h1>${t.title}</h1>
        <p class="intro">${t.intro}</p>
        <section class="reading-section"><h2>目前看到什么</h2><p>${t.body}</p></section>
        <section class="reading-section"><h2>还可能怎样解释</h2><p>${t.alternative}</p></section>
        ${t.claims.map((id) => claimCard(id)).join("")}
        <div class="unknown"><h3>${key === "energy" ? "这里先保持空白" : "还缺什么"}</h3><p>${t.unknown}</p><div class="actions" style="margin-top:12px">${link(key === "energy" ? "explore/start" : `explore/continue/${t.claims[0]}`, key === "energy" ? "从一件经历补充" : "带着这个问题继续理解", "text-button accent")}</div></div>
        ${others}
      </article>
      <aside class="margin-notes" aria-label="边注">
        <section><h3>理解的范围</h3><p>${t.scope}</p></section>
        <section><h3>来自哪里</h3><p>${t.origin}${key === "work" && state.revised ? "；另有 1 条你的补充。" : "。"}</p></section>
        ${version(key) > 1 ? `<section><h3>版本</h3><p>当前为版本 2。版本 1 只供回看。</p>${link(`version/${key}`, "回看版本 1", "text-button")}</section>` : ""}
        <section><h3>你可以不同意</h3><p>每一句判断都可以纠正。补充的背景会先保存，处理前会征求你的确认。</p></section>
      </aside>
    </div>`,
  };
};

VIEWS.version = (r) => {
  const key = TOPICS[r.a] ? r.a : "work";
  const t = TOPICS[key];
  return {
    title: `${t.label} · 历史版本`,
    nav: "understand",
    body: `${link("understand/changes", `${icon("left")}变化记录`, "back-link")}
    <div class="banner">${icon("history")}<div class="copy"><h3>这是版本 1，只供回看</h3><p>它使用当时的依据，不混入之后的补充。当前内容以版本 ${version(key)} 为准。</p><div class="actions">${link(`topic/${key}`, "阅读当前版本", "button small primary")}</div></div></div>
    <article class="reading" style="max-width:760px">
      <div class="meta"><span>${t.label}</span>${tag("版本 1 · 只读")}<span>2026年10月12日</span></div>
      <h1>${t.title}</h1><p class="intro">${t.intro}</p>
      ${t.claims.map((id) => claimCard(id, { old: true })).join("")}
    </article>`,
  };
};

function changes() {
  const pend = state.corrections.filter((c) => c.status !== "done");
  const done = state.corrections.find((c) => c.status === "done");
  return {
    title: "变化记录",
    nav: "understand",
    body: `${subtabs("understand/changes")}
    <section class="page-title"><h1>变化记录</h1><p class="lead">哪些判断保持、收窄、撤回，以及为什么。旧版本只读；文字变了不等于你这个人变了。</p></section>
    <div class="timeline">
      ${pend.map((c) => `<div class="tl-item pending"><div class="meta" style="margin:0"><span>${c.date}</span>${tag("待核验", "pending")}</div><div class="card compact"><h3>你对“${esc(TOPICS[CLAIMS[c.claim].topic].label)}”的补充</h3><p>已保存，尚未处理。处理之前，当前判断保持不变。</p><div class="actions" style="margin-top:12px">${link(`receipt/${c.id}`, "查看与处理", "text-button accent")}</div></div></div>`).join("")}
      ${state.revised ? `<div class="tl-item current"><div class="meta" style="margin:0"><span>10月27日</span>${tag("收窄", "current")}<span>工作与投入 · 版本 1 → 2</span></div><div class="card compact"><h3>“${CLAIM_OLD}”→“${CLAIM_NEW}”</h3><p>原因：你补充了分工明确后主动承担的经历，构成反例。整体认识随之更新；其他专题不变。</p><div class="actions" style="margin-top:12px">${link(done ? `revision/${done.id}` : "revision/demo", "查看前后对比", "text-button accent")}${link("version/work", "回看版本 1", "text-button")}</div></div></div>` : ""}
      <div class="tl-item"><div class="meta" style="margin:0"><span>10月12日</span>${tag("撤回")}<span>来源被排除</span></div><div class="card compact"><h3>“你偏好独自工作”不再作为当前认识</h3><p>这条判断只来自旧版测验结果。你在来源管理里排除了这批材料，它不再被使用；旧内容仍可回看。</p></div></div>
      <div class="tl-item"><div class="meta" style="margin:0"><span>10月12日</span>${tag("保持")}<span>导入已审核专题</span></div><div class="card compact"><h3>建立基线：工作与投入、关系与表达、精力与节奏</h3><p>“精力与节奏”没有足够材料，保持未知，没有填一个低分。</p></div></div>
      <div class="tl-item"><div class="meta" style="margin:0"><span>9月30日</span>${tag("新建")}<span>来自探索</span></div><div class="card compact"><h3>选择与取舍</h3><p>由一次探索形成，只基于一件事，范围很窄。</p></div></div>
    </div>`,
  };
}

function frameworkReport() {
  const answered = Object.keys(state.framework.answers).length;
  const doms = [
    ["心智", 3, 3, "框架内：在整合", "能把学到的方法用到具体工作里。"],
    ["身体", 0, 3, null, "你跳过了这部分，没有填等级。"],
    ["精神", 2, 3, "框架内：在探索", "有持续做的事，但很少说明为什么。"],
    ["职业", 3, 3, "框架内：在整合", "主动选择的部分正在变多。"],
  ];
  return {
    title: "框架报告",
    nav: "understand",
    body: `${subtabs("understand/framework")}
    <div class="banner pending">${icon("alert")}<div class="copy"><h3>这是草稿定义下的试运行</h3><p>HUMAN 3.0 的中文适配还没有完成来源核对。结果只代表“按这个框架怎么看”，不会写进你的当前认识。</p></div></div>
    <section class="page-title"><div class="meta"><span>HUMAN 3.0</span>${tag("定义：草稿")}<span>直接访谈 · 已完成 3 / 4 个领域</span></div><h1>按一个框架看自己</h1><p class="lead">框架有自己的维度和等级。资料不够的领域标为缺少输入，不会被当作等级低。</p></section>
    <div class="framework-domains">${doms.map(([n, a, m, level, d]) => `<section class="domain ${level ? "" : "missing"}"><h3>${n}</h3><div class="level">${level || "缺少输入"}</div><p>${d}</p><div class="meter" aria-label="已作答 ${a} / ${m}">${Array.from({ length: m }, (_, i) => `<i class="${i < a ? "on" : ""}"></i>`).join("")}</div></section>`).join("")}</div>
    <section class="section"><div class="section-heading"><h2>跨领域综合</h2></div><div class="unknown" style="margin:0"><h3>暂不生成</h3><p>身体领域缺少输入，跨领域关系需要四个领域都有作答。补上之后可以重新分析，分析前会确认用途与次数。</p><div class="actions" style="margin-top:12px">${link("explore/framework", answered ? "继续访谈" : "补答身体领域", "text-button accent")}</div></div></section>
    <section class="section"><div class="section-heading"><h2>框架给出的发展建议</h2><span class="small">由你决定是否尝试</span></div>
      <div class="grid-2">
        <div class="card compact"><h3>每周留一段不安排任务的时间</h3><p>对应“精神”领域。依据：你在精神领域的作答。</p><div class="foot"><button type="button" class="text-button accent" data-action="add-candidate">加入尝试候选</button></div></div>
        <div class="card compact"><h3>把一个新方法用在下一个项目上</h3><p>对应“心智”领域。依据：你在心智领域的作答。</p><div class="foot"><button type="button" class="text-button accent" data-action="add-candidate">加入尝试候选</button></div></div>
      </div>
    </section>`,
  };
}
ACTIONS["add-candidate"] = (el) => {
  el.outerHTML = `<span class="small muted">${icon("check")} 已加入候选，不会自动开始</span>`;
  toast("已加入尝试候选，开始前还会问你");
};

/* 纠正或补充 */
const KINDS = [
  ["inaccurate", "这不准确", "事实或归属有误"],
  ["scope", "仅某情境成立", "范围说得太宽"],
  ["changed", "以前如此，现在变了", "有新的情况"],
  ["continue", "继续理解", "还不确定，想多聊聊"],
];
VIEWS.correct = (r) => {
  const id = CLAIMS[r.a] ? r.a : "J1";
  const c = CLAIMS[id];
  const draft = state.drafts[id] || { kind: "scope", text: "" };
  return {
    title: "纠正或补充",
    nav: "understand",
    body: `${link(`topic/${c.topic}`, `${icon("left")}返回${TOPICS[c.topic].label}`, "back-link")}
    <div class="form-layout">
      <form class="correct-form" data-claim="${id}" novalidate>
        <div class="eyeline">纠正与补充</div>
        <h1 style="font-size:clamp(30px,3.4vw,44px)">让这句话，更贴近当时的你。</h1>
        <p class="lead" style="font-size:17px;margin:14px 0 28px">可以纠正事实，也可以补上当时的背景。不需要先认同这份理解。</p>
        <div class="target"><small>正在回应 · ${TOPICS[c.topic].label} · 版本 ${version(c.topic)}</small><blockquote>${esc(claimText(id))}</blockquote></div>
        <fieldset><legend>哪里需要重新理解？</legend><div class="choices">${KINDS.map(([v, l, s]) => `<label class="choice"><input type="radio" name="kind" value="${v}" ${draft.kind === v ? "checked" : ""}><span>${l}<small>${s}</small></span></label>`).join("")}</div></fieldset>
        <div class="field" id="text-field"><div class="label-row"><label class="label" for="correct-text">你知道的情况</label><button type="button" class="text-button accent small" data-action="fill-example">填入虚构示例</button></div>
          <textarea id="correct-text" name="text" placeholder="比如：当时发生了什么、谁负责什么、后来有什么不同" aria-describedby="text-error">${esc(draft.text)}</textarea>
          <p class="error" id="text-error" aria-live="polite"></p></div>
        <div class="form-footer"><button type="button" class="button quiet" data-action="keep-draft">返回阅读，保留草稿</button><button type="button" class="button primary" data-action="submit-correction">${draft.kind === "continue" ? "带着这句话去继续理解" : "保存，等待核验"}</button></div>
      </form>
      <aside class="aside-box"><section><h3>保存之后会怎样</h3><p>先可靠地保存你的原话。处理需要调用模型，会单独征求你的确认。处理完成后，你会看到哪些改变、哪些保持，以及原因。</p></section><section><h3>不会发生什么</h3><p>不会因为你不同意就翻转判断，也不会把“有帮助”当作证据。</p></section></aside>
    </div>`,
    after() {
      const form = $(".correct-form");
      form.addEventListener("input", () => {
        state.drafts[id] = { kind: form.kind.value, text: form.text.value };
        save();
        $("#text-field").classList.remove("invalid");
        $("#text-error").textContent = "";
        $('[data-action="submit-correction"]').textContent =
          form.kind.value === "continue" ? "带着这句话去继续理解" : "保存，等待核验";
      });
    },
  };
};
ACTIONS["fill-example"] = () => {
  const t = $("#correct-text");
  t.value = EXAMPLE_CORRECTION;
  t.dispatchEvent(new Event("input", { bubbles: true }));
  t.focus();
};
ACTIONS["keep-draft"] = () => {
  const id = $(".correct-form").dataset.claim;
  toast("草稿已保留，下次打开还在");
  go(`topic/${CLAIMS[id].topic}`);
};
ACTIONS["submit-correction"] = () => {
  const form = $(".correct-form");
  const id = form.dataset.claim;
  if (form.kind.value === "continue") {
    go(`explore/continue/${id}`);
    return;
  }
  const text = form.text.value.trim();
  if (!text) {
    $("#text-field").classList.add("invalid");
    $("#text-error").textContent = "请先写下你知道的情况。";
    form.text.focus();
    return;
  }
  const corr = {
    id: `c${Date.now()}`,
    claim: id,
    kind: form.kind.value,
    text,
    status: "saved",
    version: version(CLAIMS[id].topic),
    date: "10月27日",
  };
  state.corrections.unshift(corr);
  delete state.drafts[id];
  save();
  go(`receipt/${corr.id}`);
};

VIEWS.receipt = (r) => {
  const c = state.corrections.find((x) => x.id === r.a) || state.corrections[0];
  if (!c)
    return {
      title: "保存回执",
      nav: "understand",
      body: `<div class="empty"><h3>没有找到这条纠正</h3><p>它可能已经处理完成。</p>${link("understand/changes", "查看变化记录", "text-button")}</div>`,
    };
  const claim = CLAIMS[c.claim];
  const kind = KINDS.find((k) => k[0] === c.kind)?.[1];
  const states = {
    saved: `<div class="banner ok">${icon("check")}<div class="copy"><h3>已保存，等待核验</h3><p>你的原话已经保存，刷新或换设备都能看到。当前判断在处理之前保持不变。</p></div></div>`,
    pending: `<div class="banner pending">${icon("clock")}<div class="copy"><h3>待核验</h3><p>${esc(c.note || "这条纠正还没有处理。")}</p></div></div>`,
    processing: `<div class="banner ok">${icon("spark")}<div class="copy"><h3>正在处理</h3><p>归属核对 → 生成修订 → 独立审核。完成后会自动打开前后对比。</p><div class="skeleton" style="margin-top:12px"><i class="s"></i></div></div></div>`,
    done: `<div class="banner ok">${icon("check")}<div class="copy"><h3>修订已完成</h3><p>受影响的判断已经更新，旧版本保留。</p><div class="actions">${link(`revision/${c.id}`, "查看前后对比", "button small primary")}</div></div></div>`,
  };
  return {
    title: "保存回执",
    nav: "understand",
    body: `${link("pending", `${icon("left")}待处理与进行中`, "back-link")}
    <div style="max-width:760px">
      ${states[c.status]}
      <div class="target"><small>你的原话 · ${kind} · ${c.date}</small><blockquote style="font-size:18px;white-space:pre-wrap;overflow-wrap:anywhere">${esc(c.text)}</blockquote></div>
      <dl class="cost-table"><dt>回应的判断</dt><dd>${esc(claim.text)}</dd><dt>所在专题</dt><dd>${TOPICS[claim.topic].label} · 版本 ${c.version}</dd><dt>状态</dt><dd>${{ saved: "已保存，未处理", pending: "待核验", processing: "处理中", done: "已完成" }[c.status]}</dd></dl>
      ${c.status === "saved" ? `<div class="actions"><button type="button" class="button primary" data-action="open-processing" data-id="${c.id}">处理这条纠正</button>${link(`topic/${claim.topic}`, "先放着，回到阅读", "text-button")}</div><p class="hint">处理前会说明用途、服务方和最多调用次数。</p>` : ""}
      ${c.status === "pending" ? `<div class="actions">${link(`topic/${claim.topic}`, "回到阅读", "button quiet")}</div>` : ""}
    </div>`,
  };
};

VIEWS.revision = (r) => {
  const c = state.corrections.find((x) => x.id === r.a);
  return {
    title: "修订前后",
    nav: "understand",
    body: `${link("understand/changes", `${icon("left")}变化记录`, "back-link")}
    <div style="max-width:900px">
      <div class="meta">${tag("修订已完成", "current")}<span>工作与投入 · 版本 1 → 版本 2 · 10月27日</span></div>
      <h1 style="font-size:clamp(30px,3.6vw,46px)">把笼统的判断，<br>放回具体的情境。</h1>
      <p class="lead" style="font-size:17px">新的补充没有为你贴上另一种标签，而是让原来那句话的范围更准确。</p>
      <div class="diff"><section><small>修订前 · 版本 1</small><p><del>${CLAIM_OLD}</del></p>${link("version/work", "回看旧版本", "text-button")}</section><section class="new"><small>修订后 · 当前版本 2</small><p>${CLAIM_NEW}</p>${link("topic/work", "阅读当前版本", "text-button accent")}</section></div>
      <section class="section"><h2 style="font-size:22px;margin-bottom:10px">为什么这样改</h2><p>你补充了分工明确后主动接下任务的经历。它和“协作时倾向于退后”相矛盾，因此撤去泛指所有协作的范围，保留职责不清时暂缓表达的具体情境。${c ? "" : ""}</p>
        <div class="actions" style="margin-top:10px"><button type="button" class="text-button" data-action="evidence" data-claim="J1">核对这次使用的原话</button></div></section>
      <ul class="change-list"><li><h3>改变了</h3><p>判断的适用范围：从所有协作收窄到职责不清的时候。</p></li><li><h3>保持不变</h3><p>“目标明确时更容易投入”；“精力与节奏”仍然未知。</p></li><li><h3>一并更新</h3><p>整体认识中关于协作的一句话。其他专题没有改动。</p></li></ul>
      <div class="unknown"><h3>还可以继续修订</h3><p>这次范围更具体，不代表解释已经最终确定。</p></div>
    </div>`,
  };
};
