import { UnderstandingImport } from "@findme/core";
import { describe, expect, it } from "vitest";
import { prepareUnderstandingImport } from "../src/cloud-diagnostic/understanding-import.js";
import { understandingImportFixture } from "./helpers/understanding-import-fixture.js";

describe("fixed conversation understanding import", () => {
  it("keeps analysis, withdrawal and usefulness feedback separate without promoting current claims", async () => {
    const result = await prepareUnderstandingImport(understandingImportFixture());
    expect(result.summary).toMatchObject({
      sources: 5,
      insights: 1,
      revisions: 2,
      feedback: 1,
      model_calls: 0,
      publication: "candidate_only",
    });
    expect(result.bundle.insights[0]!.revisions.map((r) => r.status)).toEqual([
      "withdrawn",
      "candidate",
    ]);
    expect(result.bundle.feedback[0]!.purpose).toBe("insight_usefulness");
    expect((await prepareUnderstandingImport(understandingImportFixture())).input_hash).toBe(
      result.input_hash,
    );
  });
  it("rejects an invented quote or text detached from the original analysis", () => {
    const input = understandingImportFixture();
    input.insights[0]!.revisions[0]!.text = "没有说过的判断";
    expect(() => UnderstandingImport.parse(input)).toThrow("INSIGHT_MUST_MATCH_ORIGINAL_ANALYSIS");
    input.insights[0]!.revisions[0]!.text = input.insights[0]!.revisions[0]!.origin.quote;
    input.insights[0]!.revisions[0]!.origin.end++;
    expect(() => UnderstandingImport.parse(input)).toThrow("EXACT_SOURCE_SPAN_REQUIRED");
  });
  it("does not count an assistant as independent personal evidence", () => {
    const input = understandingImportFixture();
    input.insights[0]!.revisions[0]!.evidence = [
      { ...input.insights[0]!.revisions[0]!.origin, relation: "supports" },
    ];
    expect(() => UnderstandingImport.parse(input)).toThrow(
      "ASSISTANT_IS_NOT_INDEPENDENT_PERSONAL_EVIDENCE",
    );
  });
  it("rejects forward/circular relations and absent feedback targets", () => {
    const input = understandingImportFixture();
    input.insights[0]!.revisions[0]!.relations.push({
      target_key: "explanation",
      target_version: 2,
      kind: "alternative",
    });
    expect(() => UnderstandingImport.parse(input)).toThrow(
      "RELATION_MUST_REFERENCE_EARLIER_REVISION",
    );
    input.feedback[0]!.target = { type: "source", key: "missing" };
    expect(() => UnderstandingImport.parse(input)).toThrow("FEEDBACK_TARGET_MISSING");
  });
  it("rejects direct publication and duplicate sequence identities", () => {
    const input = understandingImportFixture();
    expect(() =>
      UnderstandingImport.parse({
        ...input,
        insights: [
          {
            ...input.insights[0]!,
            revisions: [{ ...input.insights[0]!.revisions[0]!, status: "current" }],
          },
        ],
      }),
    ).toThrow();
    input.sources[1]!.sequence = input.sources[0]!.sequence;
    expect(() => UnderstandingImport.parse(input)).toThrow("DUPLICATE_SOURCE_ID_OR_SEQUENCE");
  });
});
