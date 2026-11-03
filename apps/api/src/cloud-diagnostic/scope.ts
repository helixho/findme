import { type Db, coreSchema, platformSchema } from "@findme/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { accountRuntimeRoleQuery } from "./runtime-role.js";

export type ProfileTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const Scope = z.object({ tenantId: z.string().uuid(), subjectId: z.string().uuid() }).strict();

/** Short transactions only. Never call an LLM/object store inside this callback. */
export async function withProfileTransaction<T>(
  db: Db,
  raw: PersonalContext,
  work: (tx: ProfileTransaction) => Promise<T>,
  options: { allowDeleting?: boolean } = {},
): Promise<T> {
  const ctx = Scope.parse(raw);
  return db.transaction(async (tx) => {
    const role = await tx.execute(accountRuntimeRoleQuery);
    if (role[0]?.allowed !== true)
      throw new CoreError("DIAGNOSTIC_SCOPE_INVALID", 403, "运行数据库角色未满足隔离要求");

    await tx.execute(sql`select set_config('app.tenant_id', ${ctx.tenantId}, true),
      set_config('app.subject_id', ${ctx.subjectId}, true)`);
    const [subject] = await tx
      .select({ id: coreSchema.subjects.id, ext: coreSchema.subjects.ext })
      .from(coreSchema.subjects)
      .innerJoin(coreSchema.tenants, eq(coreSchema.subjects.tenantId, coreSchema.tenants.id))
      .where(
        and(
          eq(coreSchema.subjects.id, ctx.subjectId),
          eq(coreSchema.subjects.tenantId, ctx.tenantId),
          eq(coreSchema.tenants.status, "active"),
        ),
      )
      .limit(1)
      .for("share");
    if (!subject) throw new CoreError("DIAGNOSTIC_SCOPE_INVALID", 403, "个人资料作用域不可用");
    if (subject.ext?.deleting && !options.allowDeleting)
      throw new CoreError("DIAGNOSTIC_SCOPE_INVALID", 403, "资料清理中；只能恢复清理任务");
    const membership = await tx
      .select({ id: platformSchema.profileMemberships.id })
      .from(platformSchema.profileMemberships)
      .where(
        and(
          eq(platformSchema.profileMemberships.tenantId, ctx.tenantId),
          eq(platformSchema.profileMemberships.subjectId, ctx.subjectId),
          eq(platformSchema.profileMemberships.status, "active"),
        ),
      )
      .limit(1)
      .for("share");
    if (!membership.length)
      throw new CoreError("DIAGNOSTIC_SCOPE_INVALID", 403, "Profile 已暂停或撤销");
    return work(tx);
  });
}
