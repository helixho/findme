-- Account runtime roles, grants and row-level policies. Applied after schema.sql on every deploy;
-- every statement is idempotent.

BEGIN;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='findme_runtime') THEN CREATE ROLE findme_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;

-- Managed PostgreSQL owners cannot ALTER SUPERUSER attributes. Validate instead of escalating.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='findme_runtime'
   AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolcanlogin))
 THEN RAISE EXCEPTION 'UNSAFE_EXISTING_ROLE_findme_runtime'; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO findme_runtime;
GRANT SELECT,INSERT,UPDATE ON app_settings TO findme_runtime;
DO $$ BEGIN
 IF to_regclass('public.specialist_sessions') IS NOT NULL
  AND to_regclass('public.specialist_proposals') IS NOT NULL
  AND to_regclass('public.specialist_trials') IS NOT NULL
  AND to_regclass('public.knowledge_processing_records') IS NOT NULL
 THEN
  EXECUTE 'GRANT SELECT,INSERT,UPDATE,DELETE ON specialist_sessions,specialist_proposals,specialist_trials,knowledge_processing_records TO findme_runtime';
 END IF;
END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='findme_identity') THEN CREATE ROLE findme_identity NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;

-- Managed PostgreSQL owners cannot ALTER SUPERUSER attributes. Validate instead of escalating.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='findme_identity'
   AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolcanlogin))
 THEN RAISE EXCEPTION 'UNSAFE_EXISTING_ROLE_findme_identity'; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO findme_identity;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='findme_auth') THEN CREATE ROLE findme_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;

-- Managed PostgreSQL owners cannot ALTER SUPERUSER attributes. Validate instead of escalating.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='findme_auth'
   AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolcanlogin))
 THEN RAISE EXCEPTION 'UNSAFE_EXISTING_ROLE_findme_auth'; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO findme_auth;

REVOKE ALL ON auth_users,auth_sessions,auth_accounts,auth_verifications,auth_rate_limits FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON auth_users,auth_sessions,auth_accounts,auth_verifications,auth_rate_limits TO findme_auth;

GRANT SELECT,INSERT,UPDATE ON tenants,subjects,identity_bindings,profile_memberships TO findme_identity;

GRANT SELECT (id,tenant_id,subject_id,status),UPDATE (status,execution,lease_until,error) ON cloud_diagnostic_jobs TO findme_identity;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON tenants;

-- Locking reads also require an UPDATE policy. Column grants remain unchanged.
CREATE POLICY account_runtime_scope ON tenants FOR ALL TO findme_runtime USING (tenants.id::text=current_setting('app.tenant_id',true)) WITH CHECK (tenants.id::text=current_setting('app.tenant_id',true));

GRANT SELECT ON tenants TO findme_runtime;

GRANT UPDATE (status) ON tenants TO findme_runtime;

ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;

ALTER TABLE subjects FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON subjects;

CREATE POLICY account_runtime_scope ON subjects FOR ALL TO findme_runtime USING (subjects.tenant_id::text=current_setting('app.tenant_id',true) AND subjects.id::text=current_setting('app.subject_id',true)) WITH CHECK (subjects.tenant_id::text=current_setting('app.tenant_id',true) AND subjects.id::text=current_setting('app.subject_id',true));

GRANT SELECT,INSERT,UPDATE,DELETE ON subjects TO findme_runtime;

ALTER TABLE profile_memberships ENABLE ROW LEVEL SECURITY;

ALTER TABLE profile_memberships FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON profile_memberships;

-- Locking reads also require an UPDATE policy. Column grants remain unchanged.
CREATE POLICY account_runtime_scope ON profile_memberships FOR ALL TO findme_runtime USING (profile_memberships.tenant_id::text=current_setting('app.tenant_id',true) AND profile_memberships.subject_id::text=current_setting('app.subject_id',true)) WITH CHECK (profile_memberships.tenant_id::text=current_setting('app.tenant_id',true) AND profile_memberships.subject_id::text=current_setting('app.subject_id',true));

GRANT SELECT ON profile_memberships TO findme_runtime;

GRANT UPDATE (version) ON profile_memberships TO findme_runtime;

ALTER TABLE source_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE source_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON source_items;

CREATE POLICY account_runtime_scope ON source_items FOR ALL TO findme_runtime USING (source_items.tenant_id::text=current_setting('app.tenant_id',true) AND source_items.subject_id::text=current_setting('app.subject_id',true)) WITH CHECK (source_items.tenant_id::text=current_setting('app.tenant_id',true) AND source_items.subject_id::text=current_setting('app.subject_id',true));

GRANT SELECT,INSERT,UPDATE,DELETE ON source_items TO findme_runtime;

ALTER TABLE source_links ENABLE ROW LEVEL SECURITY;

ALTER TABLE source_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON source_links;

CREATE POLICY account_runtime_scope ON source_links FOR ALL TO findme_runtime USING (EXISTS(SELECT 1 FROM source_items s WHERE s.id=source_links.source_item_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true)) AND EXISTS(SELECT 1 FROM source_items s WHERE s.id=source_links.target_source_item_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true))) WITH CHECK (EXISTS(SELECT 1 FROM source_items s WHERE s.id=source_links.source_item_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true)) AND EXISTS(SELECT 1 FROM source_items s WHERE s.id=source_links.target_source_item_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true)));

GRANT SELECT,INSERT,UPDATE,DELETE ON source_links TO findme_runtime;

ALTER TABLE source_assessments ENABLE ROW LEVEL SECURITY;

ALTER TABLE source_assessments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON source_assessments;

CREATE POLICY account_runtime_scope ON source_assessments FOR ALL TO findme_runtime USING (EXISTS(SELECT 1 FROM source_items s WHERE s.id=source_assessments.source_item_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true))) WITH CHECK (EXISTS(SELECT 1 FROM source_items s WHERE s.id=source_assessments.source_item_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true)));

GRANT SELECT,INSERT,UPDATE,DELETE ON source_assessments TO findme_runtime;

ALTER TABLE evidence_spans ENABLE ROW LEVEL SECURITY;

ALTER TABLE evidence_spans FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON evidence_spans;

CREATE POLICY account_runtime_scope ON evidence_spans FOR ALL TO findme_runtime USING (EXISTS(SELECT 1 FROM source_items s WHERE s.id=evidence_spans.source_item_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true))) WITH CHECK (EXISTS(SELECT 1 FROM source_items s WHERE s.id=evidence_spans.source_item_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true)));

GRANT SELECT,INSERT,UPDATE,DELETE ON evidence_spans TO findme_runtime;

ALTER TABLE experiences ENABLE ROW LEVEL SECURITY;

ALTER TABLE experiences FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON experiences;

CREATE POLICY account_runtime_scope ON experiences FOR ALL TO findme_runtime USING (experiences.tenant_id::text=current_setting('app.tenant_id',true) AND experiences.subject_id::text=current_setting('app.subject_id',true)) WITH CHECK (experiences.tenant_id::text=current_setting('app.tenant_id',true) AND experiences.subject_id::text=current_setting('app.subject_id',true));

GRANT SELECT,INSERT,UPDATE,DELETE ON experiences TO findme_runtime;

ALTER TABLE experience_evidence ENABLE ROW LEVEL SECURITY;

ALTER TABLE experience_evidence FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON experience_evidence;

CREATE POLICY account_runtime_scope ON experience_evidence FOR ALL TO findme_runtime USING (EXISTS(SELECT 1 FROM experiences e WHERE e.id=experience_evidence.experience_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true)) AND EXISTS(SELECT 1 FROM evidence_spans e JOIN source_items s ON s.id=e.source_item_id WHERE e.id=experience_evidence.evidence_span_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true))) WITH CHECK (EXISTS(SELECT 1 FROM experiences e WHERE e.id=experience_evidence.experience_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true)) AND EXISTS(SELECT 1 FROM evidence_spans e JOIN source_items s ON s.id=e.source_item_id WHERE e.id=experience_evidence.evidence_span_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true)));

GRANT SELECT,INSERT,UPDATE,DELETE ON experience_evidence TO findme_runtime;

ALTER TABLE explorations ENABLE ROW LEVEL SECURITY;

ALTER TABLE explorations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON explorations;

CREATE POLICY account_runtime_scope ON explorations FOR ALL TO findme_runtime USING (explorations.tenant_id::text=current_setting('app.tenant_id',true) AND explorations.subject_id::text=current_setting('app.subject_id',true) AND EXISTS(SELECT 1 FROM experiences e WHERE e.id=explorations.experience_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true))) WITH CHECK (explorations.tenant_id::text=current_setting('app.tenant_id',true) AND explorations.subject_id::text=current_setting('app.subject_id',true) AND EXISTS(SELECT 1 FROM experiences e WHERE e.id=explorations.experience_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true)));

GRANT SELECT,INSERT,UPDATE,DELETE ON explorations TO findme_runtime;

ALTER TABLE exploration_questions ENABLE ROW LEVEL SECURITY;

ALTER TABLE exploration_questions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON exploration_questions;

CREATE POLICY account_runtime_scope ON exploration_questions FOR ALL TO findme_runtime USING (EXISTS(SELECT 1 FROM explorations e WHERE e.id=exploration_questions.exploration_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true))) WITH CHECK (EXISTS(SELECT 1 FROM explorations e WHERE e.id=exploration_questions.exploration_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true)));

GRANT SELECT,INSERT,UPDATE,DELETE ON exploration_questions TO findme_runtime;

ALTER TABLE exploration_turns ENABLE ROW LEVEL SECURITY;

ALTER TABLE exploration_turns FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON exploration_turns;

CREATE POLICY account_runtime_scope ON exploration_turns FOR ALL TO findme_runtime USING (EXISTS(SELECT 1 FROM explorations e WHERE e.id=exploration_turns.exploration_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true)) AND (exploration_turns.source_item_id IS NULL OR EXISTS(SELECT 1 FROM source_items s WHERE s.id=exploration_turns.source_item_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true))) AND (exploration_turns.question_id IS NULL OR EXISTS(SELECT 1 FROM exploration_questions q WHERE q.id=exploration_turns.question_id AND q.exploration_id=exploration_turns.exploration_id))) WITH CHECK (EXISTS(SELECT 1 FROM explorations e WHERE e.id=exploration_turns.exploration_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true)) AND (exploration_turns.source_item_id IS NULL OR EXISTS(SELECT 1 FROM source_items s WHERE s.id=exploration_turns.source_item_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true))) AND (exploration_turns.question_id IS NULL OR EXISTS(SELECT 1 FROM exploration_questions q WHERE q.id=exploration_turns.question_id AND q.exploration_id=exploration_turns.exploration_id)));

GRANT SELECT,INSERT,UPDATE,DELETE ON exploration_turns TO findme_runtime;

ALTER TABLE exploration_steps ENABLE ROW LEVEL SECURITY;

ALTER TABLE exploration_steps FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON exploration_steps;

CREATE POLICY account_runtime_scope ON exploration_steps FOR ALL TO findme_runtime USING (EXISTS(SELECT 1 FROM explorations e WHERE e.id=exploration_steps.exploration_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true)) AND (exploration_steps.input_turn_id IS NULL OR EXISTS(SELECT 1 FROM exploration_turns t WHERE t.id=exploration_steps.input_turn_id AND t.exploration_id=exploration_steps.exploration_id)) AND (exploration_steps.question_id IS NULL OR EXISTS(SELECT 1 FROM exploration_questions q WHERE q.id=exploration_steps.question_id AND q.exploration_id=exploration_steps.exploration_id))) WITH CHECK (EXISTS(SELECT 1 FROM explorations e WHERE e.id=exploration_steps.exploration_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true)) AND (exploration_steps.input_turn_id IS NULL OR EXISTS(SELECT 1 FROM exploration_turns t WHERE t.id=exploration_steps.input_turn_id AND t.exploration_id=exploration_steps.exploration_id)) AND (exploration_steps.question_id IS NULL OR EXISTS(SELECT 1 FROM exploration_questions q WHERE q.id=exploration_steps.question_id AND q.exploration_id=exploration_steps.exploration_id)));

GRANT SELECT,INSERT,UPDATE,DELETE ON exploration_steps TO findme_runtime;

ALTER TABLE knowledge_gaps ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_gaps FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON knowledge_gaps;

CREATE POLICY account_runtime_scope ON knowledge_gaps FOR ALL TO findme_runtime USING (EXISTS(SELECT 1 FROM explorations e WHERE e.id=knowledge_gaps.exploration_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true))) WITH CHECK (EXISTS(SELECT 1 FROM explorations e WHERE e.id=knowledge_gaps.exploration_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true)));

GRANT SELECT,INSERT,UPDATE,DELETE ON knowledge_gaps TO findme_runtime;

ALTER TABLE claims ENABLE ROW LEVEL SECURITY;

ALTER TABLE claims FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON claims;

CREATE POLICY account_runtime_scope ON claims FOR ALL TO findme_runtime USING (claims.tenant_id::text=current_setting('app.tenant_id',true) AND claims.subject_id::text=current_setting('app.subject_id',true)) WITH CHECK (claims.tenant_id::text=current_setting('app.tenant_id',true) AND claims.subject_id::text=current_setting('app.subject_id',true));

GRANT SELECT,INSERT,UPDATE,DELETE ON claims TO findme_runtime;

ALTER TABLE claim_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE claim_revisions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON claim_revisions;

CREATE POLICY account_runtime_scope ON claim_revisions FOR ALL TO findme_runtime USING (EXISTS(SELECT 1 FROM claims c WHERE c.id=claim_revisions.claim_id AND c.tenant_id::text=current_setting('app.tenant_id',true) AND c.subject_id::text=current_setting('app.subject_id',true))) WITH CHECK (EXISTS(SELECT 1 FROM claims c WHERE c.id=claim_revisions.claim_id AND c.tenant_id::text=current_setting('app.tenant_id',true) AND c.subject_id::text=current_setting('app.subject_id',true)));

GRANT SELECT,INSERT,UPDATE,DELETE ON claim_revisions TO findme_runtime;

ALTER TABLE claim_evidence ENABLE ROW LEVEL SECURITY;

ALTER TABLE claim_evidence FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON claim_evidence;

CREATE POLICY account_runtime_scope ON claim_evidence FOR ALL TO findme_runtime USING (EXISTS(SELECT 1 FROM claim_revisions r JOIN claims c ON c.id=r.claim_id WHERE r.id=claim_evidence.claim_revision_id AND c.tenant_id::text=current_setting('app.tenant_id',true) AND c.subject_id::text=current_setting('app.subject_id',true)) AND EXISTS(SELECT 1 FROM evidence_spans e JOIN source_items s ON s.id=e.source_item_id WHERE e.id=claim_evidence.evidence_span_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true))) WITH CHECK (EXISTS(SELECT 1 FROM claim_revisions r JOIN claims c ON c.id=r.claim_id WHERE r.id=claim_evidence.claim_revision_id AND c.tenant_id::text=current_setting('app.tenant_id',true) AND c.subject_id::text=current_setting('app.subject_id',true)) AND EXISTS(SELECT 1 FROM evidence_spans e JOIN source_items s ON s.id=e.source_item_id WHERE e.id=claim_evidence.evidence_span_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true)));

GRANT SELECT,INSERT,UPDATE,DELETE ON claim_evidence TO findme_runtime;

ALTER TABLE feedback_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE feedback_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON feedback_events;

CREATE POLICY account_runtime_scope ON feedback_events FOR ALL TO findme_runtime USING (feedback_events.tenant_id::text=current_setting('app.tenant_id',true) AND feedback_events.subject_id::text=current_setting('app.subject_id',true) AND ((feedback_events.target_type='claim_revision' AND EXISTS(SELECT 1 FROM claim_revisions r JOIN claims c ON c.id=r.claim_id WHERE r.id=feedback_events.target_id AND c.tenant_id::text=current_setting('app.tenant_id',true) AND c.subject_id::text=current_setting('app.subject_id',true))) OR (feedback_events.target_type='source' AND EXISTS(SELECT 1 FROM source_items target_source WHERE target_source.id=feedback_events.target_id AND target_source.tenant_id::text=current_setting('app.tenant_id',true) AND target_source.subject_id::text=current_setting('app.subject_id',true)))) AND (feedback_events.source_item_id IS NULL OR EXISTS(SELECT 1 FROM source_items s WHERE s.id=feedback_events.source_item_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true))) AND (feedback_events.exploration_id IS NULL OR EXISTS(SELECT 1 FROM explorations e WHERE e.id=feedback_events.exploration_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true)))) WITH CHECK (feedback_events.tenant_id::text=current_setting('app.tenant_id',true) AND feedback_events.subject_id::text=current_setting('app.subject_id',true) AND ((feedback_events.target_type='claim_revision' AND EXISTS(SELECT 1 FROM claim_revisions r JOIN claims c ON c.id=r.claim_id WHERE r.id=feedback_events.target_id AND c.tenant_id::text=current_setting('app.tenant_id',true) AND c.subject_id::text=current_setting('app.subject_id',true))) OR (feedback_events.target_type='source' AND EXISTS(SELECT 1 FROM source_items target_source WHERE target_source.id=feedback_events.target_id AND target_source.tenant_id::text=current_setting('app.tenant_id',true) AND target_source.subject_id::text=current_setting('app.subject_id',true)))) AND (feedback_events.source_item_id IS NULL OR EXISTS(SELECT 1 FROM source_items s WHERE s.id=feedback_events.source_item_id AND s.tenant_id::text=current_setting('app.tenant_id',true) AND s.subject_id::text=current_setting('app.subject_id',true))) AND (feedback_events.exploration_id IS NULL OR EXISTS(SELECT 1 FROM explorations e WHERE e.id=feedback_events.exploration_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true))));

GRANT SELECT,INSERT,UPDATE,DELETE ON feedback_events TO findme_runtime;

ALTER TABLE core_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE core_operations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_runtime_scope ON core_operations;

CREATE POLICY account_runtime_scope ON core_operations FOR ALL TO findme_runtime USING (core_operations.tenant_id::text=current_setting('app.tenant_id',true) AND core_operations.subject_id::text=current_setting('app.subject_id',true) AND (core_operations.exploration_id IS NULL OR EXISTS(SELECT 1 FROM explorations e WHERE e.id=core_operations.exploration_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true)))) WITH CHECK (core_operations.tenant_id::text=current_setting('app.tenant_id',true) AND core_operations.subject_id::text=current_setting('app.subject_id',true) AND (core_operations.exploration_id IS NULL OR EXISTS(SELECT 1 FROM explorations e WHERE e.id=core_operations.exploration_id AND e.tenant_id::text=current_setting('app.tenant_id',true) AND e.subject_id::text=current_setting('app.subject_id',true))));

GRANT SELECT,INSERT,UPDATE,DELETE ON core_operations TO findme_runtime;

DROP POLICY IF EXISTS account_identity_access ON tenants;

CREATE POLICY account_identity_access ON tenants FOR ALL TO findme_identity USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS account_identity_access ON subjects;

CREATE POLICY account_identity_access ON subjects FOR ALL TO findme_identity USING (true) WITH CHECK (true);

ALTER TABLE identity_bindings ENABLE ROW LEVEL SECURITY;

ALTER TABLE identity_bindings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_identity_access ON identity_bindings;

CREATE POLICY account_identity_access ON identity_bindings FOR ALL TO findme_identity USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS account_identity_access ON profile_memberships;

CREATE POLICY account_identity_access ON profile_memberships FOR ALL TO findme_identity USING (true) WITH CHECK (true);

GRANT SELECT,INSERT,UPDATE,DELETE ON diagnostic_runs TO findme_runtime;

ALTER TABLE diagnostic_runs FORCE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE,DELETE ON diagnostic_report_revisions TO findme_runtime;

ALTER TABLE diagnostic_report_revisions FORCE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE,DELETE ON diagnostic_report_sources TO findme_runtime;

ALTER TABLE diagnostic_report_sources FORCE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE,DELETE ON diagnostic_responses TO findme_runtime;

ALTER TABLE diagnostic_responses FORCE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE,DELETE ON source_blobs TO findme_runtime;

ALTER TABLE source_blobs FORCE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_diagnostic_jobs TO findme_runtime;

ALTER TABLE cloud_diagnostic_jobs FORCE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_diagnostic_attempts TO findme_runtime;

ALTER TABLE cloud_diagnostic_attempts FORCE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_inference_budgets TO findme_runtime;

ALTER TABLE cloud_inference_budgets FORCE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE,DELETE ON source_qualifications TO findme_runtime;

ALTER TABLE source_qualifications FORCE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE,DELETE ON core_import_batches TO findme_runtime;

ALTER TABLE core_import_batches FORCE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE,DELETE ON core_lifecycle_actions TO findme_runtime;

ALTER TABLE core_lifecycle_actions FORCE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_framework_states TO findme_runtime;

ALTER TABLE cloud_framework_states FORCE ROW LEVEL SECURITY;

-- Apply this access script AFTER migrations (including archive adoption). It can
-- also precede supplemental DDL; reapply after creating/adopting archive tables.
-- Preserve transitional owner access: no FORCE RLS and no archive INSERT/UPDATE.
DO $$ BEGIN
 IF to_regclass('public.av_processed_batches') IS NOT NULL
    AND to_regclass('public.av_processed_chunks') IS NOT NULL THEN
   ALTER TABLE av_processed_batches ENABLE ROW LEVEL SECURITY;
   DROP POLICY IF EXISTS account_runtime_scope ON av_processed_batches;
   DROP POLICY IF EXISTS account_runtime_delete ON av_processed_batches;
   CREATE POLICY account_runtime_scope ON av_processed_batches FOR SELECT TO findme_runtime
     USING (tenant_id::text=current_setting('app.tenant_id',true)
       AND subject_id::text=current_setting('app.subject_id',true));
   CREATE POLICY account_runtime_delete ON av_processed_batches FOR DELETE TO findme_runtime
     USING (tenant_id::text=current_setting('app.tenant_id',true)
       AND subject_id::text=current_setting('app.subject_id',true));
   GRANT SELECT,DELETE ON av_processed_batches TO findme_runtime;

   ALTER TABLE av_processed_chunks ENABLE ROW LEVEL SECURITY;
   DROP POLICY IF EXISTS account_runtime_scope ON av_processed_chunks;
   DROP POLICY IF EXISTS account_runtime_delete ON av_processed_chunks;
   CREATE POLICY account_runtime_scope ON av_processed_chunks FOR SELECT TO findme_runtime
     USING (tenant_id::text=current_setting('app.tenant_id',true)
       AND subject_id::text=current_setting('app.subject_id',true));
   CREATE POLICY account_runtime_delete ON av_processed_chunks FOR DELETE TO findme_runtime
     USING (tenant_id::text=current_setting('app.tenant_id',true)
       AND subject_id::text=current_setting('app.subject_id',true));
   GRANT SELECT,DELETE ON av_processed_chunks TO findme_runtime;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.findme_check_revision_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='source_assessments' AND (to_jsonb(NEW)->>'supersedes_id') IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.source_assessments r WHERE r.id=(to_jsonb(NEW)->>'supersedes_id')::uuid AND r.source_item_id=(to_jsonb(NEW)->>'source_item_id')::uuid) THEN RAISE EXCEPTION 'REVISION_PARENT_SCOPE'; END IF;
 ELSIF TG_TABLE_NAME='claim_revisions' AND (to_jsonb(NEW)->>'supersedes_revision_id') IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.claim_revisions r WHERE r.id=(to_jsonb(NEW)->>'supersedes_revision_id')::uuid AND r.claim_id=(to_jsonb(NEW)->>'claim_id')::uuid) THEN RAISE EXCEPTION 'REVISION_PARENT_SCOPE'; END IF;
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS findme_assessment_parent ON source_assessments;

CREATE TRIGGER findme_assessment_parent BEFORE INSERT OR UPDATE OF supersedes_id,source_item_id ON source_assessments FOR EACH ROW EXECUTE FUNCTION public.findme_check_revision_parent();

DROP TRIGGER IF EXISTS findme_claim_parent ON claim_revisions;

CREATE TRIGGER findme_claim_parent BEFORE INSERT OR UPDATE OF supersedes_revision_id,claim_id ON claim_revisions FOR EACH ROW EXECUTE FUNCTION public.findme_check_revision_parent();

COMMIT;

-- Do not grant any of these group roles to the existing shared runtime account blindly.

-- Create separate LOGIN credentials out-of-band and grant exactly one matching group role.

-- Require NOSUPERUSER/NOBYPASSRLS and non-owner runtime logins. No password is stored here.

-- A rollback is a service/configuration rollback using the preserved migration snapshot and backup;

-- never disable RLS for an online multi-account service as a quick workaround.
