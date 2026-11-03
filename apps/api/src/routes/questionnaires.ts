import { type Db, schema } from "@findme/db";
import { QuestionnaireResponse } from "@findme/shared";
import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { type TaskEnqueuer, createTask } from "../tasks/enqueue.js";

type QuestionnaireSourceMeta = {
  material_title?: string;
  domain?: string;
  lens?: string;
  source_id?: string;
  source_url?: string;
  license_status?: string;
  usable_scope?: string;
  evidence_refs?: string[];
  corpus_generated_at?: string;
  review_status?: string;
};
type QuestionnaireExt = {
  intro?: string;
};

// M-A2 结构化采集:题库 GET(驱动前端)+ 作答 POST(存 questionnaire_response + 入队 M-O1)。
export function questionnairesRoutes(db: Db, enqueue?: TaskEnqueuer) {
  const r = new Hono();

  r.get("/", async (c) => {
    const qns = await db
      .select()
      .from(schema.questionnaires)
      .where(eq(schema.questionnaires.enabled, true));
    const questionnaires = [];
    for (const qn of qns) {
      const source = qn.sourceMeta as QuestionnaireSourceMeta | null;
      const ext = qn.ext as QuestionnaireExt | null;
      const items = await db
        .select()
        .from(schema.questionItems)
        .where(eq(schema.questionItems.questionnaireId, qn.id))
        .orderBy(asc(schema.questionItems.createdAt));
      questionnaires.push({
        id: qn.id,
        name: qn.name,
        type: qn.questionnaireType,
        source: source?.material_title ?? null,
        domain: source?.domain ?? null,
        lens: source?.lens ?? null,
        source_id: source?.source_id ?? null,
        license_status: source?.license_status ?? null,
        usable_scope: source?.usable_scope ?? null,
        evidence_refs: source?.evidence_refs ?? [],
        review_status: source?.review_status ?? null,
        intro: ext?.intro ?? null,
        items: items.map((i) => ({
          id: i.id,
          prompt: i.promptText,
          format: i.responseFormat,
          options: (i.responseOptions as { options?: string[] }).options ?? [],
        })),
      });
    }
    return c.json({ questionnaires });
  });

  r.post("/respond", zValidator("json", QuestionnaireResponse), async (c) => {
    const b = c.req.valid("json");
    const [qn] = b.questionnaire_id
      ? await db
          .select()
          .from(schema.questionnaires)
          .where(eq(schema.questionnaires.id, b.questionnaire_id))
          .limit(1)
      : [];
    const source = qn?.sourceMeta as QuestionnaireSourceMeta | null | undefined;
    const contextParts = [
      qn ? `题组《${qn.name}》` : null,
      source?.material_title ? `来源:${source.material_title}` : null,
      source?.domain ? `领域:${source.domain}` : null,
      source?.lens ? `视角:${source.lens}` : null,
      source?.source_id ? `语料:${source.source_id}` : null,
    ].filter(Boolean);
    const text = contextParts.length > 0 ? `${contextParts.join(" · ")}\n${b.summary}` : b.summary;
    const [rec] = await db
      .insert(schema.rawRecords)
      .values({
        sourceType: "questionnaire_response",
        content: {
          text,
          answers: b.answers,
          questionnaire_id: b.questionnaire_id,
          questionnaire_name: qn?.name,
        },
        sourceMeta: {
          questionnaire_id: b.questionnaire_id,
          questionnaire_name: qn?.name,
          material_title: source?.material_title,
          domain: source?.domain,
          lens: source?.lens,
          source_id: source?.source_id,
          source_url: source?.source_url,
          license_status: source?.license_status,
          usable_scope: source?.usable_scope,
          evidence_refs: source?.evidence_refs,
          corpus_generated_at: source?.corpus_generated_at,
          review_status: source?.review_status,
        },
      })
      .returning();
    if (!rec) throw new Error("作答保存失败");
    await createTask(
      db,
      {
        taskType: "light_extract",
        payload: { record_id: rec.id },
      },
      enqueue,
    );
    return c.json({ record: rec }, 201);
  });

  return r;
}
