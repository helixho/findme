import { type Db, coreSchema } from "@findme/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { CoreError } from "./errors.js";
import type { PersonalContext } from "./exploration-service.js";

const PrincipalInput = z
  .object({
    provider: z.string().trim().min(1).max(200),
    principalId: z.string().min(1).max(200),
  })
  .strict();
export type Principal = z.infer<typeof PrincipalInput>;

/** A stable account principal maps to one personal tenant/self, independent of device/session. */
export async function resolvePersonalContext(db: Db, raw: Principal): Promise<PersonalContext> {
  const principal = PrincipalInput.parse(raw);
  return db.transaction(async (tx) => {
    // Serialise the first-bind race. A conflict rolls back tenant/subject creation together.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
      ${JSON.stringify([principal.provider, principal.principalId])}, 0))`);
    const [existing] = await tx
      .select()
      .from(coreSchema.identityBindings)
      .where(
        and(
          eq(coreSchema.identityBindings.provider, principal.provider),
          eq(coreSchema.identityBindings.principalId, principal.principalId),
        ),
      )
      .limit(1);
    if (existing) {
      const [subject] = await tx
        .select({ id: coreSchema.subjects.id })
        .from(coreSchema.subjects)
        .innerJoin(coreSchema.tenants, eq(coreSchema.subjects.tenantId, coreSchema.tenants.id))
        .where(
          and(
            eq(coreSchema.subjects.id, existing.subjectId),
            eq(coreSchema.subjects.tenantId, existing.tenantId),
            eq(coreSchema.subjects.subjectType, "self"),
            eq(coreSchema.tenants.status, "active"),
          ),
        )
        .limit(1);
      if (!subject) throw new CoreError("ACCOUNT_DISABLED", 403, "个人账号当前不可用");
      return { tenantId: existing.tenantId, subjectId: existing.subjectId };
    }
    const [tenant] = await tx.insert(coreSchema.tenants).values({ status: "active" }).returning();
    if (!tenant) throw new Error("tenant_create_failed");
    const [subject] = await tx
      .insert(coreSchema.subjects)
      .values({ tenantId: tenant.id, subjectType: "self" })
      .returning();
    if (!subject) throw new Error("subject_create_failed");
    await tx.insert(coreSchema.identityBindings).values({
      ...principal,
      tenantId: tenant.id,
      subjectId: subject.id,
    });
    return { tenantId: tenant.id, subjectId: subject.id };
  });
}
