-- FindMe database structure: the current definition, applied as a whole to an empty database.
-- Every change here also needs an upgrade script in migrations/ so existing databases keep their data.
-- Access roles, grants and row-level policies for the runtime accounts live in access/account-runtime.sql.

CREATE TABLE public.app_settings (
    key text NOT NULL PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.schema_migrations (
    name text NOT NULL PRIMARY KEY,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.auth_accounts (
    id text NOT NULL,
    "userId" text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.auth_rate_limits (
    id text NOT NULL,
    key text NOT NULL,
    count integer NOT NULL,
    "lastRequest" bigint NOT NULL
);

CREATE TABLE public.auth_sessions (
    id text NOT NULL,
    "userId" text NOT NULL,
    token text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.auth_users (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean DEFAULT false NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.auth_verifications (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.av_processed_batches (
    tenant_id uuid CONSTRAINT _expected_av_processed_batches_tenant_id_not_null NOT NULL,
    subject_id uuid CONSTRAINT _expected_av_processed_batches_subject_id_not_null NOT NULL,
    namespace text CONSTRAINT _expected_av_processed_batches_namespace_not_null NOT NULL,
    batch_hash text CONSTRAINT _expected_av_processed_batches_batch_hash_not_null NOT NULL,
    manifest jsonb CONSTRAINT _expected_av_processed_batches_manifest_not_null NOT NULL,
    status text DEFAULT 'staging'::text CONSTRAINT _expected_av_processed_batches_status_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT _expected_av_processed_batches_created_at_not_null NOT NULL,
    CONSTRAINT av_processed_batches_batch_hash_check CHECK ((batch_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT av_processed_batches_manifest_check CHECK (((manifest ->> 'format'::text) = 'findme-av-processed-archive@2'::text)),
    CONSTRAINT av_processed_batches_status_check CHECK ((status = ANY (ARRAY['staging'::text, 'complete'::text])))
);

CREATE TABLE public.av_processed_chunks (
    tenant_id uuid CONSTRAINT _expected_av_processed_chunks_tenant_id_not_null NOT NULL,
    subject_id uuid CONSTRAINT _expected_av_processed_chunks_subject_id_not_null NOT NULL,
    namespace text CONSTRAINT _expected_av_processed_chunks_namespace_not_null NOT NULL,
    batch_hash text CONSTRAINT _expected_av_processed_chunks_batch_hash_not_null NOT NULL,
    artifact_hash text CONSTRAINT _expected_av_processed_chunks_artifact_hash_not_null NOT NULL,
    part integer CONSTRAINT _expected_av_processed_chunks_part_not_null NOT NULL,
    part_hash text CONSTRAINT _expected_av_processed_chunks_part_hash_not_null NOT NULL,
    payload bytea CONSTRAINT _expected_av_processed_chunks_payload_not_null NOT NULL,
    CONSTRAINT av_processed_chunks_artifact_hash_check CHECK ((artifact_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT av_processed_chunks_check CHECK ((encode(sha256(payload), 'hex'::text) = part_hash)),
    CONSTRAINT av_processed_chunks_part_check CHECK ((part >= 0)),
    CONSTRAINT av_processed_chunks_part_hash_check CHECK ((part_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT av_processed_chunks_payload_check CHECK ((octet_length(payload) <= 196608))
);

CREATE TABLE public.claim_evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    claim_revision_id uuid NOT NULL,
    evidence_span_id uuid NOT NULL,
    relation text NOT NULL,
    directness text NOT NULL,
    contribution text NOT NULL,
    independence_group text NOT NULL,
    scope_match text NOT NULL,
    rationale text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.claim_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    claim_id uuid NOT NULL,
    version integer NOT NULL,
    mode text NOT NULL,
    text text NOT NULL,
    scope text NOT NULL,
    status text DEFAULT 'current'::text NOT NULL,
    confidence_level text NOT NULL,
    confidence_basis text NOT NULL,
    revision_reason text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    supersedes_revision_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    evidence_status text DEFAULT 'valid'::text NOT NULL,
    invalidated_at timestamp with time zone,
    invalidation_reason text
);

CREATE TABLE public.claims (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    claim_key text NOT NULL,
    claim_kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.cloud_diagnostic_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    job_id uuid NOT NULL,
    phase text NOT NULL,
    execution uuid NOT NULL,
    status text DEFAULT 'reserved'::text NOT NULL,
    input_hash text NOT NULL,
    raw text,
    result jsonb,
    usage jsonb,
    model text,
    estimate jsonb,
    latency_ms integer,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);

ALTER TABLE ONLY public.cloud_diagnostic_attempts FORCE ROW LEVEL SECURITY;

CREATE TABLE public.cloud_diagnostic_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    run_id uuid NOT NULL,
    basis_version integer NOT NULL,
    fingerprint text NOT NULL,
    model text NOT NULL,
    input jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    stage text DEFAULT 'qualification'::text NOT NULL,
    call_cap integer NOT NULL,
    calls_used integer DEFAULT 0 NOT NULL,
    execution uuid,
    lease_until timestamp with time zone,
    report_id uuid,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_jobs_budget CHECK (((call_cap >= 0) AND (calls_used >= 0) AND (calls_used <= call_cap)))
);

ALTER TABLE ONLY public.cloud_diagnostic_jobs FORCE ROW LEVEL SECURITY;

CREATE TABLE public.cloud_framework_states (
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    state jsonb NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    content_hash text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.cloud_framework_states FORCE ROW LEVEL SECURITY;

CREATE TABLE public.cloud_inference_budgets (
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    calls_used integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.cloud_inference_budgets FORCE ROW LEVEL SECURITY;

CREATE TABLE public.core_import_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    input_hash text NOT NULL,
    status text DEFAULT 'preview'::text NOT NULL,
    payload jsonb NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    committed_at timestamp with time zone
);

ALTER TABLE ONLY public.core_import_batches FORCE ROW LEVEL SECURITY;

CREATE TABLE public.core_lifecycle_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    source_id uuid,
    kind text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.core_lifecycle_actions FORCE ROW LEVEL SECURITY;

CREATE TABLE public.core_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    exploration_id uuid,
    idempotency_key text NOT NULL,
    operation_type text NOT NULL,
    request_hash text NOT NULL,
    status text DEFAULT 'processing'::text NOT NULL,
    basis_version integer,
    lease_expires_at timestamp with time zone,
    response_status integer,
    response_body jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);

CREATE TABLE public.diagnostic_report_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    run_id uuid NOT NULL,
    version integer NOT NULL,
    basis_version integer NOT NULL,
    status text DEFAULT 'candidate'::text NOT NULL,
    format text DEFAULT 'understanding-report@1'::text NOT NULL,
    body jsonb NOT NULL,
    content_hash text NOT NULL,
    input_hash text NOT NULL,
    policy_version text NOT NULL,
    prompt_version text NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    job_id uuid,
    CONSTRAINT diagnostic_reports_states CHECK ((status = ANY (ARRAY['candidate'::text, 'accepted'::text, 'rejected'::text, 'needs_review'::text, 'withdrawn'::text]))),
    CONSTRAINT diagnostic_reports_versions CHECK (((version > 0) AND (basis_version > 0)))
);

ALTER TABLE ONLY public.diagnostic_report_revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE public.diagnostic_report_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    report_revision_id uuid NOT NULL,
    evidence_id text NOT NULL,
    source_id uuid NOT NULL,
    span_id uuid NOT NULL,
    assessment_version integer NOT NULL,
    source_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.diagnostic_report_sources FORCE ROW LEVEL SECURITY;

CREATE TABLE public.diagnostic_responses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    run_id uuid NOT NULL,
    report_revision_id uuid,
    source_id uuid,
    kind text NOT NULL,
    note text NOT NULL,
    basis_version integer NOT NULL,
    result_version integer NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    processing_status text DEFAULT 'recorded'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT diagnostic_responses_states CHECK ((processing_status = ANY (ARRAY['recorded'::text, 'qualified'::text, 'rejected'::text, 'processed'::text])))
);

ALTER TABLE ONLY public.diagnostic_responses FORCE ROW LEVEL SECURITY;

CREATE TABLE public.diagnostic_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    domain text NOT NULL,
    question text NOT NULL,
    status text DEFAULT 'awaiting_input'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    head_version integer DEFAULT 0 NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT diagnostic_runs_states CHECK ((status = ANY (ARRAY['awaiting_input'::text, 'pending'::text, 'review_pending'::text, 'ready'::text, 'needs_review'::text, 'archived'::text]))),
    CONSTRAINT diagnostic_runs_versions CHECK (((version > 0) AND (head_version >= 0)))
);

ALTER TABLE ONLY public.diagnostic_runs FORCE ROW LEVEL SECURITY;

CREATE TABLE public.evidence_spans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_item_id uuid NOT NULL,
    quote text NOT NULL,
    locator jsonb DEFAULT '{}'::jsonb,
    author_kind text NOT NULL,
    about_subject boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.experience_evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    experience_id uuid NOT NULL,
    evidence_span_id uuid NOT NULL,
    relation text DEFAULT 'describes'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.experiences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    summary text NOT NULL,
    occurred_at timestamp with time zone,
    context jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'current'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.exploration_questions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    exploration_id uuid NOT NULL,
    sequence integer NOT NULL,
    question text NOT NULL,
    intent text NOT NULL,
    quick_options jsonb DEFAULT '[]'::jsonb,
    model_meta jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    answered_at timestamp with time zone
);

CREATE TABLE public.exploration_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    exploration_id uuid NOT NULL,
    sequence integer NOT NULL,
    basis_version integer NOT NULL,
    input_turn_id uuid,
    current_reading text NOT NULL,
    key_uncertainty text,
    decision text NOT NULL,
    intent text NOT NULL,
    stop_reason text,
    question_id uuid,
    model_meta jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.exploration_turns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    exploration_id uuid NOT NULL,
    question_id uuid,
    source_item_id uuid,
    role text NOT NULL,
    turn_kind text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.explorations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    experience_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    ext jsonb DEFAULT '{}'::jsonb,
    version integer DEFAULT 1 NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.feedback_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    exploration_id uuid,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    feedback_type text NOT NULL,
    note text NOT NULL,
    source_item_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.identity_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    principal_id text NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.knowledge_gaps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    exploration_id uuid NOT NULL,
    gap_key text NOT NULL,
    question text NOT NULL,
    why_it_matters text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);

CREATE TABLE public.knowledge_processing_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    topic_key text NOT NULL,
    version integer NOT NULL,
    record_type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_processing_type_check CHECK ((record_type = ANY (ARRAY['topic_result'::text, 'feedback'::text]))),
    CONSTRAINT knowledge_processing_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY public.knowledge_processing_records FORCE ROW LEVEL SECURITY;

CREATE TABLE public.profile_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    principal_id text NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    creation_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT profile_membership_state CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text, 'deleted'::text])))
);

CREATE TABLE public.source_assessments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_item_id uuid NOT NULL,
    version integer NOT NULL,
    attribution_status text NOT NULL,
    context_completeness text NOT NULL,
    temporal_precision text NOT NULL,
    eligibility text NOT NULL,
    rationale text NOT NULL,
    is_current boolean DEFAULT true NOT NULL,
    supersedes_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.source_blobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    source_item_id uuid NOT NULL,
    object_key text NOT NULL,
    content_sha256 text NOT NULL,
    byte_length integer NOT NULL,
    media_type text NOT NULL,
    status text DEFAULT 'declared'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    CONSTRAINT source_blobs_size CHECK (((byte_length >= 0) AND (byte_length <= 52428800))),
    CONSTRAINT source_blobs_states CHECK ((status = ANY (ARRAY['declared'::text, 'uploading'::text, 'available'::text, 'excluded'::text, 'delete_pending'::text, 'deleted'::text])))
);

ALTER TABLE ONLY public.source_blobs FORCE ROW LEVEL SECURITY;

CREATE TABLE public.source_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    source_kind text NOT NULL,
    author_kind text NOT NULL,
    content text NOT NULL,
    occurred_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    external_ref text,
    source_meta jsonb DEFAULT '{}'::jsonb,
    usage_status text DEFAULT 'active'::text NOT NULL
);

CREATE TABLE public.source_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_item_id uuid NOT NULL,
    target_source_item_id uuid NOT NULL,
    relation text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.source_qualifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    source_id uuid NOT NULL,
    source_hash text NOT NULL,
    assessment_version integer NOT NULL,
    rules_hash text NOT NULL,
    job_id uuid NOT NULL,
    facts jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.source_qualifications FORCE ROW LEVEL SECURITY;

CREATE TABLE public.specialist_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    session_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    adjustment_kind text NOT NULL,
    action_text text NOT NULL,
    burden text NOT NULL,
    cost text NOT NULL,
    unknowns text NOT NULL,
    personal_basis jsonb NOT NULL,
    applicability jsonb NOT NULL,
    content_basis jsonb NOT NULL,
    evidence_mode text DEFAULT 'content_supported'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decision_note text,
    CONSTRAINT specialist_proposals_evidence_mode_check CHECK ((evidence_mode = ANY (ARRAY['content_supported'::text, 'exploratory'::text]))),
    CONSTRAINT specialist_proposals_kind_check CHECK ((adjustment_kind = ANY (ARRAY['environment'::text, 'task_structure'::text, 'written_instruction'::text, 'distraction_reduction'::text, 'movement_break'::text]))),
    CONSTRAINT specialist_proposals_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'accepted'::text, 'rejected'::text, 'paused'::text])))
);

ALTER TABLE ONLY public.specialist_proposals FORCE ROW LEVEL SECURITY;

CREATE TABLE public.specialist_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    pathway text NOT NULL,
    voluntary text NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    context_source_id uuid,
    difficulty_categories jsonb DEFAULT '[]'::jsonb NOT NULL,
    scope_flags jsonb DEFAULT '[]'::jsonb NOT NULL,
    environment_categories jsonb DEFAULT '[]'::jsonb NOT NULL,
    self_reported_diagnosis text,
    skipped_steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT specialist_sessions_diagnosis_check CHECK (((self_reported_diagnosis IS NULL) OR (self_reported_diagnosis = ANY (ARRAY['diagnosed'::text, 'concern'::text, 'none'::text, 'prefer_not_to_say'::text])))),
    CONSTRAINT specialist_sessions_pathway_check CHECK ((pathway = ANY (ARRAY['general'::text, 'adhd'::text]))),
    CONSTRAINT specialist_sessions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'paused'::text, 'completed'::text]))),
    CONSTRAINT specialist_sessions_voluntary_check CHECK ((voluntary = 'yes'::text))
);

ALTER TABLE ONLY public.specialist_sessions FORCE ROW LEVEL SECURITY;

CREATE TABLE public.specialist_trials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    proposal_id uuid NOT NULL,
    session_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    accepted_action text NOT NULL,
    accepted_proposal_version integer NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    latest_execution text,
    latest_outcome text,
    continue_trial text,
    reviewed_at timestamp with time zone,
    review_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT specialist_trials_execution_check CHECK (((latest_execution IS NULL) OR (latest_execution = ANY (ARRAY['completed'::text, 'not_executed'::text, 'partly_executed'::text, 'unknown'::text])))),
    CONSTRAINT specialist_trials_outcome_check CHECK (((latest_outcome IS NULL) OR (latest_outcome = ANY (ARRAY['helpful'::text, 'no_effect'::text, 'worse'::text, 'mixed'::text, 'unknown'::text])))),
    CONSTRAINT specialist_trials_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'completed'::text])))
);

ALTER TABLE ONLY public.specialist_trials FORCE ROW LEVEL SECURITY;

CREATE TABLE public.subjects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_type text DEFAULT 'self'::text NOT NULL,
    display_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ext jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ext jsonb DEFAULT '{}'::jsonb
);

ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT auth_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_key_unique UNIQUE (key);

ALTER TABLE ONLY public.auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_token_unique UNIQUE (token);

ALTER TABLE ONLY public.auth_users
    ADD CONSTRAINT auth_users_email_unique UNIQUE (email);

ALTER TABLE ONLY public.auth_users
    ADD CONSTRAINT auth_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_verifications
    ADD CONSTRAINT auth_verifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.av_processed_batches
    ADD CONSTRAINT av_processed_batches_pkey PRIMARY KEY (tenant_id, subject_id, namespace, batch_hash);

ALTER TABLE ONLY public.av_processed_chunks
    ADD CONSTRAINT av_processed_chunks_pkey PRIMARY KEY (tenant_id, subject_id, namespace, batch_hash, artifact_hash, part);

ALTER TABLE ONLY public.claim_evidence
    ADD CONSTRAINT claim_evidence_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.claim_revisions
    ADD CONSTRAINT claim_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.claims
    ADD CONSTRAINT claims_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cloud_diagnostic_attempts
    ADD CONSTRAINT cloud_diagnostic_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cloud_diagnostic_jobs
    ADD CONSTRAINT cloud_diagnostic_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.core_import_batches
    ADD CONSTRAINT core_import_batches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.core_lifecycle_actions
    ADD CONSTRAINT core_lifecycle_actions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.core_operations
    ADD CONSTRAINT core_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.diagnostic_report_revisions
    ADD CONSTRAINT diagnostic_report_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.diagnostic_report_sources
    ADD CONSTRAINT diagnostic_report_sources_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.diagnostic_responses
    ADD CONSTRAINT diagnostic_responses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.diagnostic_runs
    ADD CONSTRAINT diagnostic_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.evidence_spans
    ADD CONSTRAINT evidence_spans_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.experience_evidence
    ADD CONSTRAINT experience_evidence_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.experiences
    ADD CONSTRAINT experiences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.exploration_questions
    ADD CONSTRAINT exploration_questions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.exploration_steps
    ADD CONSTRAINT exploration_steps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.exploration_turns
    ADD CONSTRAINT exploration_turns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.explorations
    ADD CONSTRAINT explorations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feedback_events
    ADD CONSTRAINT feedback_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.identity_bindings
    ADD CONSTRAINT identity_bindings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.knowledge_gaps
    ADD CONSTRAINT knowledge_gaps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.knowledge_processing_records
    ADD CONSTRAINT knowledge_processing_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.profile_memberships
    ADD CONSTRAINT profile_memberships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.source_assessments
    ADD CONSTRAINT source_assessments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.source_blobs
    ADD CONSTRAINT source_blobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.source_items
    ADD CONSTRAINT source_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.source_links
    ADD CONSTRAINT source_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.source_qualifications
    ADD CONSTRAINT source_qualifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.specialist_proposals
    ADD CONSTRAINT specialist_proposals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.specialist_sessions
    ADD CONSTRAINT specialist_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.specialist_trials
    ADD CONSTRAINT specialist_trials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX auth_accounts_identity ON public.auth_accounts USING btree ("providerId", "accountId");

CREATE INDEX auth_accounts_user ON public.auth_accounts USING btree ("userId");

CREATE INDEX auth_sessions_user ON public.auth_sessions USING btree ("userId");

CREATE INDEX auth_verifications_identifier ON public.auth_verifications USING btree (identifier);

CREATE INDEX claim_evidence_revision_idx ON public.claim_evidence USING btree (claim_revision_id);

CREATE UNIQUE INDEX claim_evidence_unique ON public.claim_evidence USING btree (claim_revision_id, evidence_span_id, relation);

CREATE UNIQUE INDEX claim_revisions_one_current ON public.claim_revisions USING btree (claim_id) WHERE (status = 'current'::text);

CREATE UNIQUE INDEX claim_revisions_version_unique ON public.claim_revisions USING btree (claim_id, version);

CREATE UNIQUE INDEX claims_subject_key_unique ON public.claims USING btree (subject_id, claim_key);

CREATE INDEX claims_subject_kind_idx ON public.claims USING btree (subject_id, claim_kind);

CREATE INDEX cloud_attempt_phase ON public.cloud_diagnostic_attempts USING btree (job_id, phase, created_at);

CREATE UNIQUE INDEX cloud_budget_owner ON public.cloud_inference_budgets USING btree (tenant_id, subject_id);

CREATE UNIQUE INDEX cloud_framework_owner ON public.cloud_framework_states USING btree (tenant_id, subject_id);

CREATE UNIQUE INDEX cloud_jobs_fingerprint ON public.cloud_diagnostic_jobs USING btree (tenant_id, subject_id, fingerprint);

CREATE INDEX cloud_jobs_queue ON public.cloud_diagnostic_jobs USING btree (status, updated_at);

CREATE UNIQUE INDEX cloud_jobs_scope_id ON public.cloud_diagnostic_jobs USING btree (tenant_id, subject_id, id);

CREATE UNIQUE INDEX core_import_batch_input ON public.core_import_batches USING btree (tenant_id, subject_id, input_hash);

CREATE UNIQUE INDEX core_lifecycle_once ON public.core_lifecycle_actions USING btree (tenant_id, subject_id, idempotency_key);

CREATE INDEX core_operations_exploration_idx ON public.core_operations USING btree (exploration_id, created_at);

CREATE INDEX core_operations_status_lease_idx ON public.core_operations USING btree (status, lease_expires_at);

CREATE UNIQUE INDEX core_operations_tenant_idempotency_unique ON public.core_operations USING btree (tenant_id, idempotency_key);

CREATE UNIQUE INDEX diagnostic_report_evidence_unique ON public.diagnostic_report_sources USING btree (report_revision_id, evidence_id);

CREATE INDEX diagnostic_report_source_dependencies ON public.diagnostic_report_sources USING btree (tenant_id, subject_id, source_id);

CREATE UNIQUE INDEX diagnostic_reports_job_once ON public.diagnostic_report_revisions USING btree (job_id);

CREATE UNIQUE INDEX diagnostic_reports_run_version ON public.diagnostic_report_revisions USING btree (tenant_id, subject_id, run_id, version);

CREATE UNIQUE INDEX diagnostic_reports_scope_id ON public.diagnostic_report_revisions USING btree (tenant_id, subject_id, id);

CREATE UNIQUE INDEX diagnostic_responses_idempotency ON public.diagnostic_responses USING btree (tenant_id, subject_id, idempotency_key);

CREATE INDEX diagnostic_responses_run_time ON public.diagnostic_responses USING btree (run_id, created_at);

CREATE UNIQUE INDEX diagnostic_runs_idempotency ON public.diagnostic_runs USING btree (tenant_id, subject_id, idempotency_key);

CREATE INDEX diagnostic_runs_owner_updated ON public.diagnostic_runs USING btree (tenant_id, subject_id, updated_at);

CREATE UNIQUE INDEX diagnostic_runs_scope_id ON public.diagnostic_runs USING btree (tenant_id, subject_id, id);

CREATE UNIQUE INDEX evidence_spans_source_id_unique ON public.evidence_spans USING btree (source_item_id, id);

CREATE INDEX evidence_spans_source_idx ON public.evidence_spans USING btree (source_item_id);

CREATE UNIQUE INDEX experience_evidence_unique ON public.experience_evidence USING btree (experience_id, evidence_span_id, relation);

CREATE INDEX experiences_subject_time_idx ON public.experiences USING btree (subject_id, created_at);

CREATE UNIQUE INDEX exploration_questions_one_open ON public.exploration_questions USING btree (exploration_id) WHERE (status = 'open'::text);

CREATE UNIQUE INDEX exploration_questions_sequence_unique ON public.exploration_questions USING btree (exploration_id, sequence);

CREATE INDEX exploration_steps_exploration_idx ON public.exploration_steps USING btree (exploration_id, created_at);

CREATE UNIQUE INDEX exploration_steps_sequence_unique ON public.exploration_steps USING btree (exploration_id, sequence);

CREATE INDEX exploration_turns_exploration_idx ON public.exploration_turns USING btree (exploration_id, created_at);

CREATE INDEX explorations_subject_idx ON public.explorations USING btree (subject_id, created_at);

CREATE INDEX feedback_events_target_idx ON public.feedback_events USING btree (target_type, target_id);

CREATE UNIQUE INDEX identity_bindings_principal_unique ON public.identity_bindings USING btree (provider, principal_id);

CREATE INDEX identity_bindings_tenant_idx ON public.identity_bindings USING btree (tenant_id);

CREATE UNIQUE INDEX knowledge_gaps_key_unique ON public.knowledge_gaps USING btree (exploration_id, gap_key);

CREATE INDEX knowledge_processing_topic_idx ON public.knowledge_processing_records USING btree (tenant_id, subject_id, topic_key, created_at);

CREATE UNIQUE INDEX knowledge_processing_topic_version_unique ON public.knowledge_processing_records USING btree (tenant_id, subject_id, topic_key, version);

CREATE UNIQUE INDEX profile_memberships_creation ON public.profile_memberships USING btree (provider, principal_id, creation_key);

CREATE UNIQUE INDEX profile_memberships_identity ON public.profile_memberships USING btree (provider, principal_id, tenant_id, subject_id);

CREATE UNIQUE INDEX source_assessments_one_current ON public.source_assessments USING btree (source_item_id) WHERE (is_current = true);

CREATE UNIQUE INDEX source_assessments_version_unique ON public.source_assessments USING btree (source_item_id, version);

CREATE UNIQUE INDEX source_blobs_object_key ON public.source_blobs USING btree (object_key);

CREATE INDEX source_blobs_owner ON public.source_blobs USING btree (tenant_id, subject_id);

CREATE UNIQUE INDEX source_items_external_unique ON public.source_items USING btree (tenant_id, external_ref) WHERE (external_ref IS NOT NULL);

CREATE UNIQUE INDEX source_items_scope_id_unique ON public.source_items USING btree (tenant_id, subject_id, id);

CREATE INDEX source_items_tenant_time_idx ON public.source_items USING btree (tenant_id, created_at);

CREATE INDEX source_links_target_idx ON public.source_links USING btree (target_source_item_id, created_at);

CREATE UNIQUE INDEX source_links_unique ON public.source_links USING btree (source_item_id, target_source_item_id, relation);

CREATE UNIQUE INDEX source_qualification_version ON public.source_qualifications USING btree (source_id, source_hash, assessment_version, job_id);

CREATE UNIQUE INDEX specialist_proposals_idempotency ON public.specialist_proposals USING btree (tenant_id, subject_id, idempotency_key);

CREATE UNIQUE INDEX specialist_proposals_scope_id ON public.specialist_proposals USING btree (tenant_id, subject_id, id);

CREATE INDEX specialist_proposals_session_created ON public.specialist_proposals USING btree (tenant_id, subject_id, session_id, created_at);

CREATE UNIQUE INDEX specialist_sessions_idempotency ON public.specialist_sessions USING btree (tenant_id, subject_id, idempotency_key);

CREATE INDEX specialist_sessions_owner_updated ON public.specialist_sessions USING btree (tenant_id, subject_id, updated_at);

CREATE UNIQUE INDEX specialist_sessions_scope_id ON public.specialist_sessions USING btree (tenant_id, subject_id, id);

CREATE UNIQUE INDEX specialist_trials_proposal_unique ON public.specialist_trials USING btree (tenant_id, subject_id, proposal_id);

CREATE INDEX specialist_trials_session ON public.specialist_trials USING btree (tenant_id, subject_id, session_id, accepted_at);

CREATE UNIQUE INDEX subjects_one_self_per_tenant ON public.subjects USING btree (tenant_id) WHERE (subject_type = 'self'::text);

CREATE UNIQUE INDEX subjects_tenant_id_unique ON public.subjects USING btree (tenant_id, id);

CREATE INDEX subjects_tenant_idx ON public.subjects USING btree (tenant_id);

ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT "auth_accounts_userId_auth_users_id_fk" FOREIGN KEY ("userId") REFERENCES public.auth_users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT "auth_sessions_userId_auth_users_id_fk" FOREIGN KEY ("userId") REFERENCES public.auth_users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.av_processed_batches
    ADD CONSTRAINT av_processed_batches_subject_fk FOREIGN KEY (subject_id) REFERENCES public.subjects(id);

ALTER TABLE ONLY public.av_processed_batches
    ADD CONSTRAINT av_processed_batches_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.av_processed_chunks
    ADD CONSTRAINT av_processed_chunks_batch_fk FOREIGN KEY (tenant_id, subject_id, namespace, batch_hash) REFERENCES public.av_processed_batches(tenant_id, subject_id, namespace, batch_hash);

ALTER TABLE ONLY public.claim_evidence
    ADD CONSTRAINT claim_evidence_claim_revision_id_claim_revisions_id_fk FOREIGN KEY (claim_revision_id) REFERENCES public.claim_revisions(id);

ALTER TABLE ONLY public.claim_evidence
    ADD CONSTRAINT claim_evidence_evidence_span_id_evidence_spans_id_fk FOREIGN KEY (evidence_span_id) REFERENCES public.evidence_spans(id);

ALTER TABLE ONLY public.claim_revisions
    ADD CONSTRAINT claim_revisions_claim_id_claims_id_fk FOREIGN KEY (claim_id) REFERENCES public.claims(id);

ALTER TABLE ONLY public.claims
    ADD CONSTRAINT claims_subject_id_subjects_id_fk FOREIGN KEY (subject_id) REFERENCES public.subjects(id);

ALTER TABLE ONLY public.claims
    ADD CONSTRAINT claims_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.cloud_diagnostic_attempts
    ADD CONSTRAINT cloud_attempt_job FOREIGN KEY (tenant_id, subject_id, job_id) REFERENCES public.cloud_diagnostic_jobs(tenant_id, subject_id, id);

ALTER TABLE ONLY public.cloud_inference_budgets
    ADD CONSTRAINT cloud_budget_subject FOREIGN KEY (tenant_id, subject_id) REFERENCES public.subjects(tenant_id, id);

ALTER TABLE ONLY public.cloud_framework_states
    ADD CONSTRAINT cloud_framework_subject FOREIGN KEY (tenant_id, subject_id) REFERENCES public.subjects(tenant_id, id);

ALTER TABLE ONLY public.cloud_diagnostic_jobs
    ADD CONSTRAINT cloud_jobs_run FOREIGN KEY (tenant_id, subject_id, run_id) REFERENCES public.diagnostic_runs(tenant_id, subject_id, id);

ALTER TABLE ONLY public.core_import_batches
    ADD CONSTRAINT core_import_owner FOREIGN KEY (tenant_id, subject_id) REFERENCES public.subjects(tenant_id, id);

ALTER TABLE ONLY public.core_operations
    ADD CONSTRAINT core_operations_exploration_id_explorations_id_fk FOREIGN KEY (exploration_id) REFERENCES public.explorations(id);

ALTER TABLE ONLY public.core_operations
    ADD CONSTRAINT core_operations_subject_id_subjects_id_fk FOREIGN KEY (subject_id) REFERENCES public.subjects(id);

ALTER TABLE ONLY public.core_operations
    ADD CONSTRAINT core_operations_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.diagnostic_report_sources
    ADD CONSTRAINT diag_ref_assessment_fk FOREIGN KEY (source_id, assessment_version) REFERENCES public.source_assessments(source_item_id, version);

ALTER TABLE ONLY public.diagnostic_report_sources
    ADD CONSTRAINT diag_ref_report_fk FOREIGN KEY (tenant_id, subject_id, report_revision_id) REFERENCES public.diagnostic_report_revisions(tenant_id, subject_id, id);

ALTER TABLE ONLY public.diagnostic_report_sources
    ADD CONSTRAINT diag_ref_source_fk FOREIGN KEY (tenant_id, subject_id, source_id) REFERENCES public.source_items(tenant_id, subject_id, id);

ALTER TABLE ONLY public.diagnostic_report_sources
    ADD CONSTRAINT diag_ref_span_fk FOREIGN KEY (source_id, span_id) REFERENCES public.evidence_spans(source_item_id, id);

ALTER TABLE ONLY public.diagnostic_responses
    ADD CONSTRAINT diag_response_report_fk FOREIGN KEY (tenant_id, subject_id, report_revision_id) REFERENCES public.diagnostic_report_revisions(tenant_id, subject_id, id);

ALTER TABLE ONLY public.diagnostic_responses
    ADD CONSTRAINT diag_response_run_fk FOREIGN KEY (tenant_id, subject_id, run_id) REFERENCES public.diagnostic_runs(tenant_id, subject_id, id);

ALTER TABLE ONLY public.diagnostic_responses
    ADD CONSTRAINT diag_response_source_fk FOREIGN KEY (tenant_id, subject_id, source_id) REFERENCES public.source_items(tenant_id, subject_id, id);

ALTER TABLE ONLY public.diagnostic_report_revisions
    ADD CONSTRAINT diag_rev_run_fk FOREIGN KEY (tenant_id, subject_id, run_id) REFERENCES public.diagnostic_runs(tenant_id, subject_id, id);

ALTER TABLE ONLY public.diagnostic_runs
    ADD CONSTRAINT diag_run_owner_fk FOREIGN KEY (tenant_id, subject_id) REFERENCES public.subjects(tenant_id, id);

ALTER TABLE ONLY public.evidence_spans
    ADD CONSTRAINT evidence_spans_source_item_id_source_items_id_fk FOREIGN KEY (source_item_id) REFERENCES public.source_items(id);

ALTER TABLE ONLY public.experience_evidence
    ADD CONSTRAINT experience_evidence_evidence_span_id_evidence_spans_id_fk FOREIGN KEY (evidence_span_id) REFERENCES public.evidence_spans(id);

ALTER TABLE ONLY public.experience_evidence
    ADD CONSTRAINT experience_evidence_experience_id_experiences_id_fk FOREIGN KEY (experience_id) REFERENCES public.experiences(id);

ALTER TABLE ONLY public.experiences
    ADD CONSTRAINT experiences_subject_id_subjects_id_fk FOREIGN KEY (subject_id) REFERENCES public.subjects(id);

ALTER TABLE ONLY public.experiences
    ADD CONSTRAINT experiences_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.exploration_questions
    ADD CONSTRAINT exploration_questions_exploration_id_explorations_id_fk FOREIGN KEY (exploration_id) REFERENCES public.explorations(id);

ALTER TABLE ONLY public.exploration_steps
    ADD CONSTRAINT exploration_steps_exploration_id_explorations_id_fk FOREIGN KEY (exploration_id) REFERENCES public.explorations(id);

ALTER TABLE ONLY public.exploration_steps
    ADD CONSTRAINT exploration_steps_input_turn_id_exploration_turns_id_fk FOREIGN KEY (input_turn_id) REFERENCES public.exploration_turns(id);

ALTER TABLE ONLY public.exploration_steps
    ADD CONSTRAINT exploration_steps_question_id_exploration_questions_id_fk FOREIGN KEY (question_id) REFERENCES public.exploration_questions(id);

ALTER TABLE ONLY public.exploration_turns
    ADD CONSTRAINT exploration_turns_exploration_id_explorations_id_fk FOREIGN KEY (exploration_id) REFERENCES public.explorations(id);

ALTER TABLE ONLY public.exploration_turns
    ADD CONSTRAINT exploration_turns_question_id_exploration_questions_id_fk FOREIGN KEY (question_id) REFERENCES public.exploration_questions(id);

ALTER TABLE ONLY public.exploration_turns
    ADD CONSTRAINT exploration_turns_source_item_id_source_items_id_fk FOREIGN KEY (source_item_id) REFERENCES public.source_items(id);

ALTER TABLE ONLY public.explorations
    ADD CONSTRAINT explorations_experience_id_experiences_id_fk FOREIGN KEY (experience_id) REFERENCES public.experiences(id);

ALTER TABLE ONLY public.explorations
    ADD CONSTRAINT explorations_subject_id_subjects_id_fk FOREIGN KEY (subject_id) REFERENCES public.subjects(id);

ALTER TABLE ONLY public.explorations
    ADD CONSTRAINT explorations_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.feedback_events
    ADD CONSTRAINT feedback_events_exploration_id_explorations_id_fk FOREIGN KEY (exploration_id) REFERENCES public.explorations(id);

ALTER TABLE ONLY public.feedback_events
    ADD CONSTRAINT feedback_events_source_item_id_source_items_id_fk FOREIGN KEY (source_item_id) REFERENCES public.source_items(id);

ALTER TABLE ONLY public.feedback_events
    ADD CONSTRAINT feedback_events_subject_id_subjects_id_fk FOREIGN KEY (subject_id) REFERENCES public.subjects(id);

ALTER TABLE ONLY public.feedback_events
    ADD CONSTRAINT feedback_events_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.identity_bindings
    ADD CONSTRAINT identity_bindings_subject_id_subjects_id_fk FOREIGN KEY (subject_id) REFERENCES public.subjects(id);

ALTER TABLE ONLY public.identity_bindings
    ADD CONSTRAINT identity_bindings_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.knowledge_gaps
    ADD CONSTRAINT knowledge_gaps_exploration_id_explorations_id_fk FOREIGN KEY (exploration_id) REFERENCES public.explorations(id);

ALTER TABLE ONLY public.knowledge_processing_records
    ADD CONSTRAINT knowledge_processing_subject_fk FOREIGN KEY (tenant_id, subject_id) REFERENCES public.subjects(tenant_id, id);

ALTER TABLE ONLY public.profile_memberships
    ADD CONSTRAINT profile_membership_subject FOREIGN KEY (tenant_id, subject_id) REFERENCES public.subjects(tenant_id, id);

ALTER TABLE ONLY public.source_assessments
    ADD CONSTRAINT source_assessments_source_item_id_source_items_id_fk FOREIGN KEY (source_item_id) REFERENCES public.source_items(id);

ALTER TABLE ONLY public.source_blobs
    ADD CONSTRAINT source_blob_owner_fk FOREIGN KEY (tenant_id, subject_id) REFERENCES public.subjects(tenant_id, id);

ALTER TABLE ONLY public.source_items
    ADD CONSTRAINT source_items_subject_id_subjects_id_fk FOREIGN KEY (subject_id) REFERENCES public.subjects(id);

ALTER TABLE ONLY public.source_items
    ADD CONSTRAINT source_items_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.source_links
    ADD CONSTRAINT source_links_source_item_id_source_items_id_fk FOREIGN KEY (source_item_id) REFERENCES public.source_items(id);

ALTER TABLE ONLY public.source_links
    ADD CONSTRAINT source_links_target_source_item_id_source_items_id_fk FOREIGN KEY (target_source_item_id) REFERENCES public.source_items(id);

ALTER TABLE ONLY public.source_qualifications
    ADD CONSTRAINT source_qualification_source FOREIGN KEY (tenant_id, subject_id, source_id) REFERENCES public.source_items(tenant_id, subject_id, id);

ALTER TABLE ONLY public.specialist_proposals
    ADD CONSTRAINT specialist_proposal_owner_fk FOREIGN KEY (tenant_id, subject_id) REFERENCES public.subjects(tenant_id, id);

ALTER TABLE ONLY public.specialist_proposals
    ADD CONSTRAINT specialist_proposal_session_fk FOREIGN KEY (tenant_id, subject_id, session_id) REFERENCES public.specialist_sessions(tenant_id, subject_id, id);

ALTER TABLE ONLY public.specialist_sessions
    ADD CONSTRAINT specialist_session_owner_fk FOREIGN KEY (tenant_id, subject_id) REFERENCES public.subjects(tenant_id, id);

ALTER TABLE ONLY public.specialist_trials
    ADD CONSTRAINT specialist_trial_owner_fk FOREIGN KEY (tenant_id, subject_id) REFERENCES public.subjects(tenant_id, id);

ALTER TABLE ONLY public.specialist_trials
    ADD CONSTRAINT specialist_trial_proposal_fk FOREIGN KEY (tenant_id, subject_id, proposal_id) REFERENCES public.specialist_proposals(tenant_id, subject_id, id);

ALTER TABLE ONLY public.specialist_trials
    ADD CONSTRAINT specialist_trial_session_fk FOREIGN KEY (tenant_id, subject_id, session_id) REFERENCES public.specialist_sessions(tenant_id, subject_id, id);

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

CREATE POLICY cloud_attempt_scope ON public.cloud_diagnostic_attempts USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

CREATE POLICY cloud_budget_scope ON public.cloud_inference_budgets USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

ALTER TABLE public.cloud_diagnostic_attempts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.cloud_diagnostic_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY cloud_framework_scope ON public.cloud_framework_states USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

ALTER TABLE public.cloud_framework_states ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.cloud_inference_budgets ENABLE ROW LEVEL SECURITY;

CREATE POLICY cloud_jobs_scope ON public.cloud_diagnostic_jobs USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

ALTER TABLE public.core_import_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY core_import_scope ON public.core_import_batches USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

ALTER TABLE public.core_lifecycle_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY core_lifecycle_scope ON public.core_lifecycle_actions USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

CREATE POLICY diag_ref_scope ON public.diagnostic_report_sources USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

CREATE POLICY diag_response_scope ON public.diagnostic_responses USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

CREATE POLICY diag_rev_scope ON public.diagnostic_report_revisions USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

CREATE POLICY diag_run_scope ON public.diagnostic_runs USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

ALTER TABLE public.diagnostic_report_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.diagnostic_report_sources ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.diagnostic_responses ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.diagnostic_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.knowledge_processing_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_processing_scope ON public.knowledge_processing_records USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

CREATE POLICY source_blob_scope ON public.source_blobs USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

ALTER TABLE public.source_blobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY source_qualification_scope ON public.source_qualifications USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

ALTER TABLE public.source_qualifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY specialist_proposal_scope ON public.specialist_proposals USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

ALTER TABLE public.specialist_proposals ENABLE ROW LEVEL SECURITY;

CREATE POLICY specialist_session_scope ON public.specialist_sessions USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

ALTER TABLE public.specialist_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY specialist_trial_scope ON public.specialist_trials USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true)))) WITH CHECK ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) AND ((subject_id)::text = current_setting('app.subject_id'::text, true))));

ALTER TABLE public.specialist_trials ENABLE ROW LEVEL SECURITY;

ALTER TABLE ONLY public.source_blobs
    ADD CONSTRAINT source_blobs_source_item_id_source_items_id_fk FOREIGN KEY (source_item_id) REFERENCES public.source_items(id);

ALTER TABLE ONLY public.specialist_sessions
    ADD CONSTRAINT specialist_sessions_context_source_id_source_items_id_fk FOREIGN KEY (context_source_id) REFERENCES public.source_items(id);

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
