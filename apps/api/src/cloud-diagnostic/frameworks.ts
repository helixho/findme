import { type Db, platformSchema as p } from "@findme/db";
import { and, eq } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import {
  type FrameworkRepository,
  type FrameworkState,
  FrameworkStateSchema,
} from "../framework-runtime/schema.js";
import { digest } from "../shared/primitives.js";
import { withProfileTransaction } from "./scope.js";
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
  private parse(state: unknown, hash: string) {
    const value = FrameworkStateSchema.parse(state);
    if (value.owner_key !== this.owner() || digest(value) !== hash)
      throw new Error("FRAMEWORK_STATE_INTEGRITY");
    return value;
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
      return row ? this.parse(row.state, row.contentHash) : this.empty();
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
      const state = this.parse(row.state, row.contentHash);
      const result = await fn(state);
      state.revision++;
      FrameworkStateSchema.parse(state);
      await tx
        .update(p.frameworkStates)
        .set({ state, version: row.version + 1, contentHash: digest(state), updatedAt: new Date() })
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
