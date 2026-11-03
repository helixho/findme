import { type Db, schema } from "@findme/db";
import { eq } from "drizzle-orm";
import seedData from "./data/materials.json";
import { SeedMaterial as SeedMaterialSchema } from "./schema.js";

// 学习素材(M-B0)。material_type 即栏目:concept(概念与体系)/ figure(人物)/ book(书)。
// V1.3 起内容事实源迁到 JSON;TS 只负责校验、upsert 和 provenance 映射。
export const MATERIAL_SEED = SeedMaterialSchema.array().parse(seedData);
export type SeedMaterial = (typeof MATERIAL_SEED)[number];

export async function seedMaterials(
  db: Db,
  seeds: SeedMaterial[] = MATERIAL_SEED,
): Promise<number> {
  let inserted = 0;
  for (const m of seeds) {
    const meta = {
      domain: m.domain,
      lens: m.lens,
      confidence: m.confidence,
      hook: m.hook,
      boundary: m.boundary,
      reflect_prompt: m.reflect,
      reflect_prompts: m.reflectPrompts,
      entry_prompt: m.entryPrompt,
      ...(m.source ? { source_url: m.source } : {}),
      ...(m.sourceUrl ? { source_url: m.sourceUrl } : {}),
      ...(m.sourceId ? { source_id: m.sourceId } : {}),
      ...(m.licenseStatus ? { license_status: m.licenseStatus } : {}),
      ...(m.usableScope ? { usable_scope: m.usableScope } : {}),
      ...(m.evidenceRefs ? { evidence_refs: m.evidenceRefs } : {}),
      ...(m.corpusGeneratedAt ? { corpus_generated_at: m.corpusGeneratedAt } : {}),
      ...(m.reviewStatus ? { review_status: m.reviewStatus } : {}),
    };
    const linkedRefs = m.linkedQuestionnaires?.length
      ? { questionnaire_names: m.linkedQuestionnaires }
      : {};
    const exists = await db
      .select({ id: schema.staticMaterials.id })
      .from(schema.staticMaterials)
      .where(eq(schema.staticMaterials.title, m.title))
      .limit(1);
    const existing = exists[0];
    if (existing) {
      await db
        .update(schema.staticMaterials)
        .set({ materialType: m.type, body: m.body, meta, linkedRefs })
        .where(eq(schema.staticMaterials.id, existing.id));
      continue;
    }
    await db.insert(schema.staticMaterials).values({
      materialType: m.type,
      title: m.title,
      body: m.body,
      linkedRefs,
      meta,
    });
    inserted++;
  }
  return inserted;
}
