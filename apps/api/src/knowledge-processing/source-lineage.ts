import type { KnowledgeClaimEvidence } from "@findme/core";
import { coreSchema } from "@findme/db";
import { and, inArray, or } from "drizzle-orm";
import { union } from "./record-evidence.js";
import type { KnowledgeDb } from "./repository.js";

export const REUSE_RELATIONS = ["derived_from", "quoted_from", "duplicate_of"];

export async function sourceLineage(
  db: KnowledgeDb,
  selectedSourceIds: string[],
  evidence: KnowledgeClaimEvidence[],
) {
  const edges = new Map<string, { sourceId: string; targetId: string; relation: string }>();
  let frontier = union(selectedSourceIds);
  const visited = new Set(frontier);
  while (frontier.length) {
    const rows = await db
      .select({
        sourceId: coreSchema.sourceLinks.sourceItemId,
        targetId: coreSchema.sourceLinks.targetSourceItemId,
        relation: coreSchema.sourceLinks.relation,
      })
      .from(coreSchema.sourceLinks)
      .where(
        and(
          or(
            inArray(coreSchema.sourceLinks.sourceItemId, frontier),
            inArray(coreSchema.sourceLinks.targetSourceItemId, frontier),
          ),
          inArray(coreSchema.sourceLinks.relation, REUSE_RELATIONS),
        ),
      );
    const next: string[] = [];
    for (const row of rows) {
      const key = `${row.sourceId}:${row.relation}:${row.targetId}`;
      edges.set(key, row);
      for (const id of [row.sourceId, row.targetId]) {
        if (!visited.has(id)) {
          visited.add(id);
          next.push(id);
        }
      }
    }
    frontier = next;
  }

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const current = parent.get(id);
    if (!current) {
      parent.set(id, id);
      return id;
    }
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const join = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      if (rootA.localeCompare(rootB) <= 0) parent.set(rootB, rootA);
      else parent.set(rootA, rootB);
    }
  };
  for (const edge of edges.values()) join(`source:${edge.sourceId}`, `source:${edge.targetId}`);
  for (const item of evidence) join(`source:${item.sourceId}`, `event:${item.independenceGroup}`);
  for (const item of evidence) item.independenceGroup = find(`event:${item.independenceGroup}`);
  const reusedSources = new Set(
    [...edges.values()]
      .filter((edge) => REUSE_RELATIONS.includes(edge.relation))
      .map((edge) => edge.sourceId),
  );
  return { edges: [...edges.values()], reusedSources };
}
