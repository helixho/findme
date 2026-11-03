import { type Db, schema } from "@findme/db";
import { eq } from "drizzle-orm";
import seedData from "./data/questionnaires.json";
import { SeedQuestionnaire as SeedQuestionnaireSchema } from "./schema.js";

// M-A2 题库。V1.3 起内容事实源迁到 JSON;TS 只负责校验、upsert 和题目同步。
export const QUESTIONNAIRE_SEED = SeedQuestionnaireSchema.array().parse(seedData);
export type SeedQuestionnaire = (typeof QUESTIONNAIRE_SEED)[number];

export async function seedQuestionnaires(
  db: Db,
  seeds: SeedQuestionnaire[] = QUESTIONNAIRE_SEED,
): Promise<number> {
  let inserted = 0;
  for (const q of seeds) {
    const exists = await db
      .select({ id: schema.questionnaires.id })
      .from(schema.questionnaires)
      .where(eq(schema.questionnaires.name, q.name))
      .limit(1);
    const sourceMeta = {
      ...(q.source ? { material_title: q.source } : {}),
      ...(q.domain ? { domain: q.domain } : {}),
      ...(q.lens ? { lens: q.lens } : {}),
      ...(q.sourceId ? { source_id: q.sourceId } : {}),
      ...(q.sourceUrl ? { source_url: q.sourceUrl } : {}),
      ...(q.licenseStatus ? { license_status: q.licenseStatus } : {}),
      ...(q.usableScope ? { usable_scope: q.usableScope } : {}),
      ...(q.evidenceRefs ? { evidence_refs: q.evidenceRefs } : {}),
      ...(q.corpusGeneratedAt ? { corpus_generated_at: q.corpusGeneratedAt } : {}),
      ...(q.reviewStatus ? { review_status: q.reviewStatus } : {}),
    };
    const ext = {
      ...(q.intro ? { intro: q.intro } : {}),
      ...(q.evidenceRefs ? { evidence_refs: q.evidenceRefs } : {}),
      ...(q.reviewStatus ? { review_status: q.reviewStatus } : {}),
    };
    const existing = exists[0];
    if (existing) {
      const qnId = existing.id;
      await db
        .update(schema.questionnaires)
        .set({ questionnaireType: q.type, sourceMeta, ext })
        .where(eq(schema.questionnaires.id, qnId));
      await replaceItems(db, qnId, q.items);
      continue;
    }
    const [qn] = await db
      .insert(schema.questionnaires)
      .values({
        name: q.name,
        questionnaireType: q.type,
        sourceMeta,
        ext,
      })
      .returning();
    if (!qn) continue;
    await replaceItems(db, qn.id, q.items);
    inserted++;
  }
  return inserted;
}

async function replaceItems(
  db: Db,
  questionnaireId: string,
  items: SeedQuestionnaire["items"],
): Promise<void> {
  await db
    .delete(schema.questionItems)
    .where(eq(schema.questionItems.questionnaireId, questionnaireId));
  for (const it of items) {
    await db.insert(schema.questionItems).values({
      questionnaireId,
      promptText: it.prompt,
      responseFormat: it.format,
      responseOptions: { options: it.options, ...(it.itemKey ? { item_key: it.itemKey } : {}) },
      meta: {
        ...(it.itemKey ? { item_key: it.itemKey } : {}),
        ...(it.evidenceRefs ? { evidence_refs: it.evidenceRefs } : {}),
      },
    });
  }
}
