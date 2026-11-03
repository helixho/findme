import type { Db } from "@findme/db";
import { ProfileService } from "../auth/profiles.js";
import type { PersonalContext } from "../core/exploration-service.js";
import { human3Draft } from "../framework-runtime/definitions/human3-draft.js";
import { FrameworkService } from "../framework-runtime/service.js";
import type { createGateway } from "../llm/gateway.js";
import type { ArchiveUnderstandingRuntime } from "../understanding-app/archive-runtime.js";
import { type BlobStore, CloudBlobService } from "./blobs.js";
import { CloudExportService } from "./export.js";
import { PostgresFrameworkRepository } from "./frameworks.js";
import { CoreIngestService } from "./ingest.js";
import { CloudLifecycleService } from "./lifecycle.js";
import {
  type CloudProcessingOptions,
  CloudProcessingService,
  type CloudQueueMessage,
} from "./processing.js";
import { ProfilePurgeService } from "./purge.js";
import { CloudDiagnosticRepository } from "./repository.js";
import { U2ApprovedImportService } from "./u2-import.js";
export function createCloudServices(options: {
  db: Db;
  identityDb: Db;
  gateway?: ReturnType<typeof createGateway>;
  processing: CloudProcessingOptions;
  send?: (message: CloudQueueMessage) => Promise<void>;
  blobs?: BlobStore;
  allowDraftFrameworks?: boolean;
  frameworkCallLimit?: number;
  u2Archive?: ArchiveUnderstandingRuntime;
}) {
  const { db, gateway } = options;
  return {
    db,
    identityDb: options.identityDb,
    profiles: new ProfileService(options.identityDb),
    repository: new CloudDiagnosticRepository(db),
    processing: new CloudProcessingService(db, gateway, options.processing, options.send),
    blobs: new CloudBlobService(db, options.blobs),
    lifecycle: new CloudLifecycleService(db),
    ingest: new CoreIngestService(db),
    u2Import: options.u2Archive ? new U2ApprovedImportService(db, options.u2Archive) : undefined,
    export: new CloudExportService(db),
    purge: new ProfilePurgeService(db, options.blobs),
    framework(ctx: PersonalContext, callCap = 0) {
      let calls = 0;
      const guarded =
        gateway && options.processing.enabled
          ? {
              extract: ((args: Parameters<ReturnType<typeof createGateway>["extract"]>[0]) => {
                if (calls >= callCap) throw new Error("FRAMEWORK_INVOCATION_CAP_EXHAUSTED");
                calls++;
                return gateway.extract(args);
              }) as ReturnType<typeof createGateway>["extract"],
            }
          : undefined;
      return new FrameworkService({
        repository: new PostgresFrameworkRepository(db, ctx),
        ownerKey: `${ctx.tenantId}/${ctx.subjectId}`,
        definitions: [human3Draft],
        allowInternalDraft: options.allowDraftFrameworks,
        gateway: guarded,
        u4CallBudget: options.frameworkCallLimit ?? 0,
      });
    },
  };
}
export type CloudServices = ReturnType<typeof createCloudServices>;
