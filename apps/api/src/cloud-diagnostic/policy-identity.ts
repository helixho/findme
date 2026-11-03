import { POLICY, PROMPTS } from "../domain/understanding/policy.js";
import { digest } from "../shared/primitives.js";
import { QUALIFICATION_HASH } from "./provenance.js";

// Persisted identity: JSON bytes and array order are a compatibility contract.
export const CLOUD_PIPELINE_ID = digest([
  "cloud-diagnostic-pipeline@2",
  POLICY,
  PROMPTS,
  QUALIFICATION_HASH,
]);
