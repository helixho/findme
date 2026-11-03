CREATE TABLE IF NOT EXISTS "access_bootstrap_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_bootstrap_tokens_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_bootstrap_tokens_expiry_idx" ON "access_bootstrap_tokens" USING btree ("expires_at");