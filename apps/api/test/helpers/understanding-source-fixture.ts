import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCoverageInventory } from "../../src/dogfood/content-coverage.js";
import { sha256 } from "../../src/understanding-baseline/io.js";
import { DOMAINS } from "../../src/understanding-baseline/prepare.js";
import type { UnderstandingOptions } from "../../src/understanding-baseline/runner.js";
import { makeUnderstandingSourceData } from "./understanding-source-data.js";

const put = async (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2));
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("REQUIRED");
  return value;
}

// Caller owns the per-test directory and cleanup. This writes source/U1 inputs only;
// baseline model stubs and App repository setup stay in their respective suites.
export async function writeUnderstandingSources(
  base: string,
  withRepairs: boolean,
  repoRoot: string,
) {
  const batch = path.join(base, "batch");
  const coverage = path.join(base, "coverage");
  const out = path.join(base, "u2");
  for (const dir of ["L1", "L2", "L3"]) await mkdir(path.join(batch, dir), { recursive: true });
  const { raw, manifest, atoms, coverageRows, scenes, claims, draft } =
    makeUnderstandingSourceData();
  await put(path.join(batch, "manifest.json"), manifest);
  await put(path.join(batch, "raw.json"), raw);
  await put(path.join(batch, "L3/current-understanding.json"), {
    ...draft,
    heldoutIncluded: false,
    sourceFingerprint: manifest.sourceFingerprint,
    source_cutoff: manifest.cutoffBefore,
    context_only_ids: ["e8", "e9", "e10"],
  });
  await put(path.join(batch, "L3/reductions.json"), [draft]);
  await put(path.join(batch, "L3/reduction-source-map.json"), [
    { evidence_ids: claims.flatMap((c) => c.evidence_ids), context_only_ids: ["e8", "e9", "e10"] },
  ]);
  for (const [file, rows] of [
    ["L1/coverage.jsonl", coverageRows],
    ["L1/evidence.jsonl", atoms],
    ["L2/scenes.jsonl", scenes],
  ] as const)
    await writeFile(path.join(batch, file), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const inv = await loadCoverageInventory(batch);
  const version = "synthetic-u1-version";
  const directory = path.join(coverage, "versions", version);
  await mkdir(directory, { recursive: true });
  await put(path.join(coverage, "run.json"), {
    fingerprint: inv.fingerprint,
    source_bytes: inv.bytes,
  });
  const summary = {
    complete: true,
    classification_pending: 0,
    fingerprint: inv.fingerprint,
    source_fingerprint: manifest.sourceFingerprint,
  };
  await put(path.join(directory, "summary.json"), summary);
  const topicIds = Object.values(DOMAINS).map((topics) => topics[0]);
  const destinations = inv.canonical.flatMap((c) =>
    c.rows.map((r) => ({
      canonical_id: c.id,
      id: r.id,
      eligible: c.eligible,
      attribution: { author: r.author },
      topic_mapping:
        c.split === "dev"
          ? {
              topics: [required(topicIds[Number(r.sessionId.slice(1)) % 8])],
              status: "mapped",
              reason: "synthetic",
            }
          : null,
    })),
  );
  await writeFile(
    path.join(directory, "evidence-destinations.jsonl"),
    `${destinations.map((d) => JSON.stringify(d)).join("\n")}\n`,
  );
  await put(path.join(directory, "topics.json"), {
    labels: topicIds.map((id) => ({ id, title: id })),
  });
  const samples = Array.from({ length: 9 }, (_, i) => {
    const e = required(inv.packet.evidence.find((e) => e.id === `e${i}`));
    const a = required(atoms.find((a) => a.id === e.id));
    return {
      id: `sample-${i}`,
      source_id: e.source_id,
      session_id: a.sessionId,
      message_id: a.messageId,
      segment_id: a.segmentId,
      canonical_id: required(inv.canonical.find((c) => c.rows.some((r) => r.id === e.id))).id,
      windows: [{ start: e.start, end: e.end, text: e.quote }],
      result: i % 2 ? null : { quote: e.quote, start: e.start, end: e.end, outcome: "candidate" },
    };
  });
  await put(path.join(directory, "omission-review.json"), { samples });
  const suggestion = required(destinations.find((d) => d.id === "e4"));
  const review = {
    format: "u1-coordinator-review@1",
    reviewed_by: "coordinator_model",
    owner_confirmed: false,
    input_version_directory: directory,
    input_summary_sha256: sha256(await readFile(path.join(directory, "summary.json"))),
    topic_review: [
      {
        canonical_id: "c4",
        evidence_id: "e4",
        source_quote: required(atoms.find((a) => a.id === "e4")).quote,
        original_mapping: suggestion.topic_mapping,
        action: "propose_topic",
        suggested_topics: ["personal_investing", "fresh_unmapped_topic"],
        reason: "additional navigation candidate",
        qualification_changed: false,
      },
    ],
    new_topic_candidates: { fresh_unmapped_topic: "新增专题候选" },
    sample_review: withRepairs
      ? samples.map((s) => ({
          sample_id: s.id,
          category: "background",
          adjudication: "propose_scoped_use_repair",
          reason: "local use check",
        }))
      : [],
    classification_variants: {
      count: withRepairs ? 8 : 0,
      by_type: {},
      records: withRepairs
        ? Array.from({ length: 8 }, (_, i) => ({
            canonical_id: `c${i}`,
            row_ids: [`e${i}`, `e${i}b`],
            assessment: "compatible_facets",
            reason: "same sentence compatible facets",
          }))
        : [],
      action: "review",
    },
  };
  const reviewDirectory = path.join(coverage, "reviews");
  await mkdir(reviewDirectory);
  const reviewFile = path.join(reviewDirectory, "review.json");
  await put(reviewFile, review);
  await put(path.join(coverage, "latest.json"), { version, directory });
  const updateReview = async () => {
    await put(reviewFile, review);
    await put(path.join(coverage, "latest-review.json"), {
      directory: reviewDirectory,
      file: "review.json",
      content_sha256: sha256(await readFile(reviewFile)),
      source_version_directory: directory,
    });
  };
  await updateReview();
  return {
    base,
    batch,
    coverage,
    out,
    inv,
    atoms,
    directory,
    reviewFile,
    review,
    updateReview,
    options: { batch, coverage, out, repoRoot } satisfies UnderstandingOptions,
  };
}
