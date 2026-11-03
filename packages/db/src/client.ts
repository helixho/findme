import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as archiveSchema from "./schema-archive.js";
import * as authSchema from "./schema-auth.js";
import * as coreSchema from "./schema-core.js";
import * as diagnosticSchema from "./schema-diagnostic.js";
import * as knowledgeSchema from "./schema-knowledge.js";
import * as platformSchema from "./schema-platform.js";
import * as specialistSchema from "./schema-specialist.js";
import * as legacySchema from "./schema.js";

export function createDb(
  url: string,
  opts: { max?: number; idleTimeout?: number; prepare?: boolean } = {},
) {
  const sql = postgres(url, {
    max: opts.max ?? 3,
    idle_timeout: opts.idleTimeout ?? 30,
    // Neon pooled connections and Cloudflare Hyperdrive both require the
    // extended-query protocol to stay disabled. Direct local/test databases
    // work with the same setting and keep the runtime behavior consistent.
    prepare: opts.prepare ?? false,
  });
  const schema = {
    ...archiveSchema,
    ...legacySchema,
    ...coreSchema,
    ...diagnosticSchema,
    ...authSchema,
    ...platformSchema,
    ...specialistSchema,
    ...knowledgeSchema,
  };
  return { db: drizzle(sql, { schema }), sql };
}
export type Db = ReturnType<typeof createDb>["db"];
