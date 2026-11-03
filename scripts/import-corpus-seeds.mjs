#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const DEFAULT_CORPUS = path.join(
  process.env.DATA_ROOT ?? path.join(repoRoot, "data"),
  "findme-corpus",
);
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const requireReady = args.includes("--require-ready");
const minMaterials = numberAfter("--min-materials");
const minQuestionnaires = numberAfter("--min-questionnaires");
const minLinkedMaterials = numberAfter("--min-linked-materials");
const minTheoryQuestionnaires = numberAfter("--min-theory-questionnaires");
const requiredMaterialTypes = listAfter("--require-material-types");
const requireLinkIntegrity = args.includes("--require-link-integrity");
const corpusArg = valueAfter("--corpus") ?? process.env.FINDME_CORPUS_ROOT ?? DEFAULT_CORPUS;
const corpusRoot = path.resolve(corpusArg);
const targetSeedDir =
  valueAfter("--target-seed-dir") ?? path.join(repoRoot, "apps/api/src/seed/data");

const MATERIAL_TYPES = ["concept", "figure", "book"];
const CONFIDENCE_VALUES = ["high_consensus", "common_framework", "contested", "philosophy_lens"];
const LICENSE_STATUS_VALUES = [
  "public_domain",
  "open_access",
  "official_public_page",
  "user_owned",
  "metadata_only",
  "unknown_do_not_use",
];
const REVIEW_STATUS_VALUES = ["content_ready", "draft_ready", "needs_review", "do_not_use"];
const QUESTION_FORMATS = ["single_choice", "multi_choice", "likert_scale", "free_text", "boolean"];
const EXPORT_MANIFEST_READY_STATUS = ["ready", "content_ready", "export_ready"];
const BAD_TEXT_PATTERNS = [
  /占位/,
  /正式内容待补/,
  /测试正文/,
  /TODO/i,
  /not product copy/i,
  /needs review/i,
];
const BAD_PROMPT_PATTERNS = [/当我用「[A-Za-z'-]{3,}」看自己最近的一次反应时/];

const materialsPath = path.join(corpusRoot, "exports/materials.seed.json");
const questionnairesPath = path.join(corpusRoot, "exports/questionnaires.seed.json");
const manifestPath = path.join(corpusRoot, "exports/corpus-manifest.json");
const targetMaterials = path.join(targetSeedDir, "materials.json");
const targetQuestionnaires = path.join(targetSeedDir, "questionnaires.json");

const corpusManifest = readCorpusManifest(manifestPath);
const materialExport = readExport(materialsPath);
const questionnaireExport = readExport(questionnairesPath);
const materialItems = pickReady(materialExport.items ?? [], "material", normalizeMaterial);
const questionnaireItems = pickReady(
  questionnaireExport.items ?? [],
  "questionnaire",
  normalizeQuestionnaire,
);
validateCorpusManifest(corpusManifest, materialItems, questionnaireItems);

console.log(`corpus: ${corpusRoot}`);
console.log(`target seed: ${targetSeedDir}`);
console.log(`materials: ${materialItems.length} content_ready`);
console.log(`questionnaires: ${questionnaireItems.length} content_ready`);

const readyCount = materialItems.length + questionnaireItems.length;
if (requireReady && readyCount === 0) {
  throw new Error("No content_ready corpus exports; readiness gate failed.");
}
validateReadinessBaseline(materialItems, questionnaireItems);

if (!apply) {
  if (requireReady) {
    console.log("readiness gate passed: content_ready exports are importable.");
  } else {
    console.log("check only: pass --apply to merge content_ready exports into repo seed JSON.");
  }
  process.exit(0);
}

if (readyCount === 0) {
  throw new Error("No content_ready corpus exports to import; refusing to rewrite seed JSON.");
}

if (materialItems.length > 0) {
  const current = readJson(targetMaterials);
  writeJson(targetMaterials, upsertBy(current, materialItems, "title"));
}
if (questionnaireItems.length > 0) {
  const current = readJson(targetQuestionnaires);
  writeJson(targetQuestionnaires, upsertBy(current, questionnaireItems, "name"));
}

console.log("import complete");

function valueAfter(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function numberAfter(flag) {
  const raw = valueAfter(flag);
  if (raw == null) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function listAfter(flag) {
  const raw = valueAfter(flag);
  if (raw == null || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readExport(file) {
  if (!existsSync(file)) throw new Error(`Missing corpus export: ${file}`);
  const data = readJson(file);
  if (!Array.isArray(data.items)) throw new Error(`${file} must contain an items array`);
  if (data.status === "placeholder") {
    console.log(`${path.basename(file)} is placeholder: ${data.reason ?? "not ready"}`);
  }
  return data;
}

function readCorpusManifest(file) {
  if (!existsSync(file)) return null;
  const data = readJson(file);
  if (data.status === "placeholder") {
    console.log(`${path.basename(file)} is placeholder: ${data.reason ?? "not ready"}`);
  }
  return data;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function pickReady(items, kind, normalize) {
  return items
    .map((item, index) => {
      const status = item.reviewStatus ?? item.review_status ?? item.status;
      if (status !== "content_ready") return null;
      try {
        return normalize(item);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${kind} export item ${index} is invalid: ${message}`);
      }
    })
    .filter(Boolean);
}

function validateCorpusManifest(manifest, materialItems, questionnaireItems) {
  const readyItems = [...materialItems, ...questionnaireItems];
  if (readyItems.length === 0) return;

  if (!manifest) throw new Error("Missing exports/corpus-manifest.json for content_ready imports");
  if (!EXPORT_MANIFEST_READY_STATUS.includes(manifest.status)) {
    throw new Error(
      `corpus-manifest status must be one of: ${EXPORT_MANIFEST_READY_STATUS.join(", ")}`,
    );
  }
  if (typeof manifest.generated_at !== "string" || manifest.generated_at.trim() === "") {
    throw new Error("corpus-manifest generated_at is required");
  }
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) {
    throw new Error("corpus-manifest items must list exported source coverage");
  }

  const manifestReadyCount = manifest.content_ready_count ?? manifest.summary?.content_ready_count;
  if (manifestReadyCount != null && manifestReadyCount !== readyItems.length) {
    throw new Error(
      `corpus-manifest content_ready_count ${manifestReadyCount} does not match ${readyItems.length} importable items`,
    );
  }

  const manifestSourceIds = collectManifestSourceIds(manifest.items);
  const missing = [...new Set(readyItems.map((item) => item.sourceId))].filter(
    (sourceId) => !manifestSourceIds.has(sourceId),
  );
  if (missing.length > 0) {
    throw new Error(`corpus-manifest missing source coverage: ${missing.join(", ")}`);
  }
}

function validateReadinessBaseline(materialItems, questionnaireItems) {
  if (minMaterials != null && materialItems.length < minMaterials) {
    throw new Error(
      `readiness baseline failed: materials ${materialItems.length} < required ${minMaterials}`,
    );
  }
  if (minQuestionnaires != null && questionnaireItems.length < minQuestionnaires) {
    throw new Error(
      `readiness baseline failed: questionnaires ${questionnaireItems.length} < required ${minQuestionnaires}`,
    );
  }
  if (minLinkedMaterials != null) {
    const linkedCount = materialItems.filter(
      (item) => item.linkedQuestionnaires?.length > 0,
    ).length;
    if (linkedCount < minLinkedMaterials) {
      throw new Error(
        `readiness baseline failed: linked materials ${linkedCount} < required ${minLinkedMaterials}`,
      );
    }
  }
  if (minTheoryQuestionnaires != null) {
    const theoryCount = questionnaireItems.filter((item) => item.type === "theory").length;
    if (theoryCount < minTheoryQuestionnaires) {
      throw new Error(
        `readiness baseline failed: theory questionnaires ${theoryCount} < required ${minTheoryQuestionnaires}`,
      );
    }
  }
  if (requiredMaterialTypes.length > 0) {
    for (const type of requiredMaterialTypes) {
      oneOf(type, MATERIAL_TYPES, "--require-material-types");
    }
    const present = new Set(materialItems.map((item) => item.type));
    const missing = requiredMaterialTypes.filter((type) => !present.has(type));
    if (missing.length > 0) {
      throw new Error(`readiness baseline failed: missing material types ${missing.join(", ")}`);
    }
  }
  if (requireLinkIntegrity) validateLinkIntegrity(materialItems, questionnaireItems);
}

function validateLinkIntegrity(materialItems, questionnaireItems) {
  const knownQuestionnaires = new Set([
    ...readSeedArray(targetQuestionnaires).map((item) => item.name),
    ...questionnaireItems.map((item) => item.name),
  ]);
  const missing = [];
  for (const material of materialItems) {
    for (const questionnaireName of material.linkedQuestionnaires ?? []) {
      if (!knownQuestionnaires.has(questionnaireName)) {
        missing.push(`${material.title} -> ${questionnaireName}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `readiness baseline failed: broken material-questionnaire links: ${missing.join(", ")}`,
    );
  }
}

function readSeedArray(file) {
  if (!existsSync(file)) return [];
  const data = readJson(file);
  return Array.isArray(data) ? data : [];
}

function collectManifestSourceIds(items) {
  const ids = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      ids.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.source_id === "string") ids.add(value.source_id);
    if (typeof value.sourceId === "string") ids.add(value.sourceId);
    if (Array.isArray(value.source_ids)) {
      for (const id of value.source_ids) if (typeof id === "string") ids.add(id);
    }
    if (Array.isArray(value.sourceIds)) {
      for (const id of value.sourceIds) if (typeof id === "string") ids.add(id);
    }
    for (const key of ["sources", "materials", "questionnaires", "items"]) {
      if (Array.isArray(value[key])) value[key].forEach(visit);
    }
  };
  visit(items);
  return ids;
}

function normalizeMaterial(item) {
  const provenanceFields = provenance(item);
  const out = {
    type: oneOf(required(item.type, "type"), MATERIAL_TYPES, "type"),
    title: required(item.title, "title"),
    body: required(item.body, "body"),
    domain: required(item.domain, "domain"),
    lens: required(item.lens, "lens"),
    confidence: oneOf(required(item.confidence, "confidence"), CONFIDENCE_VALUES, "confidence"),
    hook: required(item.hook, "hook"),
    boundary: required(item.boundary, "boundary"),
    reflect: required(item.reflect ?? item.reflect_prompt, "reflect"),
    reflectPrompts: requiredArray(item.reflectPrompts ?? item.reflect_prompts, "reflectPrompts"),
    entryPrompt: required(item.entryPrompt ?? item.entry_prompt, "entryPrompt"),
    source: item.source ?? item.source_url,
    linkedQuestionnaires: item.linkedQuestionnaires ?? item.linked_questionnaires ?? [],
    ...provenanceFields,
  };
  const normalized = stripEmpty(out);
  assertProductMaterial(normalized);
  return normalized;
}

function normalizeQuestionnaire(item) {
  const provenanceFields = provenance(item);
  const out = {
    name: required(item.name, "name"),
    type: required(item.type, "type"),
    source: item.source ?? item.material_title,
    domain: item.domain,
    lens: item.lens,
    intro: item.intro,
    items: requiredArray(item.items, "items").map((q, index) => ({
      ...stripEmpty({
        itemKey: q.itemKey ?? q.item_key,
        prompt: required(q.prompt, `items[${index}].prompt`),
        format: oneOf(
          required(q.format, `items[${index}].format`),
          QUESTION_FORMATS,
          `items[${index}].format`,
        ),
        evidenceRefs: q.evidenceRefs ?? q.evidence_refs,
      }),
      options: Array.isArray(q.options) ? q.options : [],
    })),
    ...provenanceFields,
  };
  const normalized = stripEmpty(out);
  assertProductQuestionnaire(normalized);
  return normalized;
}

function provenance(item) {
  const reviewStatus = item.reviewStatus ?? item.review_status ?? item.status;
  const licenseStatus = item.licenseStatus ?? item.license_status;
  return {
    sourceId: item.sourceId ?? item.source_id,
    sourceUrl: item.sourceUrl ?? item.source_url,
    licenseStatus: licenseStatus
      ? oneOf(licenseStatus, LICENSE_STATUS_VALUES, "license_status")
      : undefined,
    usableScope: item.usableScope ?? item.usable_scope,
    evidenceRefs: item.evidenceRefs ?? item.evidence_refs,
    corpusGeneratedAt: item.corpusGeneratedAt ?? item.corpus_generated_at,
    reviewStatus: reviewStatus
      ? oneOf(reviewStatus, REVIEW_STATUS_VALUES, "review_status")
      : undefined,
  };
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function requiredArray(value, name) {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${name} must be a non-empty array`);
  return value;
}

function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return value;
}

function stripEmpty(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value == null) return false;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    }),
  );
}

function upsertBy(current, incoming, key) {
  const byKey = new Map(current.map((item) => [item[key], item]));
  for (const item of incoming) byKey.set(item[key], item);
  return [...byKey.values()];
}

function assertProductMaterial(item) {
  requireProvenance(item);
  if (item.body.length < 120) throw new Error("body is too short for product use");
  if (item.hook.length < 8) throw new Error("hook is too short for product use");
  if (item.boundary.length < 8) throw new Error("boundary is too short for product use");
  if (item.reflectPrompts.length < 2) throw new Error("reflectPrompts needs at least 2 prompts");
  assertCleanText([item.title, item.body, item.hook, item.boundary, item.entryPrompt]);
  assertCleanPrompts(item.reflectPrompts);
}

function assertProductQuestionnaire(item) {
  requireProvenance(item);
  if (typeof item.domain !== "string" || item.domain.length === 0)
    throw new Error("domain is required");
  if (typeof item.lens !== "string" || item.lens.length === 0) throw new Error("lens is required");
  if (typeof item.intro !== "string" || item.intro.length < 8)
    throw new Error("intro is too short for product use");
  if (item.items.length < 3) throw new Error("questionnaire needs at least 3 items");
  assertCleanText([item.name, item.intro]);
  assertCleanPrompts(item.items.map((q) => q.prompt));
}

function requireProvenance(item) {
  if (!item.sourceId) throw new Error("source_id is required for content_ready imports");
  if (!item.sourceUrl) throw new Error("source_url is required for content_ready imports");
  if (!item.licenseStatus) throw new Error("license_status is required for content_ready imports");
  if (!item.usableScope) throw new Error("usable_scope is required for content_ready imports");
  if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0)
    throw new Error("evidence_refs are required for content_ready imports");
  if (item.licenseStatus === "metadata_only" || item.licenseStatus === "unknown_do_not_use")
    throw new Error("license_status is not product-usable");
}

function assertCleanText(values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (BAD_TEXT_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error(`content contains non-product marker: ${value.slice(0, 40)}`);
    }
  }
}

function assertCleanPrompts(prompts) {
  for (const prompt of prompts) {
    if (BAD_TEXT_PATTERNS.some((pattern) => pattern.test(prompt))) {
      throw new Error(`prompt contains non-product marker: ${prompt.slice(0, 40)}`);
    }
    if (BAD_PROMPT_PATTERNS.some((pattern) => pattern.test(prompt))) {
      throw new Error(`prompt looks like raw keyword distill output: ${prompt.slice(0, 40)}`);
    }
  }
}
