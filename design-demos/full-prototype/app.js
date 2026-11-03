/* 原型核心：状态、路由、外壳、弹层与原型面板。页面视图在 views-*.js 中注册到 VIEWS。 */
const ICONS = {
  home: '<path d="M4 10 12 4l8 6v10H4Z"/><path d="M9 20v-7h6v7"/>',
  understand:
    '<path d="M4 5.5C6.5 4.5 9.5 4.5 12 6c2.5-1.5 5.5-1.5 8-.5V19c-2.5-1-5.5-1-8 .5-2.5-1.5-5.5-1.5-8-.5Z"/><path d="M12 6v13.5"/>',
  explore: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  scope: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/><circle cx="12" cy="12" r="2"/>',
  question:
    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.8-2.5 2-2.5 3.8M12 16.5v.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 4 3 20h18Z"/><path d="M12 10v4M12 17v.5"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 16v4h16v-4"/>',
  file: '<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v4h4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2 6M20 5v6h-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/>',
  archive: '<path d="M4 5h16v4H4ZM6 9v10h12V9M10 13h4"/>',
  history: '<path d="M4 11a8 8 0 1 1 2 7M4 5v6h6"/><path d="M12 7v5l3 2"/>',
  layers: '<path d="m12 4 8 4-8 4-8-4Z"/><path d="m4 12 8 4 8-4M4 16l8 4 8-4"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3Z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  shield: '<path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  logout: '<path d="M10 4H4v16h6M15 8l4 4-4 4M19 12H9"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.5M4 12h.5M4 18h.5"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="3"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  sunrise: '<path d="M4 18h16M7 18a5 5 0 0 1 10 0M12 6v4M5 11l1.5 1.5M19 11l-1.5 1.5"/>',
  heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z"/>',
  knot: '<path d="M7 7c3 0 7 10 10 10M7 17c3 0 7-10 10-10"/>',
  pen: '<path d="M4 20l4-1 11-11-3-3L5 16Z"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
};
const MARK =
  '<svg viewBox="0 0 40 40" aria-hidden="true"><ellipse cx="20" cy="15" rx="10" ry="12"/><ellipse cx="15" cy="24" rx="10" ry="12" transform="rotate(-50 15 24)"/><ellipse cx="25" cy="24" rx="10" ry="12" transform="rotate(50 25 24)"/></svg>';
const icon = (name, cls = "") =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.dot}</svg>`;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const link = (route, html, cls = "", extra = "") =>
  `<a href="#${route}" class="${cls}" ${extra}>${html}</a>`;
const tag = (text, cls = "") => `<span class="tag ${cls}">${text}</span>`;
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const DEFAULT_STATE = () => ({
  loggedIn: true,
  hasData: true,
  theme: "system",
  profile: "p1",
  revised: false,
  corrections: [],
  savedExplorations: [],
  processing: null,
  drafts: {},
  explore: { step: 0, entry: null, answers: {} },
  support: { step: 0, chips: [], picked: null, plan: {} },
  framework: { index: 0, answers: {}, paused: false, done: false },
  trials: [
    {
      id: "t1",
      title: "开始前，先写下第一步",
      status: "active",
      started: "10月20日",
      review: "10月27日",
      topic: "work",
    },
  ],
  excluded: { d4: true },
  imported: false,
  archivedProfiles: { p3: true },
});
let state = DEFAULT_STATE();
try {
  const saved = JSON.parse(sessionStorage.getItem("findme-prototype") || "null");
  if (saved) state = Object.assign(DEFAULT_STATE(), saved);
} catch (e) {
  /* 存储不可用时使用默认状态 */
}
try {
  const theme = localStorage.getItem("findme-prototype-theme");
  if (theme) state.theme = theme;
} catch (e) {
  /* 忽略 */
}
function save() {
  try {
    sessionStorage.setItem("findme-prototype", JSON.stringify(state));
  } catch (e) {
    /* 忽略 */
  }
  try {
    localStorage.setItem("findme-prototype-theme", state.theme);
  } catch (e) {
    /* 忽略 */
  }
}
function applyTheme() {
  if (state.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
}

const VIEWS = {};
const ACTIONS = {};
function parseRoute() {
  const raw = decodeURIComponent(location.hash.slice(1)) || "home";
  const parts = raw.split("/");
  return { raw, name: parts[0], a: parts[1], b: parts[2] };
}
function go(route) {
  if (location.hash.slice(1) === route) render();
  else location.hash = route;
}

const NAV = [
  ["home", "首页", "home"],
  ["understand", "当前认识", "understand"],
  ["explore", "探索", "explore"],
];
function primaryNav(active) {
  return `<nav class="primary-nav" aria-label="主导航">${NAV.map(([key, label, ic]) => `<a href="#${key}" class="${active === key ? "active" : ""}" ${active === key ? 'aria-current="page"' : ""}>${icon(ic)}<span>${label}</span></a>`).join("")}</nav>`;
}
function pendingCount() {
  return (
    state.corrections.filter((c) => c.status !== "done").length +
    state.trials.filter((t) => t.status === "active").length +
    (state.savedExplorations || []).filter((item) => item.status === "pending").length
  );
}
function currentProfile() {
  return PROFILES.find((p) => p.id === state.profile) || PROFILES[0];
}
function accountMenu() {
  const p = currentProfile();
  const n = pendingCount();
  return `<div class="menu" id="account-menu" hidden role="menu">
    <div class="menu-profile"><small>当前资料</small><strong>${esc(p.name)}</strong></div>
    ${link("pending", `${icon("clock")}待处理与进行中${n ? `<span class="badge">${n}</span>` : ""}`, "", 'role="menuitem"')}
    ${link("me/profiles", `${icon("layers")}切换与管理资料`, "", 'role="menuitem"')}
    ${link("me/sources", `${icon("list")}来源与导入`, "", 'role="menuitem"')}
    ${link("me/files", `${icon("file")}托管原档`, "", 'role="menuitem"')}
    ${link("me/jobs", `${icon("spark")}处理记录与额度`, "", 'role="menuitem"')}
    ${link("me/export", `${icon("download")}导出`, "", 'role="menuitem"')}
    <hr>
    ${link("me/account", `${icon("user")}账号与显示`, "", 'role="menuitem"')}
    <button type="button" data-action="logout" role="menuitem">${icon("logout")}退出登录</button>
  </div>`;
}
function shell(view, route) {
  const n = pendingCount();
  return `<a class="sr-only" href="#main">跳到正文</a>
  <header class="header"><div class="header-inner">
    ${link("home", `${MARK}<span>找我</span><em>FindMe</em>`, "brand", 'aria-label="FindMe 首页"')}
    ${primaryNav(view.nav)}
    <div class="header-tools">
      <button type="button" class="avatar-button" data-action="toggle-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="account-menu" aria-label="我的${n ? `，${n} 项待处理` : ""}">
        <span class="avatar">我</span><span class="name">我的</span>${n ? '<span class="dot" aria-hidden="true"></span>' : ""}
      </button>
    </div>
  </div>${accountMenu()}</header>
  <main id="main" tabindex="-1" class="enter">${view.body}</main>
  <footer class="footer"><span>找我 FindMe · 一份可以修订的自我认识</span><span>高保真原型 · 全部为虚构示例 · 未连接真实数据</span></footer>
  <div class="bottom-nav">${primaryNav(view.nav)}</div>`;
}

let lastRoute = "";
function render() {
  const route = parseRoute();
  closeMenu();
  if (!state.loggedIn && !["login", "forgot"].includes(route.name)) {
    location.replace("#login");
    return;
  }
  const fn = VIEWS[route.name] || VIEWS.home;
  const view = fn(route);
  document.title = `${view.title || "找我"} · FindMe 原型`;
  $("#app").innerHTML = view.bare
    ? `<main id="main" tabindex="-1" class="enter">${view.body}</main>`
    : shell(view, route);
  if (route.raw !== lastRoute) {
    window.scrollTo(0, 0);
    $("#main")?.focus({ preventScroll: true });
  }
  lastRoute = route.raw;
  view.after?.();
  renderProto();
}

/* 账号菜单 */
function closeMenu() {
  const m = $("#account-menu");
  if (m && !m.hidden) {
    m.hidden = true;
    $('[data-action="toggle-menu"]')?.setAttribute("aria-expanded", "false");
  }
}
ACTIONS["toggle-menu"] = (el) => {
  const m = $("#account-menu");
  m.hidden = !m.hidden;
  el.setAttribute("aria-expanded", String(!m.hidden));
  if (!m.hidden) m.querySelector("a,button")?.focus();
};
ACTIONS.logout = () => {
  state.loggedIn = false;
  save();
  go("login");
};

/* 弹层：抽屉与对话框 */
let lastFocus = null;
function openDialog(id, html) {
  const d = $(id);
  lastFocus = document.activeElement;
  d.innerHTML = html;
  d.showModal();
  (d.querySelector("[autofocus]") || d.querySelector("h2"))?.focus();
}
function closeDialog(id) {
  const d = $(id);
  if (d.open) d.close();
}
for (const id of ["#drawer", "#modal"]) {
  const d = $(id);
  d.addEventListener("close", () => {
    lastFocus?.focus?.();
  });
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  });
}
ACTIONS["close-dialog"] = (el) => el.closest("dialog").close();
function dialogHead(title, label) {
  return `<div class="dialog-head"><h2 tabindex="-1">${title}</h2><button type="button" class="close" data-action="close-dialog" aria-label="${label || "关闭"}">${icon("close")}</button></div>`;
}
function confirmModal({
  title,
  body,
  confirm,
  cancel = "取消",
  action,
  danger = false,
  data = "",
}) {
  openDialog(
    "#modal",
    `${dialogHead(title)}<div class="dialog-body">${body}<div class="actions"><button type="button" class="button quiet" data-action="close-dialog">${cancel}</button><button type="button" class="button ${danger ? "danger solid" : "primary"}" data-action="${action}" ${data}>${confirm}</button></div></div>`,
  );
}

let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 2800);
}

/* 依据抽屉：当前版本使用当前依据，历史版本只用当时的依据 */
function openEvidence(claimId, old = false) {
  const c = CLAIMS[claimId];
  const revised = state.revised && c.revisedSources && !old;
  const ids = revised ? c.revisedSources : c.sources;
  const text = revised ? c.revisedText : c.text;
  openDialog(
    "#drawer",
    `${dialogHead("依据与反例", "关闭依据面板")}<div class="dialog-body">
    <div class="meta" style="margin-bottom:12px">${tag(old ? "历史版本 · 只读" : "当前版本", old ? "" : "current")}${tag("虚构示例")}</div>
    <p style="font-size:18px;color:var(--ink)">“${esc(text)}”</p>
    <p class="hint">原话只说明当时有过这样的表达，不能单独证明一个稳定特征。同一来源出现在多个专题时，不重复计算。</p>
    ${ids
      .map((id) => {
        const s = SOURCES[id];
        return `<section class="source"><div class="meta" style="margin:0">${tag(s.role, id === "S3" ? "current" : "")}<span>${esc(s.name)} · ${s.date}</span></div><blockquote>“${esc(s.quote)}”</blockquote><p class="effect">${esc(s.effect)}</p><p>适用范围：${esc(s.scope)}</p></section>`;
      })
      .join("")}
    ${old ? "" : `<div class="actions"><a class="button primary" href="#correct/${claimId}" data-action="close-and-go">原话或理解有误，我来补充</a><button type="button" class="button quiet" data-action="close-dialog">返回阅读</button></div>`}
  </div>`,
  );
}
ACTIONS.evidence = (el) => openEvidence(el.dataset.claim, el.dataset.old === "1");
ACTIONS["close-and-go"] = (el, e) => {
  e.preventDefault();
  closeDialog("#drawer");
  closeDialog("#modal");
  go(el.getAttribute("href").slice(1));
};

/* 处理确认（页面 26）：任何会调用模型的处理先说明用途、服务方与上限 */
function openProcessing(corrId) {
  const c = state.corrections.find((x) => x.id === corrId);
  const claim = CLAIMS[c.claim];
  openDialog(
    "#modal",
    `${dialogHead("处理这条纠正前，请确认")}<div class="dialog-body">
    <p>处理会调用模型，复核这条纠正并生成新版本。生成的结果要经过独立审核，才会替换当前内容。</p>
    <dl class="cost-table" style="margin-top:18px">
      <dt>用途</dt><dd>复核“${esc(TOPICS[claim.topic].label)}”中的一条判断，并检查相关的整体认识</dd>
      <dt>服务方</dt><dd>DeepSeek（经 FindMe 统一出口）</dd>
      <dt>最多调用</dt><dd>3 次：生成 1 次、审核 1 次、失败重试 1 次</dd>
      <dt>本月剩余</dt><dd>12 次</dd>
    </dl>
    <p class="hint">失败不会自动重试，你的原话会一直保留。读取和保存不会调用模型。</p>
    <div class="actions"><button type="button" class="button quiet" data-action="close-dialog">暂不处理</button><button type="button" class="button primary" data-action="confirm-processing" data-id="${corrId}" autofocus>确认处理</button></div>
  </div>`,
  );
}
ACTIONS["open-processing"] = (el) => openProcessing(el.dataset.id);
ACTIONS["confirm-processing"] = (el) => {
  const c = state.corrections.find((x) => x.id === el.dataset.id);
  closeDialog("#modal");
  if (c.text.trim() !== EXAMPLE_CORRECTION) {
    c.status = "pending";
    c.note = "原型不运行真实处理。自己写的内容保持“待核验”，不会假装已经理解。";
    save();
    render();
    toast("原型中自行输入的内容不会被处理，保持待核验");
    return;
  }
  c.status = "processing";
  state.processing = c.id;
  save();
  go(`receipt/${c.id}`);
  setTimeout(() => {
    c.status = "done";
    state.revised = true;
    state.processing = null;
    save();
    if (parseRoute().raw === `receipt/${c.id}`) go(`revision/${c.id}`);
    else toast("修订已完成，可以在变化记录里查看");
  }, 2600);
};

/* 原型面板：主题、数据状态、页面索引、重置 */
const PAGE_INDEX = [
  [
    "进入",
    [
      ["1", "登录", "login"],
      ["2", "找回密码", "forgot"],
      ["3", "选择资料", "pick-profile"],
    ],
  ],
  [
    "首页",
    [
      ["4", "我的当前理解", "home"],
      ["5", "零资料起步", "home?empty"],
      ["6", "待处理与进行中", "pending"],
    ],
  ],
  [
    "当前认识",
    [
      ["7", "整体认识", "understand"],
      ["8", "专题列表", "understand/topics"],
      ["9", "专题详情", "topic/work"],
      ["10", "框架报告", "understand/framework"],
      ["11", "变化记录", "understand/changes"],
      ["12", "历史版本", "version/work"],
    ],
  ],
  [
    "探索",
    [
      ["13", "从一件经历开始", "explore/start"],
      ["14", "继续理解某判断", "explore/continue/J1"],
      ["15", "借一本书看", "explore/book"],
      ["16", "框架访谈", "explore/framework"],
      ["17", "具体困难与可选调整", "explore/support"],
      ["18", "我的尝试", "explore/trials"],
    ],
  ],
  [
    "我的",
    [
      ["19", "切换与管理资料", "me/profiles"],
      ["20", "来源与导入", "me/sources"],
      ["21", "托管原档", "me/files"],
      ["22", "处理记录与额度", "me/jobs"],
      ["23", "导出", "me/export"],
      ["24", "清除资料", "me/delete"],
      ["25", "账号与显示", "me/account"],
    ],
  ],
  [
    "通用层",
    [
      ["·", "依据与反例", "topic/work?evidence"],
      ["·", "纠正或补充", "correct/J1"],
      ["26", "保存回执与处理确认", "receipt?demo"],
      ["·", "修订前后对比", "revision?demo"],
      ["·", "通用状态", "states"],
    ],
  ],
];
function renderProto() {
  const panel = $("#proto-panel");
  const seg = (key, opts) =>
    `<div class="segmented" role="group">${opts.map(([v, l]) => `<button type="button" data-action="proto-set" data-key="${key}" data-value="${v}" aria-pressed="${String(state[key]) === v}">${l}</button>`).join("")}</div>`;
  panel.innerHTML = `<h2>原型面板</h2><p>切换主题与数据状态，或直接跳到任一页面。</p>
    <span class="label">主题</span>${seg("theme", [
      ["system", "跟随系统"],
      ["dark", "深色"],
      ["light", "浅色"],
    ])}
    <span class="label">资料状态</span>${seg("hasData", [
      ["true", "已有认识"],
      ["false", "零资料"],
    ])}
    <div class="proto-index">${PAGE_INDEX.map(([g, items]) => `<h3>${g}</h3>${items.map(([n, l, r]) => `<a href="#${r}" data-action="proto-go"><span>${n}</span>${l}</a>`).join("")}`).join("")}</div>
    <div class="actions" style="margin-top:16px"><button type="button" class="button small quiet" data-action="proto-reset">重置原型状态</button></div>`;
}
ACTIONS["proto-toggle"] = (el) => {
  const p = $("#proto-panel");
  p.hidden = !p.hidden;
  el.setAttribute("aria-expanded", String(!p.hidden));
};
ACTIONS["proto-set"] = (el) => {
  const { key, value } = el.dataset;
  state[key] = value === "true" ? true : value === "false" ? false : value;
  applyTheme();
  save();
  render();
  $("#proto-panel").hidden = false;
};
ACTIONS["proto-reset"] = () => {
  const theme = state.theme;
  state = DEFAULT_STATE();
  state.theme = theme;
  save();
  go("home");
  toast("原型状态已重置");
};
ACTIONS["proto-go"] = (el, e) => {
  e.preventDefault();
  const target = el.getAttribute("href").slice(1);
  const [route, flag] = target.split("?");
  $("#proto-panel").hidden = true;
  if (["login", "forgot", "pick-profile"].includes(route))
    state.loggedIn = route === "pick-profile";
  else state.loggedIn = true;
  if (flag === "empty") state.hasData = false;
  else if (route === "home") state.hasData = true;
  if (flag === "demo") {
    const id = ensureDemoCorrection(route === "revision");
    save();
    go(`${route}/${id}`);
    return;
  }
  save();
  go(route);
  if (flag === "evidence") setTimeout(() => openEvidence("J1"), 60);
};
function ensureDemoCorrection(done) {
  let c = state.corrections.find((x) => x.claim === "J1");
  if (!c) {
    c = {
      id: `c${Date.now()}`,
      claim: "J1",
      kind: "scope",
      text: EXAMPLE_CORRECTION,
      status: "saved",
      version: 1,
      date: "10月27日",
    };
    state.corrections.unshift(c);
  }
  if (done) {
    c.status = "done";
    state.revised = true;
  }
  return c.id;
}

/* 事件委托 */
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el && ACTIONS[el.dataset.action]) {
    ACTIONS[el.dataset.action](el, e);
    return;
  }
  const menu = $("#account-menu");
  if (menu && !menu.hidden && !e.target.closest("#account-menu")) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const m = $("#account-menu");
    if (m && !m.hidden) {
      closeMenu();
      $('[data-action="toggle-menu"]')?.focus();
    }
    if (!$("#proto-panel").hidden) $("#proto-panel").hidden = true;
  }
});
window.addEventListener("hashchange", render);
function start() {
  applyTheme();
  render();
}
