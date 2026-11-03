import { currentPolicyRegistry, describePolicyIdentity } from "../src/policy-registry.js";

// No environment loading, provider creation, repository construction or writes.
const queries = process.argv.slice(2);
console.log(
  JSON.stringify(
    queries.length ? queries.map(describePolicyIdentity) : currentPolicyRegistry(),
    null,
    2,
  ),
);
