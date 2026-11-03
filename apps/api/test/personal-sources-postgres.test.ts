import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDb } from "@findme/db";
import { expect, it } from "vitest";
import { ProfileService } from "../src/auth/profiles.js";
import { CloudBlobService } from "../src/cloud-diagnostic/blobs.js";
import { PostgresFrameworkRepository } from "../src/cloud-diagnostic/frameworks.js";
import { withProfileTransaction } from "../src/cloud-diagnostic/scope.js";
import { human3Draft } from "../src/framework-runtime/definitions/human3-draft.js";
import { digest } from "../src/shared/primitives.js";
import { createSession, updateSession } from "../src/specialist/sessions.js";

// Everything the person writes is stored once, in source_items; features keep only source ids.
it("stores framework answers, specialist wording and originals as personal sources only", async () => {
  const config = JSON.parse(await readFile(process.env.FINDME_ACCOUNT_VERIFY_CONFIG!, "utf8"));
  const admin = createDb(process.env.DATABASE_URL_TEST!);
  const runtime = createDb(config.runtime_url);
  const identity = createDb(config.identity_url);
  try {
    const ctx = await new ProfileService(identity.db).resolve({
      provider: "personal-source-test",
      principalId: randomUUID(),
    });
    const sources = async (kind: string) =>
      admin.sql<{ id: string; content: string; usage_status: string; source_meta: never }[]>`
        select id, content, usage_status, source_meta from source_items
        where tenant_id=${ctx.tenantId} and source_kind=${kind} order by created_at`;

    // Framework answer: the answer id is the source id; stored state keeps no text.
    const repository = new PostgresFrameworkRepository(runtime.db, ctx);
    const answerId = randomUUID();
    await repository.update((state) => {
      state.runs.push({
        id: randomUUID(),
        owner_key: state.owner_key,
        version: 1,
        definition: human3Draft,
        mode: "direct_interview",
        status: "active",
        phase: "assessing",
        domain_index: 0,
        open_question: null,
        questions: [],
        skipped_questions: [],
        answers: [
          {
            id: answerId,
            question_id: "q1",
            domain: "mind",
            text: "最近一次改变看法是在复盘之后。",
            hash: digest("最近一次改变看法是在复盘之后。"),
            start: 0,
            end: 15,
            saved_at: new Date().toISOString(),
            status: "valid",
            replaces: null,
          },
        ],
        assessments: [],
        result: null,
        result_history: [],
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error: null,
      } as never);
    });
    const [answer] = await sources("framework_answer");
    expect(answer).toMatchObject({ id: answerId, content: "最近一次改变看法是在复盘之后。" });
    const [stored] =
      await admin.sql`select state from cloud_framework_states where tenant_id=${ctx.tenantId}`;
    expect(JSON.stringify(stored?.state)).not.toContain("复盘");
    expect((await repository.read()).runs[0]?.answers[0]?.text).toBe(
      "最近一次改变看法是在复盘之后。",
    );

    // Specialist wording: the session row has no text; an update supersedes the previous source.
    const created = await withProfileTransaction(runtime.db, ctx, (tx) =>
      createSession(
        tx as never,
        ctx,
        {
          pathway: "general",
          goal: "按时开始写作",
          difficulty_categories: [],
          scope_flags: [],
          environment_categories: [],
          skipped_steps: [],
        } as never,
        randomUUID(),
      ),
    );
    const session = (created.body as { session: { id: string; goal: string } }).session;
    expect(session.goal).toBe("按时开始写作");
    await withProfileTransaction(runtime.db, ctx, (tx) =>
      updateSession(tx as never, ctx, session.id, {
        expected_version: 1,
        setting: "早上在家",
      } as never),
    );
    const contexts = await sources("specialist_context");
    expect(contexts.map((s) => s.usage_status)).toEqual(["superseded", "active"]);
    expect(contexts[1]?.content).toContain("早上在家");
    const [row] = await admin.sql`select * from specialist_sessions where id=${session.id}`;
    expect(row?.context_source_id).toBe(contexts[1]?.id);
    expect(JSON.stringify(row)).not.toContain("写作");

    // Originals: declaring a file creates its source; the same content is declared once.
    const files = new CloudBlobService(runtime.db, {
      put: async () => {},
      get: async () => null,
      head: async () => null,
      delete: async () => {},
    });
    const declaration = {
      content_sha256: "a".repeat(64),
      byte_length: 3,
      media_type: "text/plain" as const,
      file_name: "notes.txt",
    };
    const first = await files.declare(ctx, declaration);
    expect(await files.declare(ctx, declaration)).toEqual(first);
    const [original] = await sources("original_file");
    expect(original?.id).toBe(first.source_id);
    const [blob] = await admin.sql`select source_item_id from source_blobs where id=${first.id}`;
    expect(blob?.source_item_id).toBe(first.source_id);
  } finally {
    await Promise.all([admin.sql.end(), runtime.sql.end(), identity.sql.end()]);
  }
});
