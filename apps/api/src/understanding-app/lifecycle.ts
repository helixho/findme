import type { UnderstandingSourceStatus } from "@findme/core";
import type { Selection } from "../domain/understanding/types.js";
import { digest, fail } from "../shared/primitives.js";
import type { FeedbackState } from "./state.js";

// Derived current validity is deliberately not serialized by GET.
const validity = new WeakMap<FeedbackState, Map<string, string>>();
export function attachInvalidity(state: FeedbackState, invalid: Map<string, string>) {
  validity.set(state, invalid);
}
export function invalidRoots(state: FeedbackState) {
  return new Map([
    ...(validity.get(state) ?? new Map<string, string>()),
    ...state.lifecycle.map((a) => [a.source_id, "SOURCE_RETIRED"] as const),
  ]);
}
export function validFeedbackState(state: FeedbackState): FeedbackState {
  const blocked = invalidRoots(state);
  const next = {
    ...state,
    entries: state.entries.filter((e) => !blocked.has(e.receipt.source_id)),
  };
  attachInvalidity(next, blocked);
  return next;
}
export function selectionRoots(selection: Selection) {
  return new Set(selection.evidence.flatMap((e) => [e.source_id, ...e.root_ids]));
}
/** Previous targets and qualification batches are dependencies, even if prose omits a quote. */
export function dependentRoots(state: FeedbackState) {
  const dependencies = new Map<string, Set<string>>();
  for (const r of state.revisions) {
    if (r.status !== "accepted" || typeof r.version !== "string") continue;
    const inputs = selectionRoots(r.selection as Selection);
    for (const id of (r.feedback_ids ?? []) as string[]) {
      const f = state.entries.find((e) => e.receipt.id === id)?.receipt;
      if (f) inputs.add(f.source_id);
    }
    for (const version of (r.qualification_versions ?? []) as string[]) {
      const q = state.revisions.find(
        (v) => (v.qualification as { version?: string })?.version === version,
      )?.qualification as { input?: { notes: { source_id: string }[] } } | undefined;
      for (const n of q?.input?.notes ?? []) inputs.add(n.source_id);
    }
    const versions = [
      ...(!r.source_recovery ? [String(r.previous_version)] : []),
      ...((r.dependency_map as { topics?: { version: string }[] } | null)?.topics ?? []).map(
        (t) => t.version,
      ),
    ];
    for (const v of versions) for (const id of dependencies.get(v) ?? []) inputs.add(id);
    dependencies.set(r.version, inputs);
  }
  return dependencies;
}
export function blockedVersions(state: FeedbackState) {
  const roots = invalidRoots(state);
  return new Set(
    [...dependentRoots(state)]
      .filter(([, ids]) => [...ids].some((id) => roots.has(id)))
      .map(([version]) => version),
  );
}
export function sourceStatuses(state: FeedbackState): UnderstandingSourceStatus[] {
  const invalid = invalidRoots(state);
  const dependencies = dependentRoots(state);
  return [
    ...new Set(state.entries.filter((e) => e.receipt.core_source).map((e) => e.receipt.source_id)),
  ].map((id) => ({
    source_id: id,
    lifecycle_revision: state.lifecycle.length,
    status: state.lifecycle.some((a) => a.source_id === id)
      ? "retired"
      : invalid.has(id)
        ? "invalid"
        : "active",
    reason: invalid.get(id) ?? null,
    affected_domains: [
      ...new Set([
        ...state.entries
          .filter((e) => e.receipt.source_id === id)
          .map((e) => e.receipt.input.domain),
        ...state.revisions
          .filter((r) => dependencies.get(String(r.version))?.has(id))
          .map((r) => String(r.domain)),
      ]),
    ],
  }));
}
export function redactReceipt(
  state: FeedbackState,
  receipt: FeedbackState["entries"][number]["receipt"],
  blocked = blockedVersions(state),
) {
  const reason = invalidRoots(state).get(receipt.source_id);
  if (!reason)
    return blocked.has(receipt.input.report_version)
      ? { ...receipt, input: { ...receipt.input, context: undefined, finding_key: undefined } }
      : { ...receipt };
  const { core_source: binding, ...rest } = receipt;
  return {
    ...rest,
    // Raw audit ledger remains intact; normal transport carries neither note nor target context.
    input: { ...receipt.input, note: "", context: undefined, finding_key: undefined },
    source_status: state.lifecycle.some((a) => a.source_id === receipt.source_id)
      ? ("retired" as const)
      : ("invalid" as const),
    error: reason,
    qualification: "pending" as const,
  };
}
export function checkLifecycleIntegrity(
  state: FeedbackState,
  owner: { tenantId: string; subjectId: string },
) {
  for (const a of state.lifecycle) {
    if (digest(a.actor) !== digest(owner)) fail("REPORT_OWNER_MISMATCH");
    const replacement = state.entries.find((e) => e.receipt.id === a.replacement_id)?.receipt;
    if (
      a.kind === "rebind" &&
      (!replacement?.core_source ||
        replacement.replaces_source_id !== a.source_id ||
        (replacement.source_id !==
          `core-rebind:${digest([replacement.core_source, a.source_id, a.revision])}` &&
          replacement.source_id !== replacement.core_source?.source_id) ||
        a.replacement_binding_fingerprint !== digest(replacement.core_source) ||
        a.replacement_source_fingerprint !== digest(replacement.input.note))
    )
      fail("SOURCE_LIFECYCLE_INTEGRITY");
    const receipts = state.entries
      .filter((e) => e.receipt.source_id === a.source_id)
      .map((e) => e.receipt);
    if (receipts.some((f) => !f.core_source)) fail("SOURCE_LIFECYCLE_INTEGRITY");
    if (
      digest(a.binding_fingerprints) !==
        digest([...new Set(receipts.map((f) => digest(f.core_source)))].sort()) ||
      digest(a.source_fingerprints) !==
        digest([...new Set(receipts.map((f) => digest(f.input.note)))].sort())
    )
      fail("SOURCE_LIFECYCLE_INTEGRITY");
  }
}
