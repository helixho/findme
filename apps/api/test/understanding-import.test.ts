import { StoredUnderstandingDetails, UnderstandingImport } from "@findme/core";
import { describe, expect, it } from "vitest";
import { prepareUnderstandingImport } from "../src/cloud-diagnostic/understanding-import.js";
import {
  understandingImportFixture,
  understandingImportV2Fixture,
} from "./helpers/understanding-import-fixture.js";

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

describe("version 1 compatibility", () => {
  it("keeps the original receipt shape and rejects version 2 fields", async () => {
    const input = understandingImportFixture();
    const { summary } = await prepareUnderstandingImport(input);
    expect(Object.keys(summary).sort()).toEqual([
      "feedback",
      "insights",
      "model_calls",
      "publication",
      "revisions",
      "sources",
    ]);
    const withExperience = structuredClone(input) as Record<string, unknown>;
    withExperience.experiences = [];
    expect(UnderstandingImport.safeParse(withExperience).success).toBe(false);
    const marked = structuredClone(input);
    (marked.insights[0]!.revisions[0]!.evidence[0] as Record<string, unknown>).experience_key = "x";
    expect(UnderstandingImport.safeParse(marked).success).toBe(false);
    expect(UnderstandingImport.safeParse({ ...input, format: "other" }).success).toBe(false);
  });
});

describe("experience groups and answer bindings (version 2)", () => {
  const parse = (input: unknown) => UnderstandingImport.safeParse(input);
  const messages = (input: unknown) =>
    JSON.stringify(parse(input).error?.issues.map((i) => i.message) ?? []);
  const revisionOf = (input: ReturnType<typeof understandingImportV2Fixture>, key: string) =>
    input.insights.find((i) => i.key === key)!.revisions[0]!;

  it("accepts the synthetic package, counts it and hashes it deterministically", async () => {
    const result = await prepareUnderstandingImport(understandingImportV2Fixture());
    expect(result.summary).toMatchObject({
      format: "findme-understanding-import@2",
      sources: 8,
      insights: 7,
      revisions: 7,
      feedback: 1,
      experiences: 2,
      answer_bindings: 1,
      model_calls: 0,
      publication: "candidate_only",
    });
    expect((await prepareUnderstandingImport(understandingImportV2Fixture())).input_hash).toBe(
      result.input_hash,
    );
  });

  it("lets a version 2 package omit experiences without changing its meaning", () => {
    const plain = structuredClone(understandingImportFixture()) as Record<string, unknown>;
    plain.format = "findme-understanding-import@2";
    expect(parse(plain).success).toBe(true);
  });

  it("requires every answer fragment to be exact and the answer to follow its question", () => {
    const input = understandingImportV2Fixture();
    const binding = revisionOf(input, "q.treadmill_goal.B").answer_binding!;
    binding.options[0]!.end += 1;
    expect(messages(input)).toContain("EXACT_SOURCE_SPAN_REQUIRED");
    const reordered = understandingImportV2Fixture();
    const [a1, u2] = [
      reordered.sources.find((s) => s.key === "a1")!,
      reordered.sources.find((s) => s.key === "u2")!,
    ];
    [a1.sequence, u2.sequence] = [u2.sequence, a1.sequence];
    expect(messages(reordered)).toContain("ANSWER_MUST_FOLLOW_QUESTION");
    const noLabel = understandingImportV2Fixture();
    revisionOf(noLabel, "q.treadmill_goal.B").answer_binding!.options[1]!.label = "Z";
    expect(messages(noLabel)).toContain("OPTION_LABEL_NOT_FOUND");
  });

  it("keeps selected labels consistent with all offered options", () => {
    const missing = understandingImportV2Fixture();
    revisionOf(missing, "q.treadmill_goal.B").answer_binding!.selected = ["A"];
    expect(messages(missing)).toContain("SELECTED_OPTION_MISSING");
    const unknown = understandingImportV2Fixture();
    revisionOf(unknown, "q.treadmill_goal.B").answer_binding!.selected = ["B", "Q"];
    expect(messages(unknown)).toContain("SELECTED_OPTION_MISSING");
    const duplicate = understandingImportV2Fixture();
    revisionOf(duplicate, "q.treadmill_goal.B").answer_binding!.options[2]!.label = "A";
    expect(messages(duplicate)).toContain("DUPLICATE_OPTION_LABEL");
    // A multi-select answer is one answer; each claim names the option it states.
    const multi = understandingImportV2Fixture();
    revisionOf(multi, "q.treadmill_goal.B").answer_binding!.selected = ["A", "B"];
    expect(parse(multi).success).toBe(true);
  });

  it("does not let a derived summary pass for a quotation or an assistant observation", () => {
    const quoted = understandingImportV2Fixture();
    const revision = revisionOf(quoted, "q.treadmill_goal.B");
    revision.text = revision.answer_binding!.options[1]!.text;
    expect(messages(quoted)).toContain("DERIVED_TEXT_MUST_NOT_BE_QUOTE");
    const observed = understandingImportV2Fixture();
    observed.insights.find((i) => i.key === "q.treadmill_goal.B")!.mode = "observation";
    expect(messages(observed)).toContain("ANSWER_BINDING_REQUIRES_SELF_REPORT");
    const stray = understandingImportV2Fixture();
    revisionOf(stray, "q.treadmill_goal.B").origin = {
      ...revisionOf(stray, "u.treadmill_usage").origin,
    };
    expect(messages(stray)).toContain("ANSWER_BINDING_ORIGIN_MISMATCH");
    const mismatched = understandingImportV2Fixture();
    revisionOf(mismatched, "q.treadmill_goal.B").evidence.splice(1);
    expect(messages(mismatched)).toContain("ANSWER_BINDING_EVIDENCE_REQUIRED");
  });

  it("needs the question from an assistant and the answer from the person", () => {
    const input = understandingImportV2Fixture();
    const binding = revisionOf(input, "q.treadmill_goal.B").answer_binding!;
    binding.question = { ...revisionOf(input, "u.treadmill_usage").origin };
    expect(messages(input)).toContain("QUESTION_MUST_BE_ASSISTANT_TEXT");
  });

  it("rejects undeclared, duplicate, unused and contradictory experiences", () => {
    const unknown = understandingImportV2Fixture();
    (
      revisionOf(unknown, "u.treadmill_usage").evidence[0] as { experience_key?: string }
    ).experience_key = "exp.missing";
    expect(messages(unknown)).toContain("UNKNOWN_EXPERIENCE");
    const duplicate = understandingImportV2Fixture();
    duplicate.experiences.push({ ...duplicate.experiences[0]! });
    expect(messages(duplicate)).toContain("DUPLICATE_EXPERIENCE_KEY");
    const unused = understandingImportV2Fixture();
    unused.experiences.push({ ...unused.experiences[0]!, key: "exp.unused" });
    expect(messages(unused)).toContain("EXPERIENCE_WITHOUT_EVIDENCE");
    const conflict = understandingImportV2Fixture();
    (
      revisionOf(conflict, "u.treadmill_usage").evidence[0] as { experience_key?: string }
    ).experience_key = "exp.monitor_plan";
    expect(messages(conflict)).toContain("SPAN_EXPERIENCE_CONFLICT");
    const half = understandingImportV2Fixture();
    delete (revisionOf(half, "u.treadmill_usage").origin as { experience_key?: string })
      .experience_key;
    expect(messages(half)).toContain("SPAN_EXPERIENCE_CONFLICT");
  });

  it("keeps an unassigned span out of every experience", () => {
    const input = understandingImportV2Fixture();
    const unassigned = ["u.running", "u.course"].map((key) => revisionOf(input, key));
    expect(unassigned.every((r) => !("experience_key" in r.origin))).toBe(true);
    expect(parse(input).success).toBe(true);
  });

  it("describes stored details of both versions", () => {
    const common = {
      domains: ["work_creation"],
      content_type: "state",
      analysis_role: "observation",
      context: { projects: [], roles: [], situations: [] },
      valid_time: { from: null, to: null, precision: "unknown", label: null },
      relations: [],
    };
    expect(
      StoredUnderstandingDetails.safeParse({
        ...common,
        schema_version: "personal-understanding@1",
      }).success,
    ).toBe(true);
    expect(
      StoredUnderstandingDetails.safeParse({
        ...common,
        schema_version: "personal-understanding@2",
        experiences: [],
      }).success,
    ).toBe(true);
    expect(
      StoredUnderstandingDetails.safeParse({
        ...common,
        schema_version: "personal-understanding@1",
        experiences: [],
      }).success,
    ).toBe(false);
  });
});
