import type { OldClaim } from "../domain/understanding/types.js";
export type { OldClaim } from "../domain/understanding/types.js";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type Inventory, loadCoverageInventory } from "../dogfood/content-coverage.js";
import { contains, digest, fail, inside, noLinks, sha256 } from "./io.js";
const Id = z.string().min(1);
export const CoordinatorReview = z
  .object({
    format: z.literal("u1-coordinator-review@1"),
    reviewed_by: z.literal("coordinator_model"),
    owner_confirmed: z.literal(false),
    input_version_directory: Id,
    input_summary_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    topic_review: z.array(
      z
        .object({
          canonical_id: Id,
          evidence_id: Id,
          source_quote: Id,
          original_mapping: z.object({ topics: z.array(Id), status: Id, reason: Id }).passthrough(),
          action: z.enum(["propose_topic", "retain_referent_gap", "reconcile_proposition_facets"]),
          suggested_topics: z.array(Id),
          reason: Id,
          qualification_changed: z.literal(false),
        })
        .passthrough(),
    ),
    new_topic_candidates: z.record(z.string()),
    sample_review: z.array(
      z.object({ sample_id: Id, category: Id, adjudication: Id, reason: Id }).passthrough(),
    ),
    classification_variants: z
      .object({
        count: z.number().int().nonnegative(),
        by_type: z.unknown(),
        records: z.array(
          z
            .object({
              canonical_id: Id,
              row_ids: z.array(Id),
              assessment: z.enum(["wording_variation", "compatible_facets"]),
              reason: Id,
            })
            .passthrough(),
        ),
        action: z.unknown(),
      })
      .passthrough(),
  })
  .passthrough();
export type CoordinatorReview = z.infer<typeof CoordinatorReview>;
export type Destination = {
  canonical_id: string;
  id: string;
  eligible: boolean;
  attribution?: unknown;
  topic_mapping: {
    topics: string[];
    status: string;
    reason: string;
  } | null;
  [key: string]: unknown;
};
export type OmissionSample = {
  id: string;
  source_id: string;
  session_id: string;
  message_id: string;
  segment_id: string;
  canonical_id: string | null;
  windows: {
    start: number;
    end: number;
    text: string;
  }[];
  result: {
    quote?: string | null;
    start?: number | null;
    end?: number | null;
    [key: string]: unknown;
  } | null;
};

export type Inputs = {
  inventory: Inventory;
  review: CoordinatorReview;
  destinations: Destination[];
  taxonomy: unknown;
  samples: OmissionSample[];
  old: OldClaim[];
  input_hash: string;
  artifacts: {
    root: string;
    file: string;
    sha256: string | null;
  }[];
  source_version_directory: string;
  fresh: () => Promise<void>;
};
export async function loadInputs(batchPath: string, coveragePath: string): Promise<Inputs> {
  if (![batchPath, coveragePath].every(path.isAbsolute)) fail("ABSOLUTE_INPUT_REQUIRED");
  await noLinks(batchPath);
  await noLinks(coveragePath);
  const batch = await realpath(batchPath);
  const coverage = await realpath(coveragePath);
  const artifacts: Inputs["artifacts"] = [];
  async function read(root: string, file: string, optional = false) {
    const absolute = path.isAbsolute(file) ? file : path.join(root, file);
    try {
      const actual = await inside(root, absolute);
      const bytes = await readFile(actual);
      artifacts.push({ root, file: absolute, sha256: sha256(bytes) });
      return bytes;
    } catch (e) {
      if (!optional || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      artifacts.push({ root, file: absolute, sha256: null });
      return null;
    }
  }
  const json = async (root: string, file: string) =>
    JSON.parse(required(await read(root, file)).toString());
  // Check every source used by the existing loader, before it opens any path.
  const sourceFiles = [
    "manifest.json",
    "raw.json",
    "state.json",
    "L1/coverage.jsonl",
    "L1/evidence.jsonl",
    "L2/scenes.jsonl",
    "L3/current-understanding.json",
    "L3/reductions.json",
    "L3/reduction-source-map.json",
  ];
  for (const file of sourceFiles) await read(batch, file, file === "state.json");
  const inventory = await loadCoverageInventory(batch);
  for (const [name, sum] of Object.entries(inventory.bytes))
    if (artifacts.find((a) => a.file === path.join(batch, name))?.sha256 !== sum)
      fail("SOURCE_READ_RACE");
  const latest = z
    .object({ version: Id, directory: Id })
    .parse(await json(coverage, "latest.json"));
  const versionRoot = await inside(coverage, latest.directory);
  if (
    !contains(path.join(coverage, "versions"), versionRoot) ||
    path.basename(versionRoot) !== latest.version
  )
    fail("U1_VERSION_PATH_MISMATCH");
  const summary = await json(coverage, path.join(versionRoot, "summary.json"));
  const binding = await json(coverage, "run.json");
  if (
    summary.complete !== true ||
    summary.classification_pending !== 0 ||
    summary.fingerprint !== inventory.fingerprint ||
    binding.fingerprint !== inventory.fingerprint ||
    summary.source_fingerprint !== inventory.batch.manifest.sourceFingerprint ||
    digest(binding.source_bytes) !== digest(inventory.bytes)
  )
    fail("U1_SOURCE_BINDING_INVALID");
  const taxonomy = await json(coverage, path.join(versionRoot, "topics.json"));
  const destinationText = required(
    await read(coverage, path.join(versionRoot, "evidence-destinations.jsonl")),
  ).toString();
  const destinations: Destination[] = destinationText
    .split("\n")
    .filter((x) => x.trim())
    .map((x) =>
      z
        .object({
          canonical_id: Id,
          id: Id,
          eligible: z.boolean(),
          attribution: z.unknown(),
          topic_mapping: z
            .object({ topics: z.array(Id), status: Id, reason: Id })
            .passthrough()
            .nullable(),
        })
        .passthrough()
        .parse(JSON.parse(x)),
    );
  const rows = new Map(
    inventory.canonical.flatMap((c) => c.rows.map((r) => [r.id, c.id] as const)),
  );
  if (
    destinations.length !== rows.size ||
    new Set(destinations.map((d) => d.id)).size !== rows.size ||
    destinations.some((d) => rows.get(d.id) !== d.canonical_id)
  )
    fail("U1_DESTINATION_MEMBERSHIP_INVALID");
  const omission = await json(coverage, path.join(versionRoot, "omission-review.json"));
  const samples = z
    .array(
      z
        .object({
          id: Id,
          source_id: Id,
          session_id: Id,
          message_id: Id,
          segment_id: Id,
          canonical_id: Id.nullable(),
          windows: z.array(
            z
              .object({
                start: z.number().int().nonnegative(),
                end: z.number().int().positive(),
                text: z.string(),
              })
              .passthrough(),
          ),
          result: z.record(z.unknown()).nullable(),
        })
        .passthrough(),
    )
    .parse(omission.samples) as OmissionSample[];
  if (new Set(samples.map((s) => s.id)).size !== samples.length) fail("DUPLICATE_SAMPLE");
  const pointer = z
    .object({
      directory: Id,
      file: Id,
      content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      source_version_directory: Id,
    })
    .parse(await json(coverage, "latest-review.json"));
  if ((await inside(coverage, pointer.source_version_directory)) !== versionRoot)
    fail("REVIEW_WRONG_SOURCE_VERSION");
  const reviewDir = await inside(coverage, pointer.directory);
  const reviewFile = path.isAbsolute(pointer.file)
    ? pointer.file
    : path.join(reviewDir, pointer.file);
  if (!contains(reviewDir, reviewFile)) fail("REVIEW_FILE_ESCAPE");
  const reviewBytes = required(await read(coverage, reviewFile));
  if (sha256(reviewBytes) !== pointer.content_sha256) fail("REVIEW_CONTENT_HASH_MISMATCH");
  const review = CoordinatorReview.parse(JSON.parse(reviewBytes.toString()));
  if (
    (await inside(coverage, review.input_version_directory)) !== versionRoot ||
    review.input_summary_sha256 !==
      artifacts.find((a) => a.file === path.join(versionRoot, "summary.json"))?.sha256
  )
    fail("REVIEW_INPUT_BINDING_INVALID");
  if (review.classification_variants.count !== review.classification_variants.records.length)
    fail("VARIANT_COUNT_MISMATCH");
  for (const suggestion of review.topic_review) {
    const canonical = inventory.canonical.find((c) => c.id === suggestion.canonical_id);
    const row = canonical?.rows.find((r) => r.id === suggestion.evidence_id);
    const original = destinations.find((d) => d.id === suggestion.evidence_id)?.topic_mapping;
    if (
      !row ||
      row.quote !== suggestion.source_quote ||
      !original ||
      digest(original.topics) !== digest(suggestion.original_mapping.topics) ||
      original.status !== suggestion.original_mapping.status ||
      original.reason !== suggestion.original_mapping.reason
    )
      fail("REVIEW_TOPIC_REFERENCE_INVALID");
  }
  for (const group of review.classification_variants.records) {
    const c = inventory.canonical.find((c) => c.id === group.canonical_id);
    if (
      !c ||
      !group.row_ids.length ||
      new Set(group.row_ids).size !== group.row_ids.length ||
      group.row_ids.some((id) => !c.rows.some((r) => r.id === id))
    )
      fail("REVIEW_VARIANT_REFERENCE_INVALID");
  }
  for (const suggestion of review.sample_review)
    if (!samples.some((s) => s.id === suggestion.sample_id))
      fail("REVIEW_SAMPLE_REFERENCE_INVALID");
  const oldBytes = await readFile(await inside(batch, "L3/current-understanding.json"));
  const oldObject = JSON.parse(oldBytes.toString());
  const old: OldClaim[] = oldObject.claims.map((c: Omit<OldClaim, "id">, i: number) => ({
    ...c,
    kind: c.type ?? c.kind ?? "unknown",
    id: `old-${i + 1}-${sha256(oldBytes).slice(0, 16)}`,
  }));
  if (old.length > 12 || new Set(old.map((c) => c.id)).size !== old.length)
    fail("INVALID_OLD_CLAIM_SET");
  const fresh = async () => {
    for (const a of artifacts) {
      let actual: string | null = null;
      try {
        actual = sha256(await readFile(await inside(a.root, a.file)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (actual !== a.sha256) fail("INPUT_CHANGED");
    }
  };
  await fresh();
  return {
    inventory,
    review,
    taxonomy,
    destinations,
    samples,
    old,
    artifacts,
    input_hash: digest(artifacts),
    source_version_directory: versionRoot,
    fresh,
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("MISSING_REQUIRED_REFERENCE");
  return value;
}
