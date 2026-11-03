-- UNDEPLOYED CANDIDATE: additive archive adoption, no roles/grants/RLS activation.
-- Accept the exact supplemental DDL semantics; preserve bytes and existing RLS/policies.
-- Constraint names alone are normalized to the generated snapshot for future migrations.
DO $adopt$
DECLARE
  table_name text;
  actual_oid oid;
  expected_oid oid;
  signatures jsonb[];
  constraint_row record;
BEGIN
  IF (to_regclass('public.av_processed_batches') IS NULL) <>
     (to_regclass('public.av_processed_chunks') IS NULL) THEN
    RAISE EXCEPTION 'ARCHIVE_LEGACY_SHAPE_MISMATCH: incomplete table pair';
  END IF;
  IF to_regclass('public.av_processed_batches') IS NULL THEN
    EXECUTE $ddl$CREATE TABLE "public"."av_processed_batches" (
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"batch_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"status" text DEFAULT 'staging' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "av_processed_batches_pkey" PRIMARY KEY("tenant_id","subject_id","namespace","batch_hash"),
	CONSTRAINT "av_processed_batches_batch_hash_check" CHECK ("av_processed_batches"."batch_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "av_processed_batches_manifest_check" CHECK ("av_processed_batches"."manifest"->>'format'='findme-av-processed-archive@2'),
	CONSTRAINT "av_processed_batches_status_check" CHECK ("av_processed_batches"."status" IN ('staging','complete'))
);$ddl$;
    EXECUTE $ddl$CREATE TABLE "public"."av_processed_chunks" (
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"batch_hash" text NOT NULL,
	"artifact_hash" text NOT NULL,
	"part" integer NOT NULL,
	"part_hash" text NOT NULL,
	"payload" "bytea" NOT NULL,
	CONSTRAINT "av_processed_chunks_pkey" PRIMARY KEY("tenant_id","subject_id","namespace","batch_hash","artifact_hash","part"),
	CONSTRAINT "av_processed_chunks_artifact_hash_check" CHECK ("av_processed_chunks"."artifact_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "av_processed_chunks_part_check" CHECK ("av_processed_chunks"."part">=0),
	CONSTRAINT "av_processed_chunks_part_hash_check" CHECK ("av_processed_chunks"."part_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "av_processed_chunks_payload_check" CHECK (octet_length("av_processed_chunks"."payload")<=196608),
	CONSTRAINT "av_processed_chunks_check" CHECK (encode(sha256("av_processed_chunks"."payload"),'hex')="av_processed_chunks"."part_hash")
);$ddl$;
    EXECUTE $ddl$ALTER TABLE "public"."av_processed_batches" ADD CONSTRAINT "av_processed_batches_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;$ddl$;
    EXECUTE $ddl$ALTER TABLE "public"."av_processed_batches" ADD CONSTRAINT "av_processed_batches_subject_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;$ddl$;
    EXECUTE $ddl$ALTER TABLE "public"."av_processed_chunks" ADD CONSTRAINT "av_processed_chunks_batch_fk" FOREIGN KEY ("tenant_id","subject_id","namespace","batch_hash") REFERENCES "public"."av_processed_batches"("tenant_id","subject_id","namespace","batch_hash") ON DELETE no action ON UPDATE no action;$ddl$;
  END IF;
  LOCK TABLE public.av_processed_batches, public.av_processed_chunks IN ACCESS EXCLUSIVE MODE;
  CREATE SCHEMA _findme_archive_adoption;
  EXECUTE $ddl$CREATE TABLE "_findme_archive_adoption"."_expected_av_processed_batches" (
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"batch_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"status" text DEFAULT 'staging' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "av_processed_batches_pkey" PRIMARY KEY("tenant_id","subject_id","namespace","batch_hash"),
	CONSTRAINT "av_processed_batches_batch_hash_check" CHECK ("_expected_av_processed_batches"."batch_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "av_processed_batches_manifest_check" CHECK ("_expected_av_processed_batches"."manifest"->>'format'='findme-av-processed-archive@2'),
	CONSTRAINT "av_processed_batches_status_check" CHECK ("_expected_av_processed_batches"."status" IN ('staging','complete'))
);$ddl$;
  EXECUTE $ddl$CREATE TABLE "_findme_archive_adoption"."_expected_av_processed_chunks" (
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"batch_hash" text NOT NULL,
	"artifact_hash" text NOT NULL,
	"part" integer NOT NULL,
	"part_hash" text NOT NULL,
	"payload" "bytea" NOT NULL,
	CONSTRAINT "av_processed_chunks_pkey" PRIMARY KEY("tenant_id","subject_id","namespace","batch_hash","artifact_hash","part"),
	CONSTRAINT "av_processed_chunks_artifact_hash_check" CHECK ("_expected_av_processed_chunks"."artifact_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "av_processed_chunks_part_check" CHECK ("_expected_av_processed_chunks"."part">=0),
	CONSTRAINT "av_processed_chunks_part_hash_check" CHECK ("_expected_av_processed_chunks"."part_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "av_processed_chunks_payload_check" CHECK (octet_length("_expected_av_processed_chunks"."payload")<=196608),
	CONSTRAINT "av_processed_chunks_check" CHECK (encode(sha256("_expected_av_processed_chunks"."payload"),'hex')="_expected_av_processed_chunks"."part_hash")
);$ddl$;
  EXECUTE $ddl$ALTER TABLE "_findme_archive_adoption"."_expected_av_processed_batches" ADD CONSTRAINT "av_processed_batches_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;$ddl$;
  EXECUTE $ddl$ALTER TABLE "_findme_archive_adoption"."_expected_av_processed_batches" ADD CONSTRAINT "av_processed_batches_subject_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;$ddl$;
  EXECUTE $ddl$ALTER TABLE "_findme_archive_adoption"."_expected_av_processed_chunks" ADD CONSTRAINT "av_processed_chunks_batch_fk" FOREIGN KEY ("tenant_id","subject_id","namespace","batch_hash") REFERENCES "public"."av_processed_batches"("tenant_id","subject_id","namespace","batch_hash") ON DELETE no action ON UPDATE no action;$ddl$;

  FOREACH table_name IN ARRAY ARRAY['av_processed_batches','av_processed_chunks'] LOOP
    actual_oid := to_regclass('public.' || table_name);
    expected_oid := to_regclass('_findme_archive_adoption._expected_' || table_name);
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=actual_oid AND relkind='r' AND relpersistence='p' AND NOT relispartition)
       OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=actual_oid OR inhparent=actual_oid) THEN
      RAISE EXCEPTION 'ARCHIVE_LEGACY_SHAPE_MISMATCH: % table kind', table_name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=actual_oid AND NOT tgisinternal)
       OR EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class=actual_oid)
       OR EXISTS (SELECT 1 FROM pg_index WHERE indrelid=actual_oid AND NOT indisprimary) THEN
      RAISE EXCEPTION 'ARCHIVE_LEGACY_SHAPE_MISMATCH: % extra triggers/rules/indexes', table_name;
    END IF;
    SELECT array_agg(signature ORDER BY side) INTO signatures FROM (
      SELECT side, jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,
        a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,
        pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) AS signature
      FROM (VALUES (1,actual_oid),(2,expected_oid)) v(side,rel)
      JOIN pg_attribute a ON a.attrelid=v.rel AND a.attnum>0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      GROUP BY side
    ) q;
    IF signatures[1] IS DISTINCT FROM signatures[2] THEN
      RAISE EXCEPTION 'ARCHIVE_LEGACY_SHAPE_MISMATCH: % columns/defaults', table_name;
    END IF;
    SELECT array_agg(signature ORDER BY side) INTO signatures FROM (
      SELECT side, jsonb_agg(jsonb_build_array(c.contype,c.conkey,c.confrelid,c.confkey,
        c.confupdtype,c.confdeltype,c.confmatchtype,c.condeferrable,c.condeferred,
        c.convalidated,c.connoinherit,pg_get_expr(c.conbin,c.conrelid))
        ORDER BY c.contype,c.conkey,pg_get_expr(c.conbin,c.conrelid)) AS signature
      FROM (VALUES (1,actual_oid),(2,expected_oid)) v(side,rel)
      JOIN pg_constraint c ON c.conrelid=v.rel
      GROUP BY side
    ) q;
    IF signatures[1] IS DISTINCT FROM signatures[2] THEN
      RAISE EXCEPTION 'ARCHIVE_LEGACY_SHAPE_MISMATCH: % constraints', table_name;
    END IF;
    -- Names are not semantics, but future Drizzle diffs depend on canonical names.
    FOR constraint_row IN
      SELECT a.conname AS old_name, e.conname AS new_name
      FROM pg_constraint a JOIN pg_constraint e
        ON e.conrelid=expected_oid AND a.contype=e.contype
        AND a.conkey IS NOT DISTINCT FROM e.conkey
        AND pg_get_constraintdef(a.oid) = pg_get_constraintdef(e.oid)
      WHERE a.conrelid=actual_oid AND a.conname<>e.conname
    LOOP
      EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
        table_name,constraint_row.old_name,constraint_row.new_name);
    END LOOP;
  END LOOP;
  DROP TABLE _findme_archive_adoption._expected_av_processed_chunks, _findme_archive_adoption._expected_av_processed_batches;
  DROP SCHEMA _findme_archive_adoption;
END $adopt$;
