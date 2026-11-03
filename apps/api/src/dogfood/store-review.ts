import {
  type Batch,
  DogfoodError,
  type Feedback,
  qualified,
  rawSupportPossible,
  sourceReview,
} from "./model.js";
type Candidate = Batch["state"]["candidates"][number];
type Source = Batch["sources"][number];
type Claim = Batch["state"]["claims"][number];

export function reviewCandidate(
  candidate: Candidate,
  review: Feedback,
  note: string,
  affected: Set<string>,
) {
  if (["contested", "time_update"].includes(review.action))
    throw new DogfoodError("INVALID_REVIEW_ACTION");
  if (review.action === "correct" && !review.author && !review.about && !review.kind)
    throw new DogfoodError("CORRECTION_REQUIRED");
  if (review.action === "context" && !note) throw new DogfoodError("NOTE_REQUIRED");
  if (review.author) candidate.author = review.author;
  if (review.about) candidate.about = review.about;
  if (review.kind) candidate.kind = review.kind;
  if (review.action === "adopt") candidate.status = "adopted";
  if (review.action === "exclude") candidate.status = "excluded";
  if (note) candidate.context.push(note);
  candidate.revision++;
  candidate.judgedBy = "owner";
  affected.add(candidate.id);
  affected.add(candidate.sourceId);
}

export function reviewSource(
  batch: Batch,
  source: Source,
  review: Feedback,
  note: string,
  affected: Set<string>,
) {
  const state = batch.state;
  if (!["exclude", "context"].includes(review.action))
    throw new DogfoodError("INVALID_REVIEW_ACTION");
  if (review.action === "context" && !note) throw new DogfoodError("NOTE_REQUIRED");
  const previous = sourceReview(state, source.id);
  state.sourceReviews[source.id] = {
    revision: previous.revision + 1,
    excluded: review.action === "exclude" || previous.excluded,
    context: [...previous.context, ...(note ? [note] : [])],
  };
  for (const c of state.candidates.filter((c) => c.sourceId === source.id)) {
    c.provenanceStatus = "stale";
    affected.add(c.id);
  }
  affected.add(source.id);
}

export function reviewClaim(claim: Claim, review: Feedback, note: string) {
  if (!["adopt", "contested", "time_update", "context", "exclude"].includes(review.action))
    throw new DogfoodError("INVALID_REVIEW_ACTION");
  if (["contested", "time_update", "context"].includes(review.action) && !note)
    throw new DogfoodError("NOTE_REQUIRED");
  claim.history.push({
    revision: claim.revision,
    status: claim.status,
    note,
    at: new Date().toISOString(),
    text: claim.text,
    scope: claim.scope,
  });
  if (review.action === "adopt") {
    if (!["candidate", "reviewed"].includes(claim.status))
      throw new DogfoodError("CLAIM_NOT_CURRENT");
    claim.status = "reviewed";
  } else if (review.action === "contested") claim.status = "contested";
  else if (review.action === "time_update") claim.status = "historical";
  else if (review.action === "exclude") claim.status = "withdrawn";
  else claim.status = "stale";
  claim.revision++;
}

export function invalidateReviewDependencies(
  batch: Batch,
  review: Feedback,
  affected: Set<string>,
  source: Source | undefined,
  candidate: Candidate | undefined,
) {
  const state = batch.state;
  const changedSource = source?.id ?? candidate?.sourceId;
  if (changedSource) {
    for (const dependent of state.candidates.filter((c) =>
      c.contextSourceIds?.includes(changedSource),
    )) {
      dependent.provenanceStatus = "stale";
      dependent.revision++;
      affected.add(dependent.id);
    }
    for (const run of state.runs) {
      if (!["running", "completed"].includes(run.status)) continue;
      const ownSource = run.coverage?.[0]?.sourceId ?? run.sourceIds[0];
      const contextChanged =
        run.context?.some((c) => c.sourceId === changedSource) ||
        (run.operation === "extract" &&
          ownSource !== changedSource &&
          run.sourceIds.includes(changedSource));
      if ((source && run.sourceIds.includes(changedSource)) || contextChanged) {
        run.status = "stale";
        run.error = "INPUT_REVIEW_CHANGED";
      }
    }
  }
  for (const dependent of state.claims) {
    if (["withdrawn", "historical"].includes(dependent.status)) continue;
    const dependencies = [...dependent.evidence, ...dependent.counterevidence];
    if (
      !dependencies.some((id) => affected.has(id)) &&
      !(changedSource && dependent.contextSourceIds?.includes(changedSource))
    )
      continue;
    const supports = dependent.evidence.filter((id) => {
      const c = state.candidates.find((item) => item.id === id);
      if (c) return qualified(state, c);
      const source = batch.sources.find((s) => s.id === id);
      if (!source) return false;
      const run = state.runs.find((r) => r.id === dependent.runId);
      const ranges = run?.coverage?.filter((r) => r.sourceId === id);
      return ranges?.length
        ? ranges.some((r) => rawSupportPossible(state, source, r.start, r.end))
        : rawSupportPossible(state, source);
    });
    dependent.history.push({
      revision: dependent.revision,
      status: dependent.status,
      note: `source review: ${review.action}`,
      at: new Date().toISOString(),
      text: dependent.text,
      scope: dependent.scope,
    });
    dependent.status = supports.length ? "stale" : "invalid";
    dependent.revision++;
  }
}
