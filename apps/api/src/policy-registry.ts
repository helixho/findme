import { CLOUD_PIPELINE_ID } from "./cloud-diagnostic/policy-identity.js";
import { CLOUD_QUALIFICATION_RULES, QUALIFICATION_HASH } from "./cloud-diagnostic/provenance.js";
import {
  PLAN_VALIDATOR_VERSION,
  PURPOSEFUL_EXPLORATION_POLICY,
  REVISION_VALIDATOR_VERSION,
  UNDERSTANDING_VALIDATOR_VERSION,
} from "./core/epistemic-policy.js";
import {
  EXPLORATION_PLAN_PROMPT_VERSION,
  REVISION_PROMPT_VERSION,
  UNDERSTANDING_PRIOR_PROMPT_VERSION,
  UNDERSTANDING_PROMPT_VERSION,
} from "./core/llm.js";
import { PRIOR_SELECTION_VERSION, PRIOR_VALIDATOR_VERSION } from "./core/prior-understanding.js";
import {
  ANALYSIS_PROMPT,
  AUDIT_PROMPT,
  POLICY as REASONING_POLICY,
  PROMPT as REASONING_PROMPT,
} from "./diagnostic-reasoning/policy.js";
import { POLICY, PROMPTS } from "./domain/understanding/policy.js";
import { digest } from "./shared/primitives.js";

export type PolicyIdentifier = Readonly<{
  kind: "version" | "profile" | "prompt-version" | "validator-version" | "digest";
  value: string;
}>;
export type PolicyEntry = Readonly<{
  key: string;
  responsibility: string;
  identifiers: readonly PolicyIdentifier[];
  sources: readonly string[];
  digest: Readonly<{ value: string; basis: string; persisted: boolean }> | null;
  notes: readonly string[];
}>;
const source = (path: string) => `apps/api/src/${path}`;
const id = (kind: PolicyIdentifier["kind"], value: string): PolicyIdentifier => ({ kind, value });
const core = (
  key: string,
  responsibility: string,
  prompt: string,
  validator: string,
): PolicyEntry => ({
  key,
  responsibility,
  identifiers: [
    id("version", PURPOSEFUL_EXPLORATION_POLICY.version),
    id("prompt-version", prompt),
    id("validator-version", validator),
    id("profile", PURPOSEFUL_EXPLORATION_POLICY.profile),
  ],
  sources: [
    source("core/epistemic-policy.ts"),
    source("core/llm.ts"),
    source(
      key === "core.revision" ? "core/exploration-revision.ts" : "core/exploration-planning.ts",
    ),
  ],
  digest: null,
  notes: [
    "Core stores policy, prompt and validator versions separately. Its input fingerprint also includes model and input; it is not a policy digest.",
    "Prompt bodies are private constants; a version match does not prove historical prompt bytes.",
  ],
});
const entries: readonly PolicyEntry[] = [
  core(
    "core.planner",
    "Ask/Stop planning and deterministic gates",
    EXPLORATION_PLAN_PROMPT_VERSION,
    PLAN_VALIDATOR_VERSION,
  ),
  core(
    "core.synthesis",
    "Evidence-bound understanding synthesis",
    UNDERSTANDING_PROMPT_VERSION,
    UNDERSTANDING_VALIDATOR_VERSION,
  ),
  core(
    "core.revision",
    "Correction of existing claims",
    REVISION_PROMPT_VERSION,
    REVISION_VALIDATOR_VERSION,
  ),
  {
    ...core(
      "core.prior",
      "Bounded prior-understanding selection and validated effects on it",
      UNDERSTANDING_PRIOR_PROMPT_VERSION,
      PRIOR_VALIDATOR_VERSION,
    ),
    identifiers: [
      ...core("core.prior", "", UNDERSTANDING_PRIOR_PROMPT_VERSION, PRIOR_VALIDATOR_VERSION)
        .identifiers,
      id("version", PRIOR_SELECTION_VERSION),
    ],
    sources: [source("core/prior-understanding.ts"), source("core/llm.ts")],
  },
  {
    key: "diagnostic.reasoning",
    responsibility: "Bounded explanation, revision and independent semantic audit",
    identifiers: [id("version", REASONING_POLICY), id("prompt-version", REASONING_PROMPT)],
    sources: [source("diagnostic-reasoning/policy.ts"), source("diagnostic-reasoning/runner.ts")],
    digest: {
      value: digest([ANALYSIS_PROMPT, AUDIT_PROMPT]),
      basis: "digest([ANALYSIS_PROMPT, AUDIT_PROMPT]); registry-only current content fingerprint",
      persisted: false,
    },
    notes: [
      "Records store policy/prompt versions, not this registry fingerprint. A version alone does not identify historical content.",
    ],
  },
  {
    key: "understanding.shared",
    responsibility: "Proposition repair, topic/overall reports, old-claim review and report audit",
    identifiers: [id("version", POLICY), id("digest", digest(PROMPTS))],
    sources: [
      source("domain/understanding/policy.ts"),
      source("understanding-baseline/policy.ts"),
      source("cloud-diagnostic/processing.ts"),
    ],
    digest: {
      value: digest(PROMPTS),
      basis: "digest(PROMPTS); SHA-256 of JSON.stringify, insertion order retained",
      persisted: true,
    },
    notes: [
      "The frozen compatibility entry re-exports this shared policy; hosted consumers import domain/understanding directly.",
      "The policy string includes the diagnostic reasoning version; these remain distinct validated objects.",
    ],
  },
  {
    key: "cloud.qualification",
    responsibility: "Source attribution and qualification generation/audit",
    identifiers: [id("version", CLOUD_QUALIFICATION_RULES), id("digest", QUALIFICATION_HASH)],
    sources: [
      source("cloud-diagnostic/provenance.ts"),
      source("understanding-app/qualification.ts"),
    ],
    digest: {
      value: QUALIFICATION_HASH,
      basis:
        "digest([CLOUD_QUALIFICATION_RULES, CLOUD_QUALIFICATION_PROMPT, CLOUD_QUALIFICATION_AUDIT_PROMPT])",
      persisted: true,
    },
    notes: [
      "Qualification proof reuse still requires its original policy, input, rules and proof bindings.",
    ],
  },
  {
    key: "cloud.pipeline",
    responsibility: "Cloud diagnostic processing/reuse identity",
    identifiers: [id("digest", CLOUD_PIPELINE_ID)],
    sources: [
      source("cloud-diagnostic/policy-identity.ts"),
      source("cloud-diagnostic/processing.ts"),
    ],
    digest: {
      value: CLOUD_PIPELINE_ID,
      basis: 'digest(["cloud-diagnostic-pipeline@2", POLICY, PROMPTS, QUALIFICATION_HASH])',
      persisted: true,
    },
    notes: [
      "The pipeline tag is only one component, not the full identity. Array order and JSON bytes are unchanged.",
    ],
  },
];

export type PolicyRegistrySnapshot = Readonly<{
  entries: readonly PolicyEntry[];
  framework: Readonly<{
    scope: "definition-version";
    globalDigest: null;
    sources: readonly string[];
    notes: readonly string[];
  }>;
}>;
const snapshot: PolicyRegistrySnapshot = {
  entries,
  framework: {
    scope: "definition-version",
    globalDigest: null,
    sources: [
      source("framework-runtime/definition.ts"),
      source("framework-runtime/policy.ts"),
      "packages/core/src/framework.ts",
    ],
    notes: [
      "Each DefinitionVersion (FrameworkDefinition key/version) has its own content_hash. No single global framework policy hash exists.",
      "defineFramework parses defaults, removes content_hash and SHA-256 hashes recursively key-sorted canonical JSON; array order is retained. validateDefinition verifies those content bytes.",
      "Definition content includes publication/usage/protocol. Runtime policy validates candidates, exact evidence and audits against the bound definition.",
      "This read-only registry does not load definitions or private repositories. An unregistered definition/historical hash is unknown, never invalid or relabeled current.",
    ],
  },
};

/** Detached snapshots: nested arrays/objects cannot mutate subsequent reads. */
export function currentPolicyRegistry(): PolicyRegistrySnapshot {
  return structuredClone(snapshot);
}
export type PolicyLookup =
  | {
      status: "known";
      current: true;
      query: string;
      matchedBy: "key" | PolicyIdentifier["kind"] | "content-digest";
      entry: PolicyEntry;
    }
  | {
      status: "ambiguous";
      current: true;
      query: string;
      entries: readonly PolicyEntry[];
      reason: string;
    }
  | { status: "unknown"; current: false; query: string; reason: string };

/** Exact matches only; observational metadata, never a historical read/reuse gate. */
export function describePolicyIdentity(query: string): PolicyLookup {
  const matches = currentPolicyRegistry().entries.filter(
    (entry) =>
      entry.key === query ||
      entry.identifiers.some((item) => item.value === query) ||
      entry.digest?.value === query,
  );
  const entry = matches[0];
  if (!entry)
    return {
      status: "unknown",
      current: false,
      query,
      reason:
        "No exact match in the current source snapshot. Historical/definition-scoped identities remain readable; no current policy is inferred.",
    };
  if (matches.length > 1)
    return {
      status: "ambiguous",
      current: true,
      query,
      entries: matches,
      reason:
        "This identifier names multiple current objects; supply an exact registry key or a more specific identifier. A version match does not prove historical bytes.",
    };
  return {
    status: "known",
    current: true,
    query,
    entry,
    matchedBy:
      entry.key === query
        ? "key"
        : (entry.identifiers.find((item) => item.value === query)?.kind ?? "content-digest"),
  };
}
