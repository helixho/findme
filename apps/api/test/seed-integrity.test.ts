import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(process.cwd(), "../..");
const seedDir = path.join(repoRoot, "apps/api/src/seed/data");

type SeedMaterial = {
  type: string;
  title: string;
  linkedQuestionnaires?: string[];
};
type SeedQuestionnaire = {
  name: string;
  type: string;
  source?: string;
};

describe("Seed content integrity", () => {
  it("内置探索 seed 满足 V1.3 产品级 baseline", () => {
    const materials = readJson<SeedMaterial[]>("materials.json");
    const questionnaires = readJson<SeedQuestionnaire[]>("questionnaires.json");

    expect(materials.length).toBeGreaterThanOrEqual(12);
    expect(questionnaires.length).toBeGreaterThanOrEqual(12);
    expect([...new Set(materials.map((item) => item.type))]).toEqual(
      expect.arrayContaining(["concept", "figure", "book"]),
    );
    expect(
      materials.filter((item) => (item.linkedQuestionnaires ?? []).length > 0).length,
    ).toBeGreaterThanOrEqual(4);
    expect(questionnaires.filter((item) => item.type === "theory").length).toBeGreaterThanOrEqual(
      6,
    );

    const questionnaireNames = new Set(questionnaires.map((item) => item.name));
    const materialTitles = new Set(materials.map((item) => item.title));
    const brokenMaterialLinks = materials.flatMap((material) =>
      (material.linkedQuestionnaires ?? [])
        .filter((name) => !questionnaireNames.has(name))
        .map((name) => `${material.title} -> ${name}`),
    );
    const brokenQuestionnaireSources = questionnaires
      .filter((questionnaire) => questionnaire.source && !materialTitles.has(questionnaire.source))
      .map((questionnaire) => `${questionnaire.name} -> ${questionnaire.source}`);

    expect(brokenMaterialLinks).toEqual([]);
    expect(brokenQuestionnaireSources).toEqual([]);
  });
});

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(seedDir, name), "utf8")) as T;
}
