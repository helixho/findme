import { sql } from "drizzle-orm";

/** Shared fail-closed role gate; do not enumerate private rows in health checks. */
export const accountRuntimeRoleQuery = sql`select
      not r.rolsuper and not r.rolbypassrls
      and pg_has_role(current_user, 'findme_runtime', 'member')
      and not pg_has_role(current_user, 'findme_identity', 'member')
      and not pg_has_role(current_user, 'findme_auth', 'member')
      and not exists(select 1 from pg_class t where t.relowner=r.oid and t.relname in
        ('source_items','subjects','diagnostic_runs','diagnostic_report_revisions','cloud_diagnostic_jobs')) as allowed
      from pg_roles r where r.rolname=current_user`;
