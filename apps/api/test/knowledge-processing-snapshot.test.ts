import { describe, expect, it } from "vitest";
import { canonicalKnowledgeValue } from "../src/knowledge-processing/snapshot.js";

describe("knowledge snapshot equality across JSONB storage", () => {
  it("ignores recursively reordered object keys, preserves substantive changes and array order", () => {
    const original = {
      source: { stance: "本人", context: { goal: "开始", cost: 2 } },
      evidence: [
        { id: "a", relation: "supports" },
        { id: "b", relation: "challenges" },
      ],
    };
    const stored = {
      evidence: [
        { relation: "supports", id: "a" },
        { relation: "challenges", id: "b" },
      ],
      source: { context: { cost: 2, goal: "开始" }, stance: "本人" },
    };
    expect(canonicalKnowledgeValue(original)).toBe(canonicalKnowledgeValue(stored));
    expect(canonicalKnowledgeValue(original)).not.toBe(
      canonicalKnowledgeValue({ ...stored, evidence: [...stored.evidence].reverse() }),
    );
    expect(canonicalKnowledgeValue(original)).not.toBe(
      canonicalKnowledgeValue({ ...stored, source: { ...stored.source, stance: "转述" } }),
    );
    expect(canonicalKnowledgeValue({ value: null })).not.toBe(canonicalKnowledgeValue({}));
  });
});
