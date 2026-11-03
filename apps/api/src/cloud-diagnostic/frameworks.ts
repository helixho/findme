import { type Db, platformSchema as p } from "@findme/db";
import { and, eq } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import {
  readPersonalSources,
  recordPersonalSource,
  setPersonalSourceStatus,
} from "../core/personal-source.js";
import {
  type FrameworkRepository,
  type FrameworkState,
  FrameworkStateSchema,
} from "../framework-runtime/schema.js";
import { digest } from "../shared/primitives.js";
import { withProfileTransaction } from "./scope.js";
const usage = { valid: "active", corrected: "superseded", excluded: "excluded" } as const;

/**
 * Framework answers are personal sources: the answer id is the source id, the text lives only in
 * source_items, and the stored framework state keeps an empty placeholder that is filled on read.
 */
export class PostgresFrameworkRepository implements FrameworkRepository {
  constructor(
    private db: Db,
    private ctx: PersonalContext,
  ) {}
  private owner() {
    return `${this.ctx.tenantId}/${this.ctx.subjectId}`;
  }
  private empty(): FrameworkState {
    return {
      format: "u4-framework-state@1",
      owner_key: this.owner(),
      revision: 0,
      u4_calls_reserved: 0,
      runs: [],
      jobs: [],
      attempts: [],
      actions: [],
    };
  }
  private async parse(db: Db, state: unknown, hash: string) {
    const value = FrameworkStateSchema.parse(state);
    if (value.owner_key !== this.owner() || digest(value) !== hash)
      throw new Error("FRAMEWORK_STATE_INTEGRITY");
    const answers = value.runs.flatMap((r) => r.answers);
    const sources = await readPersonalSources(
      db,
      this.ctx,
      answers.map((a) => a.id),
    );
    for (const answer of answers) {
      const text = sources.get(answer.id)?.content;
      if (text === undefined || digest(text) !== answer.hash)
        throw new Error("FRAMEWORK_ANSWER_SOURCE_MISSING");
      answer.text = text;
    }
    return value;
  }
  private async recordAnswers(db: Db, state: FrameworkState) {
    const answers = state.runs.flatMap((r) => r.answers.map((a) => ({ run: r, a })));
    const known = await readPersonalSources(
      db,
      this.ctx,
      answers.map(({ a }) => a.id),
    );
    for (const { run, a } of answers) {
      if (known.has(a.id)) continue;
      await recordPersonalSource(db, this.ctx, {
        id: a.id,
        kind: "framework_answer",
        content: a.text,
        externalRef: `framework-answer:${a.id}`,
        meta: {
          framework_key: run.definition.key,
          run_id: run.id,
          question_id: a.question_id,
          domain: a.domain,
        },
        rationale: "本人在框架访谈中的回答；尚未用于形成认识。",
        replaces: a.replaces,
      });
    }
    for (const status of ["active", "superseded", "excluded"] as const)
      await setPersonalSourceStatus(
        db,
        this.ctx,
        answers.filter(({ a }) => usage[a.status] === status).map(({ a }) => a.id),
        status,
      );
  }
  /** The stored state carries answer ids and hashes only; text stays in source_items. */
  private stored(state: FrameworkState): FrameworkState {
    return {
      ...state,
      runs: state.runs.map((r) => ({ ...r, answers: r.answers.map((a) => ({ ...a, text: "" })) })),
    };
  }
  async read() {
    return withProfileTransaction(this.db, this.ctx, async (tx) => {
      const [row] = await tx
        .select()
        .from(p.frameworkStates)
        .where(
          and(
            eq(p.frameworkStates.tenantId, this.ctx.tenantId),
            eq(p.frameworkStates.subjectId, this.ctx.subjectId),
          ),
        )
        .limit(1);
      return row ? this.parse(tx as unknown as Db, row.state, row.contentHash) : this.empty();
    });
  }
  async update<T>(fn: (state: FrameworkState) => T | Promise<T>): Promise<T> {
    return withProfileTransaction(this.db, this.ctx, async (tx) => {
      const initial = this.empty();
      await tx
        .insert(p.frameworkStates)
        .values({ ...this.ctx, state: initial, contentHash: digest(initial) })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(p.frameworkStates)
        .where(
          and(
            eq(p.frameworkStates.tenantId, this.ctx.tenantId),
            eq(p.frameworkStates.subjectId, this.ctx.subjectId),
          ),
        )
        .limit(1)
        .for("update");
      if (!row) throw new Error("FRAMEWORK_STATE_MISSING");
      const db = tx as unknown as Db;
      const state = await this.parse(db, row.state, row.contentHash);
      const result = await fn(state);
      state.revision++;
      FrameworkStateSchema.parse(state);
      await this.recordAnswers(db, state);
      const stored = this.stored(state);
      await tx
        .update(p.frameworkStates)
        .set({
          state: stored,
          version: row.version + 1,
          contentHash: digest(stored),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(p.frameworkStates.tenantId, this.ctx.tenantId),
            eq(p.frameworkStates.subjectId, this.ctx.subjectId),
          ),
        );
      return result;
    });
  }
}
