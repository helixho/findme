CREATE TABLE public.pi_request_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenants(id),
 subject_id uuid NOT NULL REFERENCES public.subjects(id), conversation_id text NOT NULL,
 operation_id uuid NOT NULL REFERENCES public.core_operations(id), attempt_id uuid NOT NULL, sequence integer NOT NULL CHECK(sequence>0),
 dependencies jsonb NOT NULL, pi_input jsonb, provider_payload jsonb, output jsonb,
 status text NOT NULL DEFAULT 'prepared', reserved_usd double precision,
 provider_actual_usd double precision, estimated_cost_usd double precision,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pi_request_records_identity ON public.pi_request_records(tenant_id,subject_id,operation_id,attempt_id,sequence);

ALTER TABLE pi_request_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_request_records FORCE ROW LEVEL SECURITY;
CREATE POLICY account_runtime_scope ON pi_request_records FOR ALL TO findme_runtime
 USING(tenant_id::text=current_setting('app.tenant_id',true) AND subject_id::text=current_setting('app.subject_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) AND subject_id::text=current_setting('app.subject_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON pi_request_records TO findme_runtime;
