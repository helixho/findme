import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(process.cwd(), "../..");
const script = path.join(repoRoot, "scripts/import-corpus-seeds.mjs");

describe("Corpus-to-Seed Bridge CLI", () => {
  it("只导入 content_ready exports 并规范化为 repo seed JSON", () => {
    const { corpus, seedDir } = makeWorkspace();
    writeSeed(seedDir);
    writeExport(corpus, "materials.seed.json", [
      {
        status: "content_ready",
        type: "concept",
        title: "语料卡:控制与判断",
        body: "斯多葛主义里一个适合自我观察的入口,是先区分事情本身和自己对事情的判断。它不是要你压掉情绪,也不是让你把痛苦都归咎于自己,而是提醒你:在反应冲上来之前,先看一眼这里有哪些部分真的由你决定,哪些只是你正在承担的想象压力。这个区分能把行动从反复消耗里拆出来。",
        domain: "我如何做选择",
        lens: "斯多葛主义",
        confidence: "philosophy_lens",
        hook: "什么在我控制内?",
        boundary: "这是哲学视角,用于自我省察,不是心理诊断或情绪压抑建议。",
        reflect_prompt: "这件事里什么在我控制内?",
        reflect_prompts: ["这件事里什么在我控制内?", "我正在把哪一部分当成自己的责任?"],
        entry_prompt: "这让我想到……",
        source_id: "stoicism_epictetus_gutenberg",
        source_url: "https://www.gutenberg.org/ebooks/45109",
        license_status: "public_domain",
        usable_scope: "full_text_local_allowed",
        evidence_refs: ["ch001#ck001"],
        linked_questionnaires: ["控制内外"],
      },
    ]);
    writeExport(corpus, "questionnaires.seed.json", [
      {
        status: "content_ready",
        name: "控制内外",
        type: "theory",
        material_title: "语料卡:控制与判断",
        domain: "我如何做选择",
        lens: "斯多葛主义",
        intro: "把一件正在牵动你的事拆开,看看哪些部分属于行动,哪些只是判断。",
        source_id: "stoicism_epictetus_gutenberg",
        source_url: "https://www.gutenberg.org/ebooks/45109",
        license_status: "public_domain",
        usable_scope: "full_text_local_allowed",
        evidence_refs: ["ch001#ck001"],
        items: [
          { item_key: "q1", prompt: "这件事里什么在你控制内?", format: "free_text", options: [] },
          {
            item_key: "q2",
            prompt: "什么部分你很想控制,但其实控制不了?",
            format: "free_text",
            options: [],
          },
          {
            item_key: "q3",
            prompt: "如果只做可控的一小步,那一步是什么?",
            format: "free_text",
            options: [],
          },
        ],
      },
    ]);
    writeManifest(corpus, {
      content_ready_count: 2,
      items: [
        { source_id: "stoicism_epictetus_gutenberg", exports: ["materials", "questionnaires"] },
      ],
    });

    execFileSync(process.execPath, [
      script,
      "--corpus",
      corpus,
      "--target-seed-dir",
      seedDir,
      "--apply",
    ]);

    const materials = readJson(path.join(seedDir, "materials.json"));
    const questionnaires = readJson(path.join(seedDir, "questionnaires.json"));
    expect(materials).toHaveLength(1);
    expect(materials[0]).toMatchObject({
      title: "语料卡:控制与判断",
      sourceId: "stoicism_epictetus_gutenberg",
      licenseStatus: "public_domain",
      reviewStatus: "content_ready",
      linkedQuestionnaires: ["控制内外"],
    });
    expect(questionnaires).toHaveLength(1);
    expect(questionnaires[0]).toMatchObject({
      name: "控制内外",
      source: "语料卡:控制与判断",
      sourceId: "stoicism_epictetus_gutenberg",
      reviewStatus: "content_ready",
    });
    expect(questionnaires[0].items[0]).toMatchObject({ itemKey: "q1", format: "free_text" });
  });

  it("content_ready exports 缺少交付 manifest 时会阻断导入", () => {
    const { corpus, seedDir } = makeWorkspace();
    writeSeed(seedDir);
    writeExport(corpus, "materials.seed.json", [
      {
        status: "content_ready",
        type: "concept",
        title: "语料卡:控制与判断",
        body: "斯多葛主义里一个适合自我观察的入口,是先区分事情本身和自己对事情的判断。它不是要你压掉情绪,也不是让你把痛苦都归咎于自己,而是提醒你:在反应冲上来之前,先看一眼这里有哪些部分真的由你决定,哪些只是你正在承担的想象压力。这个区分能把行动从反复消耗里拆出来。",
        domain: "我如何做选择",
        lens: "斯多葛主义",
        confidence: "philosophy_lens",
        hook: "什么在我控制内?",
        boundary: "这是哲学视角,用于自我省察,不是心理诊断或情绪压抑建议。",
        reflect: "这件事里什么在我控制内?",
        reflect_prompts: ["这件事里什么在我控制内?", "我正在把哪一部分当成自己的责任?"],
        entry_prompt: "这让我想到……",
        source_id: "stoicism_epictetus_gutenberg",
        source_url: "https://www.gutenberg.org/ebooks/45109",
        license_status: "public_domain",
        usable_scope: "full_text_local_allowed",
        evidence_refs: ["ch001#ck001"],
      },
    ]);
    writeExport(corpus, "questionnaires.seed.json", []);

    const res = spawnSync(
      process.execPath,
      [script, "--corpus", corpus, "--target-seed-dir", seedDir, "--apply"],
      { encoding: "utf8" },
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("Missing exports/corpus-manifest.json");
    expect(readJson(path.join(seedDir, "materials.json"))).toEqual([]);
  });

  it("corpus manifest 未覆盖 content_ready 来源时会阻断导入", () => {
    const { corpus, seedDir } = makeWorkspace();
    writeSeed(seedDir);
    writeExport(corpus, "materials.seed.json", [readyMaterial({ source_id: "source_a" })]);
    writeExport(corpus, "questionnaires.seed.json", []);
    writeManifest(corpus, {
      content_ready_count: 1,
      items: [{ source_id: "source_b", exports: ["materials"] }],
    });

    const res = spawnSync(
      process.execPath,
      [script, "--corpus", corpus, "--target-seed-dir", seedDir, "--apply"],
      { encoding: "utf8" },
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("corpus-manifest missing source coverage: source_a");
    expect(readJson(path.join(seedDir, "materials.json"))).toEqual([]);
  });

  it("require-ready 可只读证明 content_ready exports 已可导入", () => {
    const { corpus, seedDir } = makeWorkspace();
    writeSeed(seedDir);
    writeExport(corpus, "materials.seed.json", [readyMaterial()]);
    writeExport(corpus, "questionnaires.seed.json", []);
    writeManifest(corpus, {
      content_ready_count: 1,
      items: ["stoicism_epictetus_gutenberg"],
    });

    const res = spawnSync(
      process.execPath,
      [script, "--corpus", corpus, "--target-seed-dir", seedDir, "--require-ready"],
      { encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("readiness gate passed");
    expect(readJson(path.join(seedDir, "materials.json"))).toEqual([]);
  });

  it("require-ready 在没有 content_ready 时失败但不写 seed", () => {
    const { corpus, seedDir } = makeWorkspace();
    writeSeed(seedDir);
    writeExport(corpus, "materials.seed.json", [
      {
        status: "needs_review",
        type: "concept",
        title: "未审核卡片",
        body: "测试正文",
      },
    ]);
    writeExport(corpus, "questionnaires.seed.json", []);

    const res = spawnSync(
      process.execPath,
      [script, "--corpus", corpus, "--target-seed-dir", seedDir, "--require-ready"],
      { encoding: "utf8" },
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("readiness gate failed");
    expect(readJson(path.join(seedDir, "materials.json"))).toEqual([]);
  });

  it("require-ready baseline 会阻断未达到产品规模的 ready exports", () => {
    const { corpus, seedDir } = makeWorkspace();
    writeSeed(seedDir);
    writeExport(corpus, "materials.seed.json", [readyMaterial()]);
    writeExport(corpus, "questionnaires.seed.json", []);
    writeManifest(corpus, {
      content_ready_count: 1,
      items: ["stoicism_epictetus_gutenberg"],
    });

    const res = spawnSync(
      process.execPath,
      [
        script,
        "--corpus",
        corpus,
        "--target-seed-dir",
        seedDir,
        "--require-ready",
        "--min-materials",
        "2",
      ],
      { encoding: "utf8" },
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("readiness baseline failed: materials 1 < required 2");
    expect(readJson(path.join(seedDir, "materials.json"))).toEqual([]);
  });

  it("require-ready baseline 可验收材料类型覆盖且保持只读", () => {
    const { corpus, seedDir } = makeWorkspace();
    writeSeed(seedDir);
    writeExport(corpus, "materials.seed.json", [
      readyMaterial({ source_id: "source_concept", type: "concept", title: "概念卡" }),
      readyMaterial({ source_id: "source_figure", type: "figure", title: "人物卡" }),
      readyMaterial({ source_id: "source_book", type: "book", title: "书卡" }),
    ]);
    writeExport(corpus, "questionnaires.seed.json", []);
    writeManifest(corpus, {
      content_ready_count: 3,
      items: ["source_concept", "source_figure", "source_book"],
    });

    const res = spawnSync(
      process.execPath,
      [
        script,
        "--corpus",
        corpus,
        "--target-seed-dir",
        seedDir,
        "--require-ready",
        "--min-materials",
        "3",
        "--require-material-types",
        "concept,figure,book",
      ],
      { encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("readiness gate passed");
    expect(readJson(path.join(seedDir, "materials.json"))).toEqual([]);
  });

  it("require-ready link integrity 会阻断指向不存在题组的材料", () => {
    const { corpus, seedDir } = makeWorkspace();
    writeSeed(seedDir);
    writeExport(corpus, "materials.seed.json", [
      readyMaterial({ linked_questionnaires: ["不存在的题组"] }),
    ]);
    writeExport(corpus, "questionnaires.seed.json", []);
    writeManifest(corpus, {
      content_ready_count: 1,
      items: ["stoicism_epictetus_gutenberg"],
    });

    const res = spawnSync(
      process.execPath,
      [
        script,
        "--corpus",
        corpus,
        "--target-seed-dir",
        seedDir,
        "--require-ready",
        "--require-link-integrity",
      ],
      { encoding: "utf8" },
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("broken material-questionnaire links");
    expect(readJson(path.join(seedDir, "materials.json"))).toEqual([]);
  });

  it("require-ready baseline 可验收阅读到题组的闭环", () => {
    const { corpus, seedDir } = makeWorkspace();
    writeSeed(seedDir);
    writeExport(corpus, "materials.seed.json", [
      readyMaterial({ linked_questionnaires: ["控制内外"] }),
    ]);
    writeExport(corpus, "questionnaires.seed.json", [readyQuestionnaire()]);
    writeManifest(corpus, {
      content_ready_count: 2,
      items: ["stoicism_epictetus_gutenberg"],
    });

    const res = spawnSync(
      process.execPath,
      [
        script,
        "--corpus",
        corpus,
        "--target-seed-dir",
        seedDir,
        "--require-ready",
        "--min-linked-materials",
        "1",
        "--min-theory-questionnaires",
        "1",
        "--require-link-integrity",
      ],
      { encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("readiness gate passed");
    expect(readJson(path.join(seedDir, "materials.json"))).toEqual([]);
    expect(readJson(path.join(seedDir, "questionnaires.json"))).toEqual([]);
  });

  it("needs_review exports 不会被 apply 写入 seed", () => {
    const { corpus, seedDir } = makeWorkspace();
    writeSeed(seedDir);
    writeExport(corpus, "materials.seed.json", [
      {
        status: "needs_review",
        type: "concept",
        title: "未审核卡片",
        body: "测试正文",
        domain: "我如何做选择",
        lens: "测试",
        confidence: "common_framework",
        hook: "hook",
        boundary: "boundary",
        reflect: "reflect",
        reflect_prompts: ["reflect"],
        entry_prompt: "entry",
      },
    ]);
    writeExport(corpus, "questionnaires.seed.json", []);
    writeManifest(corpus, {
      content_ready_count: 1,
      items: [{ source_id: "bad_source", exports: ["materials"] }],
    });

    const res = spawnSync(
      process.execPath,
      [script, "--corpus", corpus, "--target-seed-dir", seedDir, "--apply"],
      { encoding: "utf8" },
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("No content_ready corpus exports");
    expect(readJson(path.join(seedDir, "materials.json"))).toEqual([]);
    expect(readJson(path.join(seedDir, "questionnaires.json"))).toEqual([]);
  });

  it("低质 content_ready 仍会被产品级质量门拦截", () => {
    const { corpus, seedDir } = makeWorkspace();
    writeSeed(seedDir);
    writeExport(corpus, "materials.seed.json", [
      {
        status: "content_ready",
        type: "concept",
        title: "粗糙语料卡",
        body: "这是一段长度足够但没有经过产品打磨的占位内容。它模拟机器粗筛输出被误标为可上线的情况,导入脚本应该在进入 seed 前阻断,避免探索页出现未完成内容。即使字段齐全、状态也被写成 content_ready,只要正文还残留非产品标记,就不能进入探索页或参与用户反馈回流。",
        domain: "我如何做选择",
        lens: "测试",
        confidence: "common_framework",
        hook: "这个 hook 足够长",
        boundary: "这是一个边界说明,但正文里含有非产品标记。",
        reflect: "当我用「said」看自己最近的一次反应时，我会注意到什么？",
        reflect_prompts: [
          "当我用「said」看自己最近的一次反应时，我会注意到什么？",
          "我还能怎么描述这件事?",
        ],
        entry_prompt: "这让我想到……",
        source_id: "bad_source",
        source_url: "https://example.com",
        license_status: "public_domain",
        usable_scope: "full_text_local_allowed",
        evidence_refs: ["ch001#ck001"],
      },
    ]);
    writeExport(corpus, "questionnaires.seed.json", []);

    const res = spawnSync(
      process.execPath,
      [script, "--corpus", corpus, "--target-seed-dir", seedDir, "--apply"],
      { encoding: "utf8" },
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("non-product marker");
    expect(readJson(path.join(seedDir, "materials.json"))).toEqual([]);
  });
});

function makeWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "findme-corpus-import-"));
  const corpus = path.join(root, "corpus");
  const seedDir = path.join(root, "seed");
  mkdirSync(path.join(corpus, "exports"), { recursive: true });
  mkdirSync(seedDir, { recursive: true });
  return { corpus, seedDir };
}

function writeSeed(seedDir: string) {
  writeFileSync(path.join(seedDir, "materials.json"), "[]\n");
  writeFileSync(path.join(seedDir, "questionnaires.json"), "[]\n");
}

function writeExport(corpus: string, name: string, items: unknown[]) {
  writeFileSync(
    path.join(corpus, "exports", name),
    `${JSON.stringify({ generated_at: "test", status: "ready", items }, null, 2)}\n`,
  );
}

function writeManifest(corpus: string, payload: Record<string, unknown>) {
  writeFileSync(
    path.join(corpus, "exports", "corpus-manifest.json"),
    `${JSON.stringify({ generated_at: "test", status: "ready", ...payload }, null, 2)}\n`,
  );
}

function readyMaterial(overrides: Record<string, unknown> = {}) {
  return {
    status: "content_ready",
    type: "concept",
    title: "语料卡:控制与判断",
    body: "斯多葛主义里一个适合自我观察的入口,是先区分事情本身和自己对事情的判断。它不是要你压掉情绪,也不是让你把痛苦都归咎于自己,而是提醒你:在反应冲上来之前,先看一眼这里有哪些部分真的由你决定,哪些只是你正在承担的想象压力。这个区分能把行动从反复消耗里拆出来。",
    domain: "我如何做选择",
    lens: "斯多葛主义",
    confidence: "philosophy_lens",
    hook: "什么在我控制内?",
    boundary: "这是哲学视角,用于自我省察,不是心理诊断或情绪压抑建议。",
    reflect: "这件事里什么在我控制内?",
    reflect_prompts: ["这件事里什么在我控制内?", "我正在把哪一部分当成自己的责任?"],
    entry_prompt: "这让我想到……",
    source_id: "stoicism_epictetus_gutenberg",
    source_url: "https://www.gutenberg.org/ebooks/45109",
    license_status: "public_domain",
    usable_scope: "full_text_local_allowed",
    evidence_refs: ["ch001#ck001"],
    ...overrides,
  };
}

function readyQuestionnaire(overrides: Record<string, unknown> = {}) {
  return {
    status: "content_ready",
    name: "控制内外",
    type: "theory",
    material_title: "语料卡:控制与判断",
    domain: "我如何做选择",
    lens: "斯多葛主义",
    intro: "把一件正在牵动你的事拆开,看看哪些部分属于行动,哪些只是判断。",
    source_id: "stoicism_epictetus_gutenberg",
    source_url: "https://www.gutenberg.org/ebooks/45109",
    license_status: "public_domain",
    usable_scope: "full_text_local_allowed",
    evidence_refs: ["ch001#ck001"],
    items: [
      { item_key: "q1", prompt: "这件事里什么在你控制内?", format: "free_text", options: [] },
      {
        item_key: "q2",
        prompt: "什么部分你很想控制,但其实控制不了?",
        format: "free_text",
        options: [],
      },
      {
        item_key: "q3",
        prompt: "如果只做可控的一小步,那一步是什么?",
        format: "free_text",
        options: [],
      },
    ],
    ...overrides,
  };
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}
