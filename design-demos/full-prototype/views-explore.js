/* 探索：引导起步、继续理解、作品视角、框架访谈、具体困难与尝试 */
const ENTRY_PROMPTS = [
  ["一件顺利的事", "说说最近一件推进得挺顺的事。发生了什么？"],
  ["一段很投入的时刻", "说说最近一次很投入、不想被打断的时候。你在做什么？"],
  ["一个满意的选择", "说说一个事后回想仍觉得选对了的决定。当时怎么选的？"],
  ["一件让你卡住的事", "说说一件拖着没做、或做到一半停下的事。卡在哪里？"],
  ["自己写", "想到什么就写什么。一件事、一个念头都可以。"],
];
const Q2 = {
  text: "在这件事里，你当时最在意的是什么？",
  why: "问这个是为了分清“发生了什么”和“你看重什么”。选项只是帮你开口，可以都不选。",
  options: ["把事情做完、做好", "别人怎么看", "能自己安排时间", "和身边人的关系"],
};
const Q3 = {
  text: "如果按当时知道的情况重来一次，你还会这样做吗？",
  why: "只按当时知道的信息和可选的做法来想，不按后来的结果。后悔也不代表当时选错了。",
  options: ["会", "大概会", "不会", "说不清"],
};

VIEWS.explore = (r) => {
  const sub = {
    start: exploreStart,
    continue: exploreContinue,
    book: exploreBook,
    framework: exploreFramework,
    support: exploreSupport,
    trials: trialsList,
    trial: trialDetail,
  }[r.a];
  if (sub) return sub(r);
  const active = state.trials.filter((t) => t.status === "active");
  return {
    title: "探索",
    nav: "explore",
    body: `
    <section class="page-title"><h1>想从哪里开始？</h1><p class="lead">探索是补充和检验认识的方式。每一种都可以中途停下，说过的话会先保存，不会自动变成结论。</p></section>
    <div class="grid-2">
      ${link("explore/start", `${tag("一次一个问题")}<h3>从一件经历开始</h3><p>顺利的、投入的、满意的、卡住的都可以。适合不知道该说什么的时候。</p><div class="foot"><span>开始</span>${icon("right")}</div>`, "card")}
      ${link("explore/continue", `${tag("带着上下文")}<h3>继续理解一个判断</h3><p>选一句已有的判断，回答一个能区分不同解释的问题。</p><div class="foot"><span>选择判断</span>${icon("right")}</div>`, "card")}
      ${link("explore/book", `${tag("可选视角")}<h3>借一本书看一件事</h3><p>用一本书整理出的视角，看看它会关注什么、提出什么做法和代价。由你判断。</p><div class="foot"><span>选择作品</span>${icon("right")}</div>`, "card")}
      ${link("explore/framework", `${tag("定义：草稿", "pending")}<h3>按一个框架访谈</h3><p>HUMAN 3.0 逐题访谈，可以跳过和暂停。结果只代表这个框架的看法。</p><div class="foot"><span>${Object.keys(state.framework.answers).length ? "继续访谈" : "了解并开始"}</span>${icon("right")}</div>`, "card")}
    </div>
    <section class="section">
      ${link("explore/support", `${icon("target", "lead-icon")}<div class="grow"><h3>具体困难与可选调整</h3><p>从一件具体的事出发，看看有哪些可以小步尝试的调整。不做诊断。</p></div>${icon("right", "chev")}`, "row")}
    </section>
    <section class="section"><div class="section-heading"><h2>我的尝试</h2>${link("explore/trials", "全部尝试", "text-button")}</div>
      ${active.length ? `<div class="list">${active.map((t) => link(`explore/trial/${t.id}`, `${icon("flag", "lead-icon")}<div class="grow"><h3>${esc(t.title)}</h3><p>开始于 ${t.started} · 计划 ${t.review} 回顾</p></div><div class="side">${tag("进行中", "current")}${icon("right", "chev")}</div>`, "row")).join("")}</div>` : `<div class="empty"><p>还没有进行中的尝试。尝试只会在你确认之后开始。</p></div>`}
    </section>`,
  };
};

/* 13 从一件经历开始 */
function exploreStart(r) {
  const ex = state.explore;
  if (r.b !== undefined) {
    ex.entry = r.b === "free" ? 4 : Number(r.b);
    ex.step = 1;
    ex.answers = {};
    save();
    setTimeout(() => location.replace("#explore/start"), 0);
  }
  if (!ex.step || ex.entry === null) {
    return {
      title: "从一件经历开始",
      nav: "explore",
      body: `${link("explore", `${icon("left")}探索`, "back-link")}
      <section class="page-title"><h1>挑一件最近的事。</h1><p class="lead">不一定是问题。顺利、投入、满意的经历，同样能帮助理解你。</p></section>
      ${entryGrid()}<div class="actions">${link("explore/start/free", "我想自己写", "button quiet")}</div>`,
    };
  }
  const head = (n) =>
    `<div class="step-head"><span>${ENTRY_PROMPTS[ex.entry][0]} · 第 ${n} 个问题 · 随时可以结束</span><button type="button" class="button small quiet" data-action="explore-end">结束，看看整理了什么</button></div>`;
  if (ex.step === 1) {
    return {
      title: "发生了什么",
      nav: "explore",
      body: `${head(1)}
      <form class="question" novalidate>
        <h1>${ENTRY_PROMPTS[ex.entry][1]}</h1>
        <p class="why">写几句就够。说到哪算哪，后面只问会影响理解的部分。</p>
        <div class="field" id="q1-field" style="margin-top:24px"><label class="sr-only" for="q1">你的回答</label><textarea id="q1" placeholder="比如：上周把拖了很久的报告写完了，是因为……">${esc(ex.answers.q1 || "")}</textarea><p class="error" id="q1-error" aria-live="polite"></p></div>
        <div class="form-footer"><button type="button" class="button quiet" data-action="explore-restart">换一件事</button><button type="button" class="button primary" data-action="explore-next" data-step="1">继续</button></div>
      </form>`,
    };
  }
  if (ex.step === 2 || ex.step === 3) {
    const q = ex.step === 2 ? Q2 : Q3;
    const key = ex.step === 2 ? "q2" : "q3";
    return {
      title: q.text,
      nav: "explore",
      body: `${head(ex.step)}
      <form class="question" novalidate>
        <h1>${q.text}</h1><p class="why">${q.why}</p>
        <div class="question-options" role="radiogroup" aria-label="${q.text}">${q.options.map((o) => `<label class="choice"><input type="radio" name="opt" value="${o}" ${ex.answers[key] === o ? "checked" : ""}><span>${o}</span></label>`).join("")}</div>
        <div class="alt-actions"><button type="button" data-action="explore-alt" data-value="都不是">都不是</button><button type="button" data-action="explore-alt" data-value="不知道">不知道</button><button type="button" data-action="explore-alt" data-value="跳过">跳过这个问题</button></div>
        <div class="field" style="margin-top:22px"><label class="label" for="extra">想补充一句（可以不写）</label><textarea id="extra" style="min-height:96px">${esc(ex.answers[`${key}x`] || "")}</textarea></div>
        <div class="form-footer"><button type="button" class="button quiet" data-action="explore-back">上一个问题</button><button type="button" class="button primary" data-action="explore-next" data-step="${ex.step}">继续</button></div>
      </form>`,
    };
  }
  const a = ex.answers;
  const cared = a.q2 && !["都不是", "不知道", "跳过"].includes(a.q2);
  return {
    title: "这次整理了什么",
    nav: "explore",
    body: `${link("explore", `${icon("left")}探索`, "back-link")}
    <section class="page-title"><div class="eyeline">这次的收获</div><h1>${cared ? "先整理到这里。" : "这次先整理经历。"}</h1><p class="lead">${cared ? "这是一次有范围的观察，只说明这一件事。" : "材料还不够形成观察。经历本身已经整理好，以后可以继续。"}</p></section>
    <div class="outcome" style="max-width:760px">
      <section><small>整理出的经历</small><dl class="facts"><dt>发生了什么</dt><dd>${esc(a.q1 || "没有写")}</dd><dt>你在意的</dt><dd>${esc(a.q2 || "没有回答")}${a.q2x ? `；${esc(a.q2x)}` : ""}</dd><dt>如果重来</dt><dd>${esc(a.q3 || "没有回答")}${a.q3x ? `；${esc(a.q3x)}` : ""}</dd></dl></section>
      ${cared ? `<section><small>一个有限的观察</small><p style="font-size:17px;color:var(--ink)">在这件事里，你最在意的是“${esc(a.q2)}”。</p><p class="hint">范围：只有这一件事。它不能说明你一贯如此，也没有被核验。</p></section>` : ""}
      <section><small>留着的问题</small><p>换成另一类事情时，你在意的会一样吗？</p></section>
    </div>
    <div class="actions"><button type="button" class="button primary" data-action="explore-save">保存这次探索</button><button type="button" class="button quiet" data-action="explore-restart">再说一件事</button><button type="button" class="text-button" data-action="explore-discard">不保存，结束</button></div>
    <p class="hint">保存后会进入“待核验”。之后是否形成认识，需要你确认处理。</p>`,
  };
}
function readExploreForm(step) {
  const ex = state.explore;
  if (step === 1) {
    ex.answers.q1 = $("#q1").value.trim();
    return;
  }
  const key = step === 2 ? "q2" : "q3";
  const picked = $('input[name="opt"]:checked');
  if (picked) ex.answers[key] = picked.value;
  ex.answers[`${key}x`] = $("#extra").value.trim();
}
ACTIONS["explore-next"] = (el) => {
  const step = Number(el.dataset.step);
  readExploreForm(step);
  if (step === 1 && !state.explore.answers.q1) {
    $("#q1-field").classList.add("invalid");
    $("#q1-error").textContent = "写一两句就可以；不想写也可以直接结束。";
    $("#q1").focus();
    return;
  }
  state.explore.step = step + 1;
  save();
  render();
};
ACTIONS["explore-alt"] = (el) => {
  const ex = state.explore;
  ex.answers[ex.step === 2 ? "q2" : "q3"] = el.dataset.value;
  readExploreForm(ex.step);
  ex.answers[ex.step === 2 ? "q2" : "q3"] = el.dataset.value;
  ex.step += 1;
  save();
  render();
};
ACTIONS["explore-back"] = () => {
  readExploreForm(state.explore.step);
  state.explore.step -= 1;
  save();
  render();
};
ACTIONS["explore-end"] = () => {
  const s = state.explore.step;
  if (s >= 1 && s <= 3) readExploreForm(s);
  state.explore.step = 4;
  save();
  render();
};
ACTIONS["explore-restart"] = () => {
  state.explore = { step: 0, entry: null, answers: {} };
  save();
  go("explore/start");
  render();
};
ACTIONS["explore-save"] = () => {
  const { entry, answers } = state.explore;
  const observation =
    answers.q2 && !["都不是", "不知道", "跳过"].includes(answers.q2)
      ? `在这件事里，你最在意的是“${answers.q2}”。`
      : "目前只保存了这段经历，暂不形成观察。";
  state.savedExplorations ||= [];
  state.savedExplorations.unshift({
    id: `e${Date.now()}`,
    title: ENTRY_PROMPTS[entry]?.[0] || "一次探索",
    answers: { ...answers },
    observation,
    status: "pending",
    date: "10月30日",
  });
  state.explore = { step: 0, entry: null, answers: {} };
  save();
  go("pending");
  toast("已保存，待核验");
};
ACTIONS["explore-discard"] = () => {
  state.explore = { step: 0, entry: null, answers: {} };
  save();
  go("explore");
};

/* 14 继续理解某判断 */
function exploreContinue(r) {
  const id = CLAIMS[r.b] ? r.b : null;
  if (!id) {
    return {
      title: "继续理解",
      nav: "explore",
      body: `${link("explore", `${icon("left")}探索`, "back-link")}
      <section class="page-title"><h1>选一句想继续理解的判断。</h1><p class="lead">会带着这句话和它的版本进入，问题只围绕它。</p></section>
      <div class="list">${Object.keys(CLAIMS)
        .map((k) =>
          link(
            `explore/continue/${k}`,
            `<div class="grow"><h3>${esc(claimText(k))}</h3><p>${TOPICS[CLAIMS[k].topic].label} · 版本 ${version(CLAIMS[k].topic)}</p></div>${icon("right", "chev")}`,
            "row",
          ),
        )
        .join("")}</div>`,
    };
  }
  const c = CLAIMS[id];
  const t = TOPICS[c.topic];
  return {
    title: "继续理解",
    nav: "explore",
    body: `${link(`topic/${c.topic}`, `${icon("left")}返回${t.label}`, "back-link")}
    <div class="form-layout"><form class="question" novalidate data-claim="${id}">
      <div class="target"><small>继续理解 · ${t.label} · 版本 ${version(c.topic)}</small><blockquote>${esc(claimText(id))}</blockquote></div>
      <h1>${t.unknown}</h1>
      <p class="why">为什么问这个：现在的材料分不开几种解释，这个问题的回答最可能改变判断。</p>
      <div class="question-options">${["依然顺畅", "会变慢或犹豫", "没遇到过这种情况"].map((o) => `<label class="choice"><input type="radio" name="opt" value="${o}"><span>${o}</span></label>`).join("")}</div>
      <div class="alt-actions"><button type="button" data-action="continue-skip">不知道 / 跳过</button></div>
      <div class="field" id="cont-field" style="margin-top:22px"><label class="label" for="cont-text">想到的具体经历</label><textarea id="cont-text" style="min-height:120px" placeholder="一件具体的事比概括更有帮助"></textarea><p class="error" id="cont-error" aria-live="polite"></p></div>
      <div class="form-footer"><span class="small muted">保存后待核验，不会马上改写判断。</span><button type="button" class="button primary" data-action="continue-save">保存回答</button></div>
    </form>
    <aside class="aside-box"><section><h3>你的回答会怎样被使用</h3><p>回答会记下是在这个问题之后说的。受提示后的回答，不会被当作没有提示的独立经历。</p></section></aside></div>`,
  };
}
ACTIONS["continue-save"] = () => {
  const form = $("form.question");
  const opt = $('input[name="opt"]:checked')?.value;
  const text = $("#cont-text").value.trim();
  if (!opt && !text) {
    $("#cont-field").classList.add("invalid");
    $("#cont-error").textContent = "选一项或写一句再保存；也可以选“不知道 / 跳过”。";
    return;
  }
  const corr = {
    id: `c${Date.now()}`,
    claim: form.dataset.claim,
    kind: "continue",
    text: [opt, text].filter(Boolean).join("："),
    status: "saved",
    version: version(CLAIMS[form.dataset.claim].topic),
    date: "10月27日",
  };
  state.corrections.unshift(corr);
  save();
  go(`receipt/${corr.id}`);
};
ACTIONS["continue-skip"] = (el) => {
  toast("已跳过。这个问题会留在“还缺什么”里");
  go(`topic/${CLAIMS[$("form.question").dataset.claim].topic}`);
};

/* 15 借一本书看 */
function exploreBook(r) {
  if (r.b === "view") {
    const ev = state.bookEvent || "那次会上没接话，因为不知道谁负责拍板。";
    return {
      title: "作品视角",
      nav: "explore",
      body: `${link("explore/book/event", `${icon("left")}换一件事`, "back-link")}
      <div class="meta">${tag("《新世界》有限反思卡 · 版本 1")}${tag("现代转述，不是作者本人发言")}</div>
      <h1 style="font-size:clamp(28px,3vw,40px);max-width:820px">借这个视角，看“${esc(ev.length > 24 ? `${ev.slice(0, 24)}…` : ev)}”</h1>
      <div class="perspective">
        <section><small>这个视角会关注什么</small><p>当时脑子里的评判和担心，与眼前实际发生的事，是不是同一回事。</p></section>
        <section><small>依据</small><p>来自书中关于“念头与当下”的章节主题，经整理后的转述，不是原文。</p></section>
        <section><small>对这件事的推演</small><p>沉默可能并不只是“没想好”，也可能是在等一个外部的确认。这个视角会请你留意那一刻是否在担心说错。</p></section>
        <section><small>可能的做法与代价</small><p>下次先说出“我不确定谁来定，我的想法是……”。代价是要承受暂时说错的不安。</p></section>
      </div>
      <div class="unknown"><h3>这个视角的局限</h3><p>它关注内在体验，容易忽略分工本身确实不清这个现实条件。它不判断你是什么样的人。</p></div>
      <fieldset style="margin-top:28px"><legend>你怎么看？</legend><div class="chips">${["有一部分说中了", "不太认同", "我有自己的看法"].map((o) => `<label class="chip"><input type="radio" name="book-view">${icon("check")}${o}</label>`).join("")}</div></fieldset>
      <div class="field"><label class="label" for="book-text">想说的话（可以不写）</label><textarea id="book-text" style="min-height:100px"></textarea></div>
      <div class="banner">${icon("alert")}<div class="copy"><p>当前版本不保存这次回应。即使你认同，也只记作受到提示后的反应，不会成为关于你的证据。</p></div></div>
      <div class="actions">${link("explore", "结束", "button primary")}${link("explore/book", "换一本书", "text-button")}</div>`,
    };
  }
  if (r.b === "event") {
    return {
      title: "选一件事",
      nav: "explore",
      body: `${link("explore/book", `${icon("left")}换一本书`, "back-link")}
      <section class="page-title"><h1>想借这个视角，看哪件事？</h1><p class="lead">可以从记录里选，也可以写一件新的。</p></section>
      <div class="question-options" style="max-width:720px">${["那次会上没接话，因为不知道谁负责拍板。", "推掉了一个看起来更体面的邀请。"].map((e) => `<label class="choice"><input type="radio" name="ev" value="${e}"><span>${e}<small>来自你的记录</small></span></label>`).join("")}</div>
      <div class="field" style="max-width:720px;margin-top:18px"><label class="label" for="ev-text">或者写一件新的</label><textarea id="ev-text" style="min-height:90px"></textarea></div>
      <div class="actions"><button type="button" class="button primary" data-action="book-go">看这个视角</button></div>`,
    };
  }
  return {
    title: "借一本书看",
    nav: "explore",
    body: `${link("explore", `${icon("left")}探索`, "back-link")}
    <section class="page-title"><h1>借一本书，看一件事。</h1><p class="lead">每个视角都标明来源和局限。它会提出问题和做法，但不替你判断，也不决定你是谁。</p></section>
    <div class="grid-3">
      ${link("explore/book/event", `${tag("已发布", "current")}<h3>《新世界》</h3><p>关注念头、评判与当下体验之间的区别。有限反思卡，只覆盖部分章节主题。</p><div class="foot"><span>选这本</span>${icon("right")}</div>`, "card")}
      <div class="card dashed">${tag("尚未发布")}<h3>《论语》</h3><p>内容还在整理和审核，暂不可用。</p></div>
      <div class="card dashed">${tag("尚未发布")}<h3>《道德经》</h3><p>内容还在整理和审核，暂不可用。</p></div>
    </div>`,
  };
}
ACTIONS["book-go"] = () => {
  state.bookEvent = $("#ev-text").value.trim() || $('input[name="ev"]:checked')?.value || "";
  save();
  go("explore/book/view");
};

/* 16 框架访谈 */
function exploreFramework(r) {
  const f = state.framework;
  if (r.b === "q" && !f.done) {
    const q = FRAMEWORK_QUESTIONS[f.index];
    return {
      title: "框架访谈",
      nav: "explore",
      body: `<div class="step-head"><span>HUMAN 3.0 · ${q.domain} · 第 ${f.index + 1} / ${FRAMEWORK_QUESTIONS.length} 题</span><button type="button" class="button small quiet" data-action="fw-pause">${icon("pause")}暂停</button></div>
      <form class="question" novalidate>
        <div class="meter" style="max-width:320px;margin-bottom:26px" aria-hidden="true">${FRAMEWORK_QUESTIONS.map((_, i) => `<i class="${i < f.index ? "on" : ""}"></i>`).join("")}</div>
        ${tag(`${q.domain}领域`)}
        <h1 style="margin-top:14px">${q.text}</h1>
        <p class="why">按你自己的话回答。答不上来可以跳过，跳过的领域会标为缺少输入。</p>
        <div class="field" id="fw-field" style="margin-top:22px"><label class="sr-only" for="fw-text">你的回答</label><textarea id="fw-text">${esc(f.answers[f.index] || "")}</textarea><p class="error" id="fw-error" aria-live="polite"></p></div>
        <div class="form-footer"><button type="button" class="button quiet" data-action="fw-skip">跳过这题</button><button type="button" class="button primary" data-action="fw-next">保存并继续</button></div>
      </form>`,
    };
  }
  const answered = Object.keys(f.answers).length;
  return {
    title: "框架访谈",
    nav: "explore",
    body: `${link("explore", `${icon("left")}探索`, "back-link")}
    ${f.done ? `<div class="banner ok">${icon("check")}<div class="copy"><h3>这次访谈已完成</h3><p>分析需要调用模型，开始前会确认用途和次数。原型中直接展示示例报告。</p><div class="actions">${link("understand/framework", "查看框架报告", "button small primary")}</div></div></div>` : ""}
    ${f.paused && !f.done ? `<div class="banner">${icon("pause")}<div class="copy"><h3>已暂停在第 ${f.index + 1} 题</h3><p>回答已逐题保存，可以随时继续。</p></div></div>` : ""}
    <section class="page-title"><div class="meta"><span>HUMAN 3.0</span>${tag("定义：草稿", "pending")}</div><h1>按一个框架理解自己</h1><p class="lead">这个框架从心智、身体、精神、职业四个领域提问。它的等级只在框架内有意义，不是对你的总体评分，也不会改写你的当前认识。</p></section>
    <dl class="cost-table" style="max-width:640px"><dt>题目</dt><dd>本次示例 4 题，每个领域 1 题</dd><dt>可以</dt><dd>跳过、暂停、修改已答内容</dd><dt>分析</dt><dd>答完后另行确认，读取和保存不调用模型</dd><dt>状态</dt><dd>${answered ? `已答 ${answered} 题` : "尚未开始"}</dd></dl>
    <div class="actions">${f.done ? link("understand/framework", "查看报告", "button primary") : link("explore/framework/q", answered || f.index ? "继续访谈" : "开始访谈", "button primary")}</div>`,
  };
}
ACTIONS["fw-next"] = () => {
  const f = state.framework;
  const v = $("#fw-text").value.trim();
  if (!v) {
    $("#fw-field").classList.add("invalid");
    $("#fw-error").textContent = "写下回答再继续；不想回答可以跳过。";
    $("#fw-text").focus();
    return;
  }
  f.answers[f.index] = v;
  advanceFw();
};
ACTIONS["fw-skip"] = () => {
  delete state.framework.answers[state.framework.index];
  advanceFw();
};
function advanceFw() {
  const f = state.framework;
  f.index += 1;
  f.paused = false;
  if (f.index >= FRAMEWORK_QUESTIONS.length) {
    f.done = true;
    f.index = FRAMEWORK_QUESTIONS.length - 1;
    save();
    go("explore/framework");
    return;
  }
  save();
  render();
}
ACTIONS["fw-pause"] = () => {
  const v = $("#fw-text").value.trim();
  if (v) state.framework.answers[state.framework.index] = v;
  state.framework.paused = true;
  save();
  go("explore/framework");
  toast("已暂停，回答已保存");
};

/* 17 具体困难与可选调整 */
const DIFFICULTIES = [
  "开始任务",
  "维持专注",
  "任务切换",
  "估计时间",
  "整理步骤",
  "容易被打断",
  "噪声",
  "口头要求记不住",
];
function exploreSupport(r) {
  const s = state.support;
  const step = Number(r.b || 0);
  const steps = ["先说一件具体事", "可选的调整", "收成一次尝试"];
  const progress = `<div class="step-head"><span>${steps.map((x, i) => (i === step ? `<strong style="color:var(--ink);font-weight:500">${x}</strong>` : x)).join(" → ")}</span></div>`;
  if (step === 1) {
    return {
      title: "可选的调整",
      nav: "explore",
      body: `${link("explore/support", `${icon("left")}修改情境`, "back-link")}${progress}
      <section class="page-title"><h1>有几种可以试的调整。</h1><p class="lead">每条都分开写“为什么和你有关”和“方法依据”。都不合适也没关系。</p></section>
      <div style="display:grid;gap:14px;max-width:860px">${SUPPORT_CANDIDATES.map((c) => `<label class="candidate ${s.picked === c.id ? "selected" : ""}"><div class="candidate-head"><h3>${c.title}</h3><input type="radio" name="cand" value="${c.id}" ${s.picked === c.id ? "checked" : ""} style="width:20px;height:20px;accent-color:var(--accent-text)"></div><div class="basis"><div><small>为什么和你有关</small><p>${c.personal}</p></div><div><small>方法依据</small><p>${c.method}</p></div></div><div class="cost">${tag(c.burden)}${tag(`代价：${c.cost}`)}</div></label>`).join("")}</div>
      <div class="form-footer" style="max-width:860px"><div class="alt-actions" style="margin:0"><button type="button" data-action="support-none">都不合适</button><button type="button" data-action="support-own">我有自己的做法</button></div><button type="button" class="button primary" data-action="support-pick">用这一条做个尝试</button></div>
      <p class="error" id="cand-error" aria-live="polite"></p>`,
      after() {
        for (const x of $$('input[name="cand"]')) {
          x.addEventListener("change", () => {
            $("#cand-error").textContent = "";
          });
        }
      },
    };
  }
  if (step === 2) {
    const c = SUPPORT_CANDIDATES.find((x) => x.id === s.picked);
    return {
      title: "收成一次尝试",
      nav: "explore",
      body: `${link("explore/support/1", `${icon("left")}换一条`, "back-link")}${progress}
      <div class="form-layout"><form novalidate>
        <section class="page-title" style="margin-bottom:22px"><h1>把它缩成一次很小的尝试。</h1></section>
        <div class="field"><label class="label" for="p-what">做什么（越小越好）</label><input class="input" id="p-what" value="${esc(c ? c.title : "我自己的做法")}"></div>
        <div class="field"><label class="label" for="p-when">在什么情境下</label><input class="input" id="p-when" value="${esc(s.plan.scene || "工作日上午，开始写报告之前")}"></div>
        <div class="field"><label class="label" for="p-watch">观察什么</label><input class="input" id="p-watch" value="多久之后真正开始；感觉是轻松还是勉强"></div>
        <fieldset><legend>什么时候回顾</legend><div class="chips">${["3 天后", "1 周后", "2 周后"].map((o, i) => `<label class="chip"><input type="radio" name="when" ${i === 1 ? "checked" : ""}>${icon("check")}${o}</label>`).join("")}</div></fieldset>
        <div class="field"><label class="label" for="p-stop">什么情况就停下</label><input class="input" id="p-stop" value="连续两次让我更焦虑"></div>
        <div class="form-footer"><span class="small muted">不会设置提醒或打卡。没做也是有效的记录。</span><button type="button" class="button primary" data-action="support-confirm">确认开始这次尝试</button></div>
      </form><aside class="aside-box"><section><h3>你可以随时</h3><p>暂停、修改或放弃这次尝试。没有执行不会被当作缺陷。</p></section><section><h3>结果会怎样被使用</h3><p>回顾时记下的情况，会作为你的经历，用来检查相关判断。</p></section></aside></div>`,
    };
  }
  return {
    title: "具体困难与可选调整",
    nav: "explore",
    body: `${link("explore", `${icon("left")}探索`, "back-link")}${progress}
    <div class="form-layout"><form class="support-form" novalidate>
      <section class="page-title" style="margin-bottom:22px"><h1>先说一件具体的事。</h1><p class="lead" style="font-size:16px">从你想改变的一件事出发。这里不推断诊断。</p></section>
      <div class="field"><label class="label" for="s-goal">希望这件事有什么变化</label><input class="input" id="s-goal" placeholder="比如：更容易开始写周报" value="${esc(s.plan.goal || "")}"></div>
      <div class="field"><label class="label" for="s-scene">通常发生在什么场景</label><input class="input" id="s-scene" placeholder="比如：在家处理邮件" value="${esc(s.plan.scene || "")}"></div>
      <div class="field" id="stuck-field"><label class="label" for="s-stuck">具体卡在哪里</label><textarea id="s-stuck" style="min-height:110px">${esc(s.plan.stuck || "")}</textarea><p class="error" id="stuck-error" aria-live="polite"></p></div>
      <fieldset><legend>最接近的困难（可多选，可不选）</legend><div class="chips">${DIFFICULTIES.map((d) => `<label class="chip"><input type="checkbox" name="diff" value="${d}" ${s.chips.includes(d) ? "checked" : ""}>${icon("check")}${d}</label>`).join("")}</div></fieldset>
      <details class="relation" style="margin-bottom:24px"><summary><div><span>关于诊断的自述（可跳过）</span><small>只用于理解背景，不会据此判断你</small></div>${icon("down")}</summary><div style="padding:18px 22px"><div class="chips">${["不填写", "已有诊断", "自己怀疑过", "没有"].map((o, i) => `<label class="chip"><input type="radio" name="dx" ${i === 0 ? "checked" : ""}>${icon("check")}${o}</label>`).join("")}</div></div></details>
      <fieldset><legend>以下情况是否适用（可不选）</legend><div class="choices"><label class="choice"><input type="checkbox" data-action="support-safety" value="urgent"><span>现在需要紧急帮助</span></label><label class="choice"><input type="checkbox" data-action="support-safety" value="clinical"><span>我需要诊断或治疗判断</span></label></div></fieldset>
      <div id="safety"></div>
      <div class="form-footer"><span class="small muted">可以只保存情境，不接受任何建议。</span><button type="button" class="button primary" data-action="support-next">看看可选的调整</button></div>
    </form><aside class="aside-box"><section><h3>建议从哪里来</h3><p>每条建议同时需要“和你的情境有关”与“已发布的方法内容”两种依据，缺一条就不提出。</p></section></aside></div>`,
  };
}
ACTIONS["support-safety"] = () => {
  const urgent = $('input[value="urgent"]').checked;
  const clinical = $('input[value="clinical"]').checked;
  $("#safety").innerHTML =
    `${urgent ? `<div class="banner danger">${icon("alert")}<div class="copy"><h3>如果你现在有危险</h3><p>请联系当地急救电话，或身边可以信任的人。FindMe 不是紧急服务，不能及时回应。</p></div></div>` : ""}${clinical ? `<div class="banner">${icon("shield")}<div class="copy"><p>FindMe 不做诊断或治疗判断。需要时，可以找精神科或心理专业人员评估；这里仍可以帮你整理具体情境。</p></div></div>` : ""}`;
};
ACTIONS["support-next"] = () => {
  const s = state.support;
  s.plan.goal = $("#s-goal").value.trim();
  s.plan.scene = $("#s-scene").value.trim();
  s.plan.stuck = $("#s-stuck").value.trim();
  s.chips = $$('input[name="diff"]:checked').map((x) => x.value);
  if (!s.plan.stuck) {
    $("#stuck-field").classList.add("invalid");
    $("#stuck-error").textContent = "说一说卡在哪里，建议才能贴近你的情况。";
    $("#s-stuck").focus();
    return;
  }
  save();
  go("explore/support/1");
};
ACTIONS["support-pick"] = () => {
  const v = $('input[name="cand"]:checked')?.value;
  if (!v) {
    $("#cand-error").textContent = "先选一条，或者选“都不合适”。";
    return;
  }
  state.support.picked = v;
  save();
  go("explore/support/2");
};
ACTIONS["support-none"] = () => {
  toast("已记下：这些都不合适。情境已保存");
  go("explore");
};
ACTIONS["support-own"] = () => {
  state.support.picked = null;
  save();
  go("explore/support/2");
};
ACTIONS["support-confirm"] = () => {
  const t = {
    id: `t${Date.now()}`,
    title: $("#p-what").value.trim() || "一次小尝试",
    status: "active",
    started: "10月27日",
    review: "11月3日",
    topic: "work",
  };
  state.trials.unshift(t);
  state.support = { step: 0, chips: [], picked: null, plan: {} };
  save();
  toast("尝试已开始，回顾时间到了也不会催你");
  go(`explore/trial/${t.id}`);
};

/* 18 我的尝试 */
function trialsList() {
  const groups = [
    ["进行中", state.trials.filter((t) => t.status === "active")],
    ["已结束", state.trials.filter((t) => t.status !== "active")],
  ];
  return {
    title: "我的尝试",
    nav: "explore",
    body: `${link("explore", `${icon("left")}探索`, "back-link")}
    <section class="page-title"><h1>我的尝试</h1><p class="lead">每个尝试都可以暂停、调整或结束。没做也可以记录下来，不评分。</p></section>
    ${groups.map(([g, list]) => `<section class="section"><div class="section-heading"><h2>${g}</h2><span class="small">${list.length} 个</span></div>${list.length ? `<div class="list">${list.map((t) => link(`explore/trial/${t.id}`, `${icon("flag", "lead-icon")}<div class="grow"><h3>${esc(t.title)}</h3><p>开始于 ${t.started}${t.status === "active" ? ` · 计划 ${t.review} 回顾` : ` · ${esc(t.result || "已结束")}`}</p></div>${icon("right", "chev")}`, "row")).join("")}</div>` : `<div class="empty"><p>${g === "进行中" ? "没有进行中的尝试。" : "还没有结束的尝试。"}</p></div>`}</section>`).join("")}`,
  };
}
function trialDetail(r) {
  const t = state.trials.find((x) => x.id === r.b) || state.trials[0];
  if (!t) return trialsList();
  return {
    title: t.title,
    nav: "explore",
    body: `${link("explore/trials", `${icon("left")}我的尝试`, "back-link")}
    <div class="form-layout"><div>
      <div class="meta">${t.status === "active" ? tag("进行中", "current") : tag("已结束")}<span>开始于 ${t.started}</span></div>
      <h1 style="font-size:clamp(28px,3vw,40px)">${esc(t.title)}</h1>
      <dl class="cost-table" style="margin-top:22px"><dt>情境</dt><dd>工作日上午，开始写报告之前</dd><dt>观察</dt><dd>多久之后真正开始；感觉是轻松还是勉强</dd><dt>回顾</dt><dd>${t.review}</dd><dt>停下的条件</dt><dd>连续两次让我更焦虑</dd></dl>
      ${
        t.status === "active"
          ? `<form class="section" novalidate><h2 style="font-size:22px;margin-bottom:16px">回顾一下</h2>
        <fieldset><legend>实际情况</legend><div class="chips">${["做了", "做了一部分", "没有做", "先暂停"].map((o) => `<label class="chip"><input type="radio" name="did" value="${o}">${icon("check")}${o}</label>`).join("")}</div><p class="hint">没做也是有用的信息，不代表你做得不好。</p></fieldset>
        <div class="field"><label class="label" for="saw">看到了什么、感觉怎样</label><textarea id="saw" style="min-height:110px"></textarea></div>
        <fieldset><legend>接下来</legend><div class="chips">${["继续", "调整一下", "结束这个尝试"].map((o) => `<label class="chip"><input type="radio" name="next" value="${o}">${icon("check")}${o}</label>`).join("")}</div></fieldset>
        <div class="form-footer"><span class="small muted">保存后，相关的“工作与投入”判断会标为待复核。</span><button type="button" class="button primary" data-action="trial-save" data-id="${t.id}">保存回顾</button></div>
        <p class="error" id="trial-error" aria-live="polite"></p></form>`
          : `<div class="banner ok" style="margin-top:24px">${icon("check")}<div class="copy"><p>回顾已保存：${esc(t.result || "")}</p></div></div>`
      }
    </div><aside class="aside-box"><section><h3>这个尝试从哪里来</h3><p>来自“具体困难与可选调整”。个人依据：你说卡在不知道从哪开始。</p></section><section><h3>关联的认识</h3><p>工作与投入：目标明确时更容易投入。</p>${link("topic/work", "阅读专题", "text-button")}</section></aside></div>`,
  };
}
ACTIONS["trial-save"] = (el) => {
  const did = $('input[name="did"]:checked')?.value;
  const next = $('input[name="next"]:checked')?.value;
  if (!did) {
    $("#trial-error").textContent = "先选一下实际情况。";
    return;
  }
  const t = state.trials.find((x) => x.id === el.dataset.id);
  t.result = `${did}${next ? `，${next}` : ""}`;
  if (next === "结束这个尝试" || did === "先暂停") t.status = "ended";
  save();
  toast("回顾已保存");
  render();
};


/* 日常聊天原型：复用原型状态与路由，不接入正式接口。 */
function chatSessions() {
  if (!state.chats) state.chats = [
    {id:"project", title:"周五的项目，要不要接？", messages:[
      {role:"user",text:"朋友邀我周五接一个品牌拍摄项目。题材有意思，但只说拍一天，没讲清楚后期改几轮。我想接，又怕整个周末都搭进去。"},
      {role:"assistant",html:"<p>你犹豫的地方，似乎不是项目有没有吸引力，而是<strong>答应一天，会不会连带答应一个没有边界的周末</strong>。</p><p>这两件事可以分开看：</p><ul><li><strong>想接：</strong>你明确说题材有意思，这部分兴趣有依据。</li><li><strong>担心：</strong>后期修改次数还没说清，投入多少时间确实未知。但目前也不能认定朋友一定会不断加要求。</li></ul><p>所以，比起现在就选接或不接，更有用的是先弄清这次承诺的范围。你不必为了保留兴趣，连不确定的部分也一起答应。</p><blockquote>这里只针对这次合作，不代表你一贯不善于拒绝。</blockquote>"}
    ]},
    {id:"weekend",title:"一个没有安排的周末",messages:[{role:"user",text:"这个周末没有安排。我有点期待，也有点不知道怎么过，先不用帮我列计划。"},{role:"assistant",html:"<p>期待和不知道怎么过可以同时存在。你现在还不需要把空闲填满，也不用马上决定怎样才算过得值得。</p><p>我们可以先留在这种感觉里，等你想多说一点时再接着聊。</p>"}]}
  ];
  return state.chats;
}
function chatComposer(id, home=false) {
  const t=chatSessions().find(t=>t.id===id);
  return `<div class="daily-composer ${home?'home-composer':''}"><label class="sr-only" for="chat-draft">${home?'聊件新的':'接着说'}</label><textarea id="chat-draft" rows="${home?3:2}" placeholder="${home?'说一件现在在意的事……':'接着说，也可以直接纠正我……'}" oninput="state.drafts['chat-${id}']=this.value;save()">${esc(state.drafts['chat-'+id]||'')}</textarea><div class="composer-foot"><span class="small muted">${home?'不用先整理好再说':'Shift + Enter 换行 · 按发送提交'}</span><button class="button primary" data-action="chat-send" data-id="${id}" ${t?.status==='waiting'?'disabled':''}>发送 ↑</button></div></div>`;
}
VIEWS.chat = r => {
  const sessions=chatSessions(); const id=r.a||'new'; const t=sessions.find(t=>t.id===id);
  return {title:t?.title||"聊件新的",nav:"home",body:`<div class="daily-chat-layout"><aside class="talk-sidebar">${link('chat/new','＋ 聊件新的','button quiet')}<h2>最近对话</h2>${sessions.map(s=>link('chat/'+s.id,esc(s.title),s.id===id?'talk-link selected':'talk-link')).join('')}${link('home','← 回到首页','text-button')}</aside><section class="daily-chat"><header class="talk-heading"><div>${link('home','← 首页','text-button small')}<h1>${esc(t?.title||'聊件新的')}</h1></div><details><summary aria-label="对话选项">更多</summary><button class="button quiet small" data-action="chat-understanding">更新认识</button></details></header>
    <div class="talk-messages" aria-live="polite">${!t?'<div class="chat-empty"><h2>从你想说的开始。</h2><p class="muted">不必先选主题，也不必马上找到答案。</p></div>':t.messages.map(m=>`<article class="talk-message ${m.role}"><span class="speaker">${m.role==='user'?'你':'FindMe'}</span><div>${m.html||'<p>'+esc(m.text)+'</p>'}</div></article>`).join('')}
    ${t?.status==='waiting'?'<div class="reply-state" role="status">正在回应，刚才的话已保存在此原型中。<button class="text-button" data-action="chat-finish" data-id="'+id+'">查看示例回应</button></div>':''}
    ${t?.status==='failed'?'<div class="reply-state failed" role="alert">这次没有收到回应，你的话还在。<button class="button quiet small" data-action="chat-retry" data-id="'+id+'">重新回应</button></div>':''}
    ${t?.updated?'<details class="chat-change"><summary>这次更新了 1 条认识 · 示例</summary><p>在这次拍摄合作中，你希望先明确修改次数和交付范围，再决定是否承接。</p><p class="muted">依据：本对话首条原话。适用范围仅为这次合作。</p><p>这是设计示例，不是根据新输入生成的认识。</p></details>':''}</div>
    ${chatComposer(id)}<details class="chat-demo-controls"><summary>试看其他状态 · 仅原型</summary><div class="actions"><button class="button quiet small" data-action="chat-wait" data-id="${id}">等待回应</button><button class="button quiet small" data-action="chat-fail" data-id="${id}">回应失败</button><button class="button quiet small" data-action="chat-change" data-id="${id}">认识变化</button></div><p class="small muted">所有回应是预设示例，不分析你的输入。</p></details>
    </section></div>`};
};
ACTIONS['chat-send']=el=>{
 const text=$('#chat-draft').value.trim();if(!text)return;
 let t=chatSessions().find(t=>t.id===el.dataset.id);
 if(!t){t={id:'local-'+Date.now(),title:text.slice(0,24),messages:[]};state.chats.unshift(t);}
 t.messages.push({role:'user',text});t.status='waiting';state.drafts['chat-'+el.dataset.id]='';save();go('chat/'+t.id);
};
ACTIONS['chat-finish']=el=>{const t=chatSessions().find(t=>t.id===el.dataset.id);if(!t||t.status!=='waiting')return;t.messages.push({role:'assistant',html:'<p><strong>这是一条预设回应，用来试读对话排版。</strong></p><p>正式接入后，这里会根据你的消息回应；本原型没有调用模型，也不会把刚才的输入写入 FindMe。</p><p>你可以再发一条消息，或者切到另一段对话后回来。</p>'});t.status=null;save();render();};
for (const [name,status] of [['chat-wait','waiting'],['chat-fail','failed'],['chat-retry','waiting']]) ACTIONS[name]=el=>{const t=chatSessions().find(t=>t.id===el.dataset.id);if(!t){toast('先发送一条消息，再试这个状态');return;}t.status=status;save();render();};
ACTIONS['chat-change']=el=>{const t=chatSessions().find(t=>t.id===el.dataset.id);if(!t)return;t.updated=!t.updated;save();render();};
ACTIONS['chat-understanding']=()=>openDialog('#modal',`${dialogHead('按需整理这段对话')}<div class="dialog-body"><p>日常聊天会保留原话，不必每次都更新认识。</p><p>这里预览主动整理的入口，原型不会生成或修改认识。</p><button class="button primary" data-action="close-dialog">回到对话</button></div>`);
