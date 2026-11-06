CREATE TABLE public.pi_session_archives (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id),
 subject_id uuid NOT NULL REFERENCES public.subjects(id),
 conversation_id text NOT NULL,
 session_id text NOT NULL,
 revision integer NOT NULL CHECK (revision > 0),
 fingerprint text NOT NULL,
 dependencies jsonb NOT NULL,
 archive jsonb,
 status text NOT NULL DEFAULT 'available',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pi_session_archives_revision_unique ON public.pi_session_archives(tenant_id,subject_id,conversation_id,session_id,revision);

ALTER TABLE pi_session_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_session_archives FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_runtime_scope ON pi_session_archives;
CREATE POLICY account_runtime_scope ON pi_session_archives FOR ALL TO findme_runtime
 USING (tenant_id::text=current_setting('app.tenant_id',true) AND subject_id::text=current_setting('app.subject_id',true))
 WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true) AND subject_id::text=current_setting('app.subject_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON pi_session_archives TO findme_runtime;
