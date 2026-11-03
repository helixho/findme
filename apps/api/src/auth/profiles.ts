import { type Db, coreSchema as core, platformSchema as tables } from "@findme/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { CoreError } from "../core/errors.js";
import type { PersonalContext } from "../core/exploration-service.js";
import type { Principal } from "../core/identity.js";
import { resolvePersonalContext } from "../core/identity.js";
const members = tables.profileMemberships;
const Name = z.string().trim().min(1).max(80);
const pid = z.string().uuid();
const scopeWhere = (principal: Principal) =>
  and(eq(members.provider, principal.provider), eq(members.principalId, principal.principalId));
const identityWhere = (principal: Principal) =>
  and(
    eq(core.identityBindings.provider, principal.provider),
    eq(core.identityBindings.principalId, principal.principalId),
  );

export class ProfileService {
  constructor(private readonly db: Db) {}
  private async seed(principal: Principal) {
    const ctx = await resolvePersonalContext(this.db, principal);
    await this.db
      .insert(members)
      .values({ ...ctx, ...principal, creationKey: "default" })
      .onConflictDoNothing();
    return ctx;
  }
  /** Bind a new account to an existing personal scope and seed its default membership atomically. */
  async bindExistingScope(
    principal: Principal,
    scope: { tenantId: string; subjectId: string },
    source: Principal,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([principal.provider, principal.principalId])},0))`,
      );
      const [owner] = await tx
        .select({
          tenantId: core.identityBindings.tenantId,
          subjectId: core.identityBindings.subjectId,
          tenantStatus: core.tenants.status,
          subjectType: core.subjects.subjectType,
        })
        .from(core.identityBindings)
        .innerJoin(
          core.subjects,
          and(
            eq(core.identityBindings.subjectId, core.subjects.id),
            eq(core.identityBindings.tenantId, core.subjects.tenantId),
          ),
        )
        .innerJoin(core.tenants, eq(core.identityBindings.tenantId, core.tenants.id))
        .where(identityWhere(source))
        .limit(1);
      if (
        !owner ||
        owner.tenantId !== scope.tenantId ||
        owner.subjectId !== scope.subjectId ||
        owner.tenantStatus !== "active" ||
        owner.subjectType !== "self"
      )
        throw new Error("OWNER_ACCOUNT_SOURCE_SCOPE_CHANGED");
      const [target] = await tx
        .select({ tenantId: core.tenants.id, subjectId: core.subjects.id })
        .from(core.subjects)
        .innerJoin(core.tenants, eq(core.subjects.tenantId, core.tenants.id))
        .where(
          and(
            eq(core.subjects.id, scope.subjectId),
            eq(core.subjects.tenantId, scope.tenantId),
            eq(core.subjects.subjectType, "self"),
            eq(core.tenants.status, "active"),
          ),
        )
        .limit(1);
      if (!target) throw new Error("OWNER_ACCOUNT_TARGET_SCOPE_INVALID");

      const [binding] = await tx
        .select({
          tenantId: core.identityBindings.tenantId,
          subjectId: core.identityBindings.subjectId,
        })
        .from(core.identityBindings)
        .where(identityWhere(principal))
        .limit(1);
      if (binding && (binding.tenantId !== scope.tenantId || binding.subjectId !== scope.subjectId))
        throw new Error("OWNER_ACCOUNT_TARGET_BINDING_CONFLICT");
      const bindingCreated = !binding;
      if (bindingCreated) await tx.insert(core.identityBindings).values({ ...principal, ...scope });

      const [membership] = await tx
        .select({ tenantId: members.tenantId, subjectId: members.subjectId })
        .from(members)
        .where(and(scopeWhere(principal), eq(members.creationKey, "default")))
        .limit(1);
      if (
        membership &&
        (membership.tenantId !== scope.tenantId || membership.subjectId !== scope.subjectId)
      )
        throw new Error("OWNER_ACCOUNT_DEFAULT_PROFILE_CONFLICT");
      const membershipCreated = !membership;
      if (membershipCreated)
        await tx.insert(members).values({ ...principal, ...scope, creationKey: "default" });

      return { bindingCreated, membershipCreated };
    });
  }
  async rollbackExistingScope(
    principal: Principal,
    scope: { tenantId: string; subjectId: string },
    created: { bindingCreated: boolean; membershipCreated: boolean },
  ) {
    if (!created.bindingCreated && !created.membershipCreated) return;
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([principal.provider, principal.principalId])},0))`,
      );
      if (created.membershipCreated)
        await tx
          .delete(members)
          .where(
            and(
              scopeWhere(principal),
              eq(members.tenantId, scope.tenantId),
              eq(members.subjectId, scope.subjectId),
              eq(members.creationKey, "default"),
            ),
          );
      if (created.bindingCreated)
        await tx
          .delete(core.identityBindings)
          .where(
            and(
              identityWhere(principal),
              eq(core.identityBindings.tenantId, scope.tenantId),
              eq(core.identityBindings.subjectId, scope.subjectId),
            ),
          );
    });
  }
  async list(principal: Principal) {
    await this.seed(principal);
    return this.db
      .select({
        id: members.id,
        name: core.subjects.displayName,
        status: members.status,
        version: members.version,
      })
      .from(members)
      .innerJoin(
        core.subjects,
        and(eq(members.subjectId, core.subjects.id), eq(members.tenantId, core.subjects.tenantId)),
      )
      .where(scopeWhere(principal))
      .orderBy(members.createdAt);
  }
  async resolve(principal: Principal, selected?: string): Promise<PersonalContext> {
    const defaultScope = await this.seed(principal);
    const [row] = await this.db
      .select()
      .from(members)
      .where(
        and(
          scopeWhere(principal),
          selected
            ? eq(members.id, pid.parse(selected))
            : eq(members.subjectId, defaultScope.subjectId),
          eq(members.status, "active"),
        ),
      )
      .limit(1);
    if (!row) throw new CoreError("DIAGNOSTIC_SCOPE_INVALID", 403, "Profile 不可用");
    return { tenantId: row.tenantId, subjectId: row.subjectId };
  }
  async create(principal: Principal, name: string, key: string) {
    const label = Name.parse(name);
    if (!key.trim() || key.length > 200) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([principal, key])},0))`,
      );
      const [old] = await tx
        .select()
        .from(members)
        .where(and(scopeWhere(principal), eq(members.creationKey, key)))
        .limit(1);
      if (old) {
        const [s] = await tx
          .select()
          .from(core.subjects)
          .where(eq(core.subjects.id, old.subjectId));
        if (s?.displayName !== label)
          throw new CoreError("IDEMPOTENCY_KEY_REUSED", 409, "创建请求已变化");
        return { id: old.id, name: label, status: old.status, version: old.version };
      }
      const [tenant] = await tx.insert(core.tenants).values({ status: "active" }).returning();
      if (!tenant) throw new Error("PROFILE_CREATE_FAILED");
      const [subject] = await tx
        .insert(core.subjects)
        .values({ tenantId: tenant.id, subjectType: "self", displayName: label })
        .returning();
      if (!subject) throw new Error("PROFILE_CREATE_FAILED");
      const [row] = await tx
        .insert(members)
        .values({ ...principal, tenantId: tenant.id, subjectId: subject.id, creationKey: key })
        .returning();
      if (!row) throw new Error("PROFILE_CREATE_FAILED");
      return { id: row.id, name: label, status: row.status, version: row.version };
    });
  }
  async update(principal: Principal, id: string, raw: unknown) {
    const input = z
      .object({
        expected_version: z.number().int().positive(),
        name: Name.optional(),
        status: z.enum(["active", "archived"]).optional(),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(members)
        .where(and(scopeWhere(principal), eq(members.id, pid.parse(id))))
        .limit(1)
        .for("update");
      if (!row || row.status === "deleted") throw new CoreError("NOT_FOUND", 404, "Profile 不存在");
      if (row.version !== input.expected_version)
        throw new CoreError("STALE_VERSION", 409, "Profile 已变化");
      await tx
        .update(members)
        .set({ version: row.version + 1, status: input.status ?? row.status })
        .where(eq(members.id, row.id));
      if (input.name)
        await tx
          .update(core.subjects)
          .set({ displayName: input.name })
          .where(eq(core.subjects.id, row.subjectId));
      // Frozen profiles refuse queued publication; restoring a profile never auto-resumes work.
      if (input.status === "archived") {
        await tx.execute(
          sql`select set_config('app.tenant_id',${row.tenantId},true),set_config('app.subject_id',${row.subjectId},true)`,
        );
        await tx
          .update(tables.cloudJobs)
          .set({
            status: "cancelled",
            execution: null,
            leaseUntil: null,
            error: "PROFILE_ARCHIVED",
          })
          .where(
            and(
              eq(tables.cloudJobs.tenantId, row.tenantId),
              eq(tables.cloudJobs.subjectId, row.subjectId),
              sql`${tables.cloudJobs.status} in ('queued','running')`,
            ),
          );
      }
      return { id: row.id, version: row.version + 1, status: input.status ?? row.status };
    });
  }
}
