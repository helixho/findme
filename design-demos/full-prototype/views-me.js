/* 进入、我的、通用状态 */
VIEWS.login = () => ({
  title: "登录",
  bare: true,
  body: `<div class="auth"><form class="auth-card" novalidate>
    <span class="brand">${MARK}<span>找我</span><em>FindMe</em></span>
    <h1>看清自己。</h1><p class="lead">同一个账号，在手机和电脑上读取同一份资料。</p>
    <div class="field" id="email-field"><label class="label" for="email">邮箱</label><input class="input" id="email" type="email" autocomplete="email" value="me@example.com"><p class="error" id="email-error" aria-live="polite"></p></div>
    <div class="field" id="pw-field"><label class="label" for="pw">密码</label><input class="input" id="pw" type="password" autocomplete="current-password" placeholder="原型中任意填写"><p class="error" id="pw-error" aria-live="polite"></p></div>
    <button type="button" class="button primary" data-action="login">登录</button>
    <div class="auth-foot">${link("forgot", "忘记密码", "text-button")}<span class="small muted" style="align-self:center">暂不开放注册</span></div>
  </form></div>`,
});
ACTIONS.login = () => {
  const pw = $("#pw").value;
  if (!pw) {
    $("#pw-field").classList.add("invalid");
    $("#pw-error").textContent = "请输入密码。";
    $("#pw").focus();
    return;
  }
  state.loggedIn = true;
  save();
  go(PROFILES.filter((p) => !state.archivedProfiles[p.id]).length > 1 ? "pick-profile" : "home");
};
VIEWS.forgot = (r) => ({
  title: "找回密码",
  bare: true,
  body: `<div class="auth"><form class="auth-card" novalidate>
    <span class="brand">${MARK}<span>找我</span></span>
    ${
      r.a === "sent"
        ? `<h1>请查收邮件</h1><p class="lead">如果这个邮箱已注册，重置链接会在几分钟内送达。链接 30 分钟内有效。</p>${link("login", "返回登录", "button primary")}`
        : `<h1>找回密码</h1><p class="lead">输入注册时的邮箱，我们会发送重置链接。</p><div class="field"><label class="label" for="femail">邮箱</label><input class="input" id="femail" type="email" autocomplete="email"></div><button type="button" class="button primary" data-action="forgot-send">发送重置链接</button><div class="auth-foot">${link("login", "返回登录", "text-button")}</div>`
    }
  </form></div>`,
});
ACTIONS["forgot-send"] = () => go("forgot/sent");
VIEWS["pick-profile"] = () => ({
  title: "选择资料",
  bare: true,
  body: `<div class="auth"><div class="auth-card">
    <span class="brand">${MARK}<span>找我</span></span>
    <h1>这次使用哪份资料？</h1><p class="lead" style="margin-bottom:0">每份资料相互独立，认识不会混在一起。之后可以在“我的”里切换。</p>
    <div class="profile-pick">${PROFILES.filter((p) => !state.archivedProfiles[p.id])
      .map(
        (p) =>
          `<button type="button" data-action="pick-profile" data-id="${p.id}"><span class="avatar">${esc(p.name.slice(0, 1))}</span><span>${esc(p.name)}<small>${esc(p.note)}</small></span></button>`,
      )
      .join("")}</div>
  </div></div>`,
});
ACTIONS["pick-profile"] = (el) => {
  state.profile = el.dataset.id;
  state.hasData = el.dataset.id === "p1";
  save();
  go("home");
};

const ME_ITEMS = [
  ["me/profiles", "layers", "切换与管理资料", "新建、改名、归档"],
  ["me/sources", "list", "来源与导入", "哪些材料在使用，导入新材料"],
  ["me/files", "file", "托管原档", "上传、下载与删除原始文件"],
  ["me/jobs", "spark", "处理记录与额度", "每次处理的用途与次数"],
  ["me/export", "download", "导出", "带走完整的个人数据"],
  ["me/delete", "trash", "清除资料", "不可撤回"],
  ["me/account", "user", "账号与显示", "密码、主题、退出"],
];
function meBack() {
  return link("me", `${icon("left")}我的`, "back-link");
}
VIEWS.me = (r) => {
  const sub = {
    profiles: meProfiles,
    sources: meSources,
    files: meFiles,
    jobs: meJobs,
    export: meExport,
    delete: meDelete,
    account: meAccount,
  }[r.a];
  if (sub) return sub(r);
  const p = currentProfile();
  return {
    title: "我的",
    nav: null,
    body: `
    <section class="page-title"><div class="meta"><span>当前资料</span>${tag(esc(p.name), "current")}</div><h1>我的</h1><p class="lead">资料、来源和账号都在这里。阅读和探索不需要先来这里设置。</p></section>
    ${link("pending", `${icon("clock", "lead-icon")}<div class="grow"><h3>待处理与进行中</h3><p>${pendingSummary() || "没有待处理的事"}</p></div>${icon("right", "chev")}`, "row")}
    <div class="list" style="margin-top:20px">${ME_ITEMS.map(([r2, ic, t, d]) => link(r2, `${icon(ic, "lead-icon")}<div class="grow"><h3>${t}</h3><p>${d}</p></div>${icon("right", "chev")}`, "row")).join("")}</div>`,
  };
};

function meProfiles() {
  const active = PROFILES.filter((p) => !state.archivedProfiles[p.id]);
  const archived = PROFILES.filter((p) => state.archivedProfiles[p.id]);
  return {
    title: "切换与管理资料",
    nav: null,
    body: `${meBack()}
    <section class="page-title"><h1>资料</h1><p class="lead">每份资料是独立的空间：来源、认识和尝试互不共享。账号只是登录身份。</p></section>
    <div class="actions" style="margin:0 0 20px"><button type="button" class="button quiet" data-action="profile-new">${icon("plus")}新建资料</button></div>
    <div class="list">${active.map((p) => `<div class="row"><span class="avatar">${esc(p.name.slice(0, 1))}</span><div class="grow"><h3>${esc(p.name)}</h3><p>${esc(p.note)}</p></div><div class="side">${p.id === state.profile ? tag("正在使用", "current") : `<button type="button" class="button small quiet" data-action="profile-switch" data-id="${p.id}">切换</button>`}<button type="button" class="button small quiet" data-action="profile-rename" data-id="${p.id}" aria-label="改名：${esc(p.name)}">${icon("edit")}</button>${p.id === state.profile ? "" : `<button type="button" class="button small quiet" data-action="profile-archive" data-id="${p.id}" aria-label="归档：${esc(p.name)}">${icon("archive")}</button>`}</div></div>`).join("")}</div>
    ${archived.length ? `<section class="section"><div class="section-heading"><h2>已归档</h2></div><div class="list">${archived.map((p) => `<div class="row"><span class="avatar">${esc(p.name.slice(0, 1))}</span><div class="grow"><h3>${esc(p.name)}</h3><p>资料保留，排队中的处理已停止</p></div><div class="side"><button type="button" class="button small quiet" data-action="profile-restore" data-id="${p.id}">恢复</button></div></div>`).join("")}</div></section>` : ""}`,
  };
}
ACTIONS["profile-switch"] = (el) => {
  state.profile = el.dataset.id;
  state.hasData = el.dataset.id === "p1";
  save();
  toast(`已切换到“${PROFILES.find((p) => p.id === el.dataset.id).name}”`);
  go("home");
};
ACTIONS["profile-rename"] = (el) => {
  const p = PROFILES.find((x) => x.id === el.dataset.id);
  openDialog(
    "#modal",
    `${dialogHead("修改名称")}<div class="dialog-body"><div class="field"><label class="label" for="pname">资料名称</label><input class="input" id="pname" value="${esc(p.name)}" autofocus></div><div class="actions"><button type="button" class="button quiet" data-action="close-dialog">取消</button><button type="button" class="button primary" data-action="profile-rename-save" data-id="${p.id}">保存</button></div></div>`,
  );
};
ACTIONS["profile-rename-save"] = (el) => {
  const v = $("#pname").value.trim();
  if (!v) {
    $("#pname").focus();
    return;
  }
  PROFILES.find((x) => x.id === el.dataset.id).name = v;
  closeDialog("#modal");
  render();
  toast("名称已修改");
};
ACTIONS["profile-new"] = () =>
  openDialog(
    "#modal",
    `${dialogHead("新建资料")}<div class="dialog-body"><p>新资料是一个空的独立空间，不会带入现有的来源和认识。</p><div class="field" style="margin-top:16px"><label class="label" for="pnew">资料名称</label><input class="input" id="pnew" placeholder="比如：写作练习" autofocus></div><div class="actions"><button type="button" class="button quiet" data-action="close-dialog">取消</button><button type="button" class="button primary" data-action="profile-create">新建</button></div></div>`,
  );
ACTIONS["profile-create"] = () => {
  const v = $("#pnew").value.trim();
  if (!v) {
    $("#pnew").focus();
    return;
  }
  PROFILES.push({ id: `p${Date.now()}`, name: v, note: "还没有专题", status: "active" });
  closeDialog("#modal");
  render();
  toast("已新建资料");
};
ACTIONS["profile-archive"] = (el) =>
  confirmModal({
    title: "归档这份资料？",
    body: "<p>归档后不再出现在切换列表，排队中的处理会停止。资料不会删除，可以随时恢复。</p>",
    confirm: "归档",
    action: "profile-archive-ok",
    data: `data-id="${el.dataset.id}"`,
  });
ACTIONS["profile-archive-ok"] = (el) => {
  state.archivedProfiles[el.dataset.id] = true;
  save();
  closeDialog("#modal");
  render();
  toast("已归档");
};
ACTIONS["profile-restore"] = (el) => {
  delete state.archivedProfiles[el.dataset.id];
  save();
  render();
  toast("已恢复。之前停止的处理不会自动重新开始");
};

function meSources() {
  const rows = DATA_SOURCES.concat(
    state.imported
      ? [
          {
            id: "d5",
            name: "notes-2026.json",
            kind: "个人导出文件",
            count: "342 条记录",
            status: "new",
            date: "刚刚",
          },
        ]
      : [],
  );
  const st = (s) =>
    state.excluded[s.id]
      ? tag("已排除")
      : s.status === "new"
        ? tag("已导入 · 待整理", "pending")
        : tag("使用中", "current");
  return {
    title: "来源与导入",
    nav: null,
    body: `${meBack()}
    <section class="page-title"><h1>来源与导入</h1><p class="lead">认识只用“使用中”的来源。排除一批材料后，依赖它的判断会标为待复核，不会悄悄保留。</p></section>
    <div class="list">${rows.map((s) => `<div class="row">${icon("list", "lead-icon")}<div class="grow"><h3>${esc(s.name)}</h3><p>${s.kind} · ${s.count} · ${s.date}</p></div><div class="side">${st(s)}<button type="button" class="button small quiet" data-action="source-toggle" data-id="${s.id}">${state.excluded[s.id] ? "恢复使用" : "排除"}</button></div></div>`).join("")}</div>
    <section class="section"><div class="section-heading"><h2>导入新材料</h2></div>
      <div class="grid-2">
        <button type="button" class="dropzone" data-action="import-preview">${icon("upload")}<strong>选择文件导入</strong><span>个人导出文件、精确证据包。先预览，确认后才导入；不会调用模型。</span></button>
        <div class="card compact"><h3>导入已审核专题</h3><p>从固定归档读取已通过审核的专题、报告和原文引用。未通过的候选不会被导入。</p><div class="foot"><button type="button" class="text-button accent" data-action="import-archive">预览归档内容</button></div></div>
      </div>
    </section>`,
  };
}
ACTIONS["source-toggle"] = (el) => {
  const id = el.dataset.id;
  if (state.excluded[id]) {
    delete state.excluded[id];
    save();
    render();
    toast("已恢复使用，相关判断需要重新复核");
    return;
  }
  confirmModal({
    title: "排除这批材料？",
    body: '<p>排除后，这批材料不再用于任何认识。依赖它的 2 个判断会标为“待复核”，整体认识也会随之检查。</p><p class="hint">原文不会删除，可以随时恢复使用。</p>',
    confirm: "排除",
    action: "source-exclude-ok",
    data: `data-id="${id}"`,
  });
};
ACTIONS["source-exclude-ok"] = (el) => {
  state.excluded[el.dataset.id] = true;
  save();
  closeDialog("#modal");
  render();
  toast("已排除，相关判断标为待复核");
};
ACTIONS["import-preview"] = () =>
  openDialog(
    "#modal",
    `${dialogHead("导入预览")}<div class="dialog-body">
  <dl class="cost-table"><dt>文件</dt><dd>notes-2026.json</dd><dt>识别为</dt><dd>个人导出文件</dd><dt>记录</dt><dd>348 条，其中 6 条与已有记录重复，将跳过</dd><dt>时间范围</dt><dd>2026年1月—2026年9月</dd><dt>作者</dt><dd>你本人 331 条；引用他人 17 条，单独标注</dd></dl>
  <p class="hint">导入只保存材料，不会调用模型，也不会自动改变现有认识。</p>
  <div class="actions"><button type="button" class="button quiet" data-action="close-dialog">取消</button><button type="button" class="button primary" data-action="import-ok">确认导入</button></div></div>`,
  );
ACTIONS["import-ok"] = () => {
  state.imported = true;
  save();
  closeDialog("#modal");
  render();
  toast("已导入 342 条记录");
};
ACTIONS["import-archive"] = () =>
  openDialog(
    "#modal",
    `${dialogHead("已审核专题归档")}<div class="dialog-body">
  <dl class="cost-table"><dt>可导入</dt><dd>3 个已通过审核的专题</dd><dt>不导入</dt><dd>3 个待审候选、1 个未成稿专题、整体总览</dd><dt>保留</dt><dd>原审核记录、报告版本、原文位置与来源指纹</dd></dl>
  <p class="hint">同一份归档重复导入不会产生重复内容。</p>
  <div class="actions"><button type="button" class="button quiet" data-action="close-dialog">取消</button><button type="button" class="button primary" data-action="archive-ok">导入</button></div></div>`,
  );

function meFiles() {
  return {
    title: "托管原档",
    nav: null,
    body: `${meBack()}
    <section class="page-title"><h1>托管原档</h1><p class="lead">原始文件可以托管在云端，方便在任何设备上核对原文。不托管也能使用，只是无法回看未保存的原文。</p></section>
    <div class="list">${FILES.filter((f) => !state[`delfile_${f.id}`])
      .map(
        (f) =>
          `<div class="row">${icon("file", "lead-icon")}<div class="grow"><h3>${f.name}</h3><p>${f.size} · 上传于 ${f.date}</p></div><div class="side"><button type="button" class="button small quiet" data-action="file-download" aria-label="下载 ${f.name}">${icon("download")}</button><button type="button" class="button small danger" data-action="file-delete" data-id="${f.id}" aria-label="删除 ${f.name}">${icon("trash")}</button></div></div>`,
      )
      .join("")}</div>
    <div class="section"><button type="button" class="dropzone" data-action="file-upload">${icon("upload")}<strong>上传原始文件</strong><span>单个文件不超过 200 MB。上传不会自动导入或分析。</span></button></div>`,
  };
}
ACTIONS["file-download"] = () => toast("原型中不会真的下载文件");
ACTIONS["file-upload"] = () => toast("原型中不会真的上传文件");
ACTIONS["file-delete"] = (el) =>
  confirmModal({
    title: "删除这个原始文件？",
    body: "<p>删除后无法恢复。已经形成的认识会保留，但引用这个文件的原文将无法再核对，相关判断会标为待复核。</p>",
    confirm: "永久删除",
    danger: true,
    action: "file-delete-ok",
    data: `data-id="${el.dataset.id}"`,
  });
ACTIONS["file-delete-ok"] = (el) => {
  state[`delfile_${el.dataset.id}`] = true;
  save();
  closeDialog("#modal");
  render();
  toast("文件已删除");
};

function meJobs() {
  const st = {
    done: tag("已完成", "current"),
    failed: tag("失败 · 未自动重试", "danger"),
    off: tag("未启用"),
  };
  return {
    title: "处理记录与额度",
    nav: null,
    body: `${meBack()}
    <section class="page-title"><h1>处理记录与额度</h1><p class="lead">只有你确认过的处理才会调用模型。失败不会自动重试，也不会扩大次数。</p></section>
    <div class="grid-3"><div class="card compact"><span class="small muted">本月剩余调用</span><h3 style="font-size:34px;margin:6px 0 0">12 <span class="small muted">/ 20 次</span></h3></div><div class="card compact"><span class="small muted">本月已用</span><h3 style="font-size:34px;margin:6px 0 0">8</h3></div><div class="card compact"><span class="small muted">服务方</span><h3 style="margin-top:10px">DeepSeek</h3><p>经 FindMe 统一出口</p></div></div>
    <section class="section"><div class="section-heading"><h2>处理记录</h2></div><div class="list">${JOBS.map((j) => `<div class="row">${icon("spark", "lead-icon")}<div class="grow"><h3>${j.title}</h3><p>${j.max ? `用了 ${j.used} / 上限 ${j.max} 次 · ${j.date}` : "框架分析当前未启用"}</p></div><div class="side">${st[j.status]}${j.status === "failed" ? '<button type="button" class="button small quiet" data-action="job-retry">重新处理</button>' : ""}</div></div>`).join("")}</div></section>`,
  };
}
ACTIONS["job-retry"] = () =>
  confirmModal({
    title: "重新处理前，请确认",
    body: '<dl class="cost-table"><dt>用途</dt><dd>整理一次探索的回答</dd><dt>服务方</dt><dd>DeepSeek（经 FindMe 统一出口）</dd><dt>最多调用</dt><dd>2 次</dd><dt>本月剩余</dt><dd>12 次</dd></dl><p class="hint">上一次失败的记录会保留。</p>',
    confirm: "确认处理",
    action: "job-retry-ok",
  });
ACTIONS["job-retry-ok"] = () => {
  closeDialog("#modal");
  toast("原型中不运行真实处理");
};

function meExport() {
  return {
    title: "导出",
    nav: null,
    body: `${meBack()}
    <section class="page-title"><h1>导出完整个人数据</h1><p class="lead">把这份资料里属于你的内容一起带走。导出只给你自己下载，不会发送给任何人。</p></section>
    <div class="grid-2" style="max-width:900px"><div class="card compact"><h3>包含</h3><ul style="display:grid;gap:6px;margin-top:6px">${["你的作答与补充", "认识及每一次修订", "纠正与反馈", "尝试与回顾", "来源记录与引用关系"].map((x) => `<li class="small" style="display:flex;gap:8px;align-items:center;font-size:15px">${icon("check")}${x}</li>`).join("")}</ul></div>
    <div class="card compact"><h3>不包含</h3><ul style="display:grid;gap:6px;margin-top:6px">${["账号密码等登录凭据", "没有托管的原始文件", "其他资料里的内容"].map((x) => `<li style="font-size:15px;color:var(--muted)">${x}</li>`).join("")}</ul><p class="hint">托管原档需在“托管原档”中单独下载。</p></div></div>
    <div class="actions" id="export-actions"><button type="button" class="button primary" data-action="export-go">${icon("download")}生成导出包</button></div>`,
  };
}
ACTIONS["export-go"] = () => {
  $("#export-actions").innerHTML =
    `<div class="banner ok" style="margin:0">${icon("clock")}<div class="copy"><h3>正在打包</h3><p>分页整理中，通常不超过一分钟。</p></div></div>`;
  setTimeout(() => {
    const a = $("#export-actions");
    if (a)
      a.innerHTML = `<div class="banner ok" style="margin:0">${icon("check")}<div class="copy"><h3>导出包已就绪</h3><p>findme-我的资料-2026-10-27.zip · 2.1 MB · 24 小时内有效</p><div class="actions"><button type="button" class="button small primary" data-action="file-download">下载</button></div></div></div>`;
  }, 1600);
};

function meDelete() {
  const p = currentProfile();
  return {
    title: "清除资料",
    nav: null,
    body: `${meBack()}
    <section class="page-title"><h1>清除“${esc(p.name)}”的个人数据</h1><p class="lead">这会删除这份资料里的来源、原文、认识、修订、纠正和尝试。账号本身和累计用量记录保留。</p></section>
    <div class="banner danger" style="max-width:760px">${icon("alert")}<div class="copy"><h3>无法撤回</h3><p>删除后不能恢复。如果想先保留一份，请先导出。</p><div class="actions">${link("me/export", "先去导出", "button small quiet")}</div></div></div>
    <form style="max-width:520px" novalidate><div class="field"><label class="label" for="confirm-name">输入资料名称“${esc(p.name)}”以确认</label><input class="input" id="confirm-name" autocomplete="off" data-name="${esc(p.name)}"></div>
    <button type="button" class="button danger solid" data-action="delete-go" disabled id="delete-btn">永久清除这份资料</button></form>`,
    after() {
      $("#confirm-name").addEventListener("input", (e) => {
        $("#delete-btn").disabled = e.target.value.trim() !== e.target.dataset.name;
      });
    },
  };
}
ACTIONS["delete-go"] = () => {
  state.hasData = false;
  state.corrections = [];
  state.savedExplorations = [];
  state.revised = false;
  state.trials = [];
  save();
  go("home");
  toast("已清除。原型中可在原型面板重置");
};

function meAccount() {
  const seg = [
    ["system", "跟随系统"],
    ["dark", "深色"],
    ["light", "浅色"],
  ];
  return {
    title: "账号与显示",
    nav: null,
    body: `${meBack()}
    <section class="page-title"><h1>账号与显示</h1></section>
    <div class="list" style="max-width:820px">
      <div class="row">${icon("mail", "lead-icon")}<div class="grow"><h3>登录邮箱</h3><p>me@example.com</p></div></div>
      <div class="row">${icon("lock", "lead-icon")}<div class="grow"><h3>密码</h3><p>上次修改于 2026年10月8日</p></div><div class="side"><button type="button" class="button small quiet" data-action="pw-change">修改</button></div></div>
      <div class="row">${icon("sun", "lead-icon")}<div class="grow"><h3>主题</h3><p>深色是默认主题；浅色适合白天长时间阅读。</p></div><div class="side"><div class="segmented" role="group" aria-label="主题">${seg.map(([v, l]) => `<button type="button" data-action="set-theme" data-value="${v}" aria-pressed="${state.theme === v}">${l}</button>`).join("")}</div></div></div>
      <div class="row">${icon("logout", "lead-icon")}<div class="grow"><h3>退出登录</h3><p>只退出这台设备，资料保留在云端。</p></div><div class="side"><button type="button" class="button small quiet" data-action="logout">退出</button></div></div>
    </div>`,
  };
}
ACTIONS["set-theme"] = (el) => {
  state.theme = el.dataset.value;
  applyTheme();
  save();
  render();
};
ACTIONS["pw-change"] = () =>
  openDialog(
    "#modal",
    `${dialogHead("修改密码")}<div class="dialog-body"><div class="field"><label class="label" for="pw-old">当前密码</label><input class="input" id="pw-old" type="password" autocomplete="current-password" autofocus></div><div class="field"><label class="label" for="pw-new">新密码</label><input class="input" id="pw-new" type="password" autocomplete="new-password"><p class="hint">至少 10 位。修改后，其他设备需要重新登录。</p></div><div class="actions"><button type="button" class="button quiet" data-action="close-dialog">取消</button><button type="button" class="button primary" data-action="pw-save">保存</button></div></div>`,
  );
ACTIONS["pw-save"] = () => {
  closeDialog("#modal");
  toast("原型中不会真的修改密码");
};

VIEWS.states = () => ({
  title: "通用状态",
  nav: null,
  body: `<section class="page-title"><h1>通用状态</h1><p class="lead">每种状态在所有页面使用同一种呈现。</p></section>
  <div class="state-grid">
    <section><small>加载</small><div class="skeleton" aria-label="正在读取"><i class="h"></i><i></i><i></i><i class="s"></i></div></section>
    <section><small>空</small><div class="empty">${icon("understand")}<h3>还没有专题</h3><p>从一件经历开始，或导入历史记录。资料不够时不会拼出结论。</p><div class="actions">${link("explore/start", "从一件经历开始", "button small primary")}</div></div></section>
    <section><small>出错</small><div class="banner danger" style="margin:0">${icon("alert")}<div class="copy"><h3>暂时读不到当前认识</h3><p>网络或服务出了问题。你的内容没有丢失。</p><div class="actions"><button type="button" class="button small quiet" data-action="retry-demo">${icon("refresh")}重试</button></div></div></div></section>
    <section><small>来源失效</small><div class="banner pending" style="margin:0">${icon("alert")}<div class="copy"><h3>这个专题暂停显示</h3><p>它依赖的一批材料被排除或删除了。旧内容不再作为当前认识，需要复核后才会重新出现。</p><div class="actions">${link("me/sources", "查看来源", "button small quiet")}</div></div></div></section>
    <section><small>待复核</small><div class="claim" style="margin:0"><div class="claim-top">${tag("待复核", "pending")}<span class="small muted">工作与投入</span></div><h3>目标明确、可以自主安排时，你更容易持续投入。</h3><p>一次尝试的回顾与这条判断有关。复核之前，这条判断照常显示，并标明待复核。</p></div></section>
    <section><small>待核验</small><div class="target" style="margin:0"><small>你的补充 · ${tag("待核验", "pending")}</small><blockquote style="font-size:17px">上次分工说清楚之后，那块是我主动接下来的。</blockquote><p class="hint">已保存，还没有处理。不会被当作已经理解。</p></div></section>
  </div>`,
});
ACTIONS["retry-demo"] = () => toast("原型中这是状态示例");
ACTIONS["archive-ok"] = () => {
  closeDialog("#modal");
  toast("这 3 个专题已经导入过，没有重复导入");
};
