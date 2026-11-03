import { type Db, schema } from "@findme/db";
import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type TaskEnqueuer, createTask } from "../tasks/enqueue.js";

const MaterialFeedback = z.object({
  reaction: z.enum(["resonate", "neutral", "more"]), // 有共鸣 / 一般 / 想深入
  note: z.string().max(2000).optional(),
});
const REACTION_LABEL: Record<string, string> = {
  resonate: "有共鸣",
  neutral: "一般",
  more: "想深入",
};
type MaterialMeta = {
  source_id?: string;
  domain?: string;
  lens?: string;
  confidence?: string;
  hook?: string;
  boundary?: string;
  reflect_prompt?: string;
  reflect_prompts?: string[];
  entry_prompt?: string;
  source_url?: string;
  license_status?: string;
  usable_scope?: string;
  evidence_refs?: string[];
  corpus_generated_at?: string;
  review_status?: string;
};
type MaterialLinkedRefs = {
  questionnaire_names?: string[];
};

// M-B0 学习素材:列表 + 阅读反馈。反馈写 raw_records 时**带上文章标题**,
// 让抽取/洞察的语料天然携带「读了什么 → 反应是什么」的关联(用户要求:学习反馈须结合内容分析)。
export function materialsRoutes(db: Db, enqueue?: TaskEnqueuer) {
  const r = new Hono();

  r.get("/", async (c) => {
    const items = await db
      .select()
      .from(schema.staticMaterials)
      .where(eq(schema.staticMaterials.enabled, true))
      .orderBy(desc(schema.staticMaterials.createdAt));
    return c.json({
      items: items.map((m) => ({
        id: m.id,
        type: m.materialType,
        title: m.title,
        body: m.body,
        ...materialMeta(m.meta, m.linkedRefs),
      })),
    });
  });

  r.post("/:id/feedback", zValidator("json", MaterialFeedback), async (c) => {
    const id = c.req.param("id");
    const { reaction, note } = c.req.valid("json");
    const [mat] = await db
      .select()
      .from(schema.staticMaterials)
      .where(eq(schema.staticMaterials.id, id));
    if (!mat) return c.json({ error: "素材不存在" }, 404);

    const meta = mat.meta as MaterialMeta | null;
    const text = `读《${mat.title}》:${REACTION_LABEL[reaction]}${note ? `——${note}` : ""}`;
    const [rec] = await db
      .insert(schema.rawRecords)
      .values({
        sourceType: "material_feedback",
        content: { text, material_id: mat.id, reaction },
        sourceMeta: {
          material_id: mat.id,
          material_title: mat.title,
          domain: meta?.domain,
          lens: meta?.lens,
          confidence: meta?.confidence,
          entry_prompt: meta?.entry_prompt ?? meta?.reflect_prompt,
          source_id: meta?.source_id,
          source_url: meta?.source_url,
          license_status: meta?.license_status,
          usable_scope: meta?.usable_scope,
          evidence_refs: meta?.evidence_refs,
          corpus_generated_at: meta?.corpus_generated_at,
          review_status: meta?.review_status,
        },
      })
      .returning();
    if (!rec) throw new Error("反馈保存失败");
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

function materialMeta(metaRaw: unknown, linkedRaw: unknown) {
  const meta = metaRaw as MaterialMeta | null;
  const linked = linkedRaw as MaterialLinkedRefs | null;
  return {
    domain: meta?.domain ?? null,
    lens: meta?.lens ?? null,
    confidence: meta?.confidence ?? null,
    hook: meta?.hook ?? null,
    boundary: meta?.boundary ?? null,
    reflect: meta?.reflect_prompt ?? null,
    reflect_prompts: meta?.reflect_prompts ?? [],
    entry_prompt: meta?.entry_prompt ?? meta?.reflect_prompt ?? null,
    source_url: meta?.source_url ?? null,
    source_id: meta?.source_id ?? null,
    license_status: meta?.license_status ?? null,
    usable_scope: meta?.usable_scope ?? null,
    evidence_refs: meta?.evidence_refs ?? [],
    review_status: meta?.review_status ?? null,
    linked_questionnaires: linked?.questionnaire_names ?? [],
  };
}
