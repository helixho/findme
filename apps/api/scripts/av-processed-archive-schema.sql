-- Explicit supplemental DDL, not part of automatic db:migrate.
-- Only these two additive objects; no account enablement, roles, grants or RLS changes.
-- Caller must confirm the existing schema and personal tenant/subject before executing.
CREATE TABLE av_processed_batches (
  tenant_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  namespace text NOT NULL,
  batch_hash text NOT NULL CHECK (batch_hash ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL CHECK (manifest->>'format'='findme-av-processed-archive@2'),
  status text NOT NULL DEFAULT 'staging' CHECK (status IN ('staging','complete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,subject_id,namespace,batch_hash),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (subject_id) REFERENCES subjects(id)
);
CREATE TABLE av_processed_chunks (
  tenant_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  namespace text NOT NULL,
  batch_hash text NOT NULL,
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  part integer NOT NULL CHECK (part>=0),
  part_hash text NOT NULL CHECK (part_hash ~ '^[a-f0-9]{64}$'),
  payload bytea NOT NULL CHECK (octet_length(payload)<=196608),
  PRIMARY KEY (tenant_id,subject_id,namespace,batch_hash,artifact_hash,part),
  FOREIGN KEY (tenant_id,subject_id,namespace,batch_hash)
    REFERENCES av_processed_batches(tenant_id,subject_id,namespace,batch_hash),
  CHECK (encode(sha256(payload),'hex')=part_hash)
);
