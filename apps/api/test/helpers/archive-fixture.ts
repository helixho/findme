import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { coreSchema as c, createDb, platformSchema as p } from "@findme/db";
import { Client } from "pg";

const root = new URL("../../../../", import.meta.url);
export const archiveFile = (path: string) => readFile(new URL(path, root), "utf8");
export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function archiveEnvironment() {
  const file = process.env.FINDME_ACCOUNT_VERIFY_CONFIG;
  const adminUrl = process.env.DATABASE_URL_TEST;
  if (!file || !adminUrl) throw new Error("ARCHIVE_ISOLATED_DB_CONFIG_REQUIRED");
  const cfg = JSON.parse(await readFile(file, "utf8"));
  if (cfg.database !== "findme_test" || !["127.0.0.1", "localhost"].includes(cfg.host))
    throw new Error("ARCHIVE_LOCAL_TEST_DATABASE_REQUIRED");
  for (const value of [adminUrl, cfg.runtime_url, cfg.identity_url, cfg.auth_url]) {
    const u = new URL(value);
    if (u.hostname !== cfg.host || u.pathname !== `/${cfg.database}`)
      throw new Error("ARCHIVE_ISOLATED_URL_MISMATCH");
  }
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const runtime = createDb(cfg.runtime_url, { max: 1 });
  const identity = createDb(cfg.identity_url);
  const auth = new Client({ connectionString: cfg.auth_url });
  await auth.connect();
  async function profile(tenantId?: string) {
    const ctx = { tenantId: tenantId ?? randomUUID(), subjectId: randomUUID() };
    await identity.db.transaction(async (tx) => {
      if (!tenantId) await tx.insert(c.tenants).values({ id: ctx.tenantId });
      // One self subject per tenant is a real invariant. The additional subject is
      // a synthetic lower-level scope probe, not another self/Profile created by the product UI.
      await tx.insert(c.subjects).values({
        id: ctx.subjectId,
        tenantId: ctx.tenantId,
        subjectType: tenantId ? "synthetic_scope_probe" : "self",
      });
      await tx.insert(p.profileMemberships).values({
        ...ctx,
        provider: "archive-test",
        principalId: randomUUID(),
        creationKey: randomUUID(),
      });
    });
    return ctx;
  }
  async function seed(
    ctx: { tenantId: string; subjectId: string },
    count = 1,
    namespace = "synthetic",
  ) {
    const batchHash = sha256(Buffer.from(namespace));
    const artifactHash = sha256(Buffer.from("synthetic artifact"));
    await admin.query(
      `INSERT INTO av_processed_batches(tenant_id,subject_id,namespace,batch_hash,manifest,status)
      VALUES ($1,$2,$3,$4,$5,'complete')`,
      [
        ctx.tenantId,
        ctx.subjectId,
        namespace,
        batchHash,
        { format: "findme-av-processed-archive@2", synthetic: true },
      ],
    );
    const payloads = [];
    for (let part = 0; part < count; part++) {
      const payload = Buffer.from([0, 255, 128, 92, part % 256, 10]);
      await admin.query("INSERT INTO av_processed_chunks VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
        ctx.tenantId,
        ctx.subjectId,
        namespace,
        batchHash,
        artifactHash,
        part,
        sha256(payload),
        payload,
      ]);
      payloads.push(payload);
    }
    return { batchHash, artifactHash, payloads };
  }
  return {
    admin,
    runtime,
    identity,
    auth,
    profile,
    seed,
    close: async () => {
      await Promise.all([admin.end(), runtime.sql.end(), identity.sql.end(), auth.end()]);
    },
  };
}
export type ArchiveEnvironment = Awaited<ReturnType<typeof archiveEnvironment>>;
