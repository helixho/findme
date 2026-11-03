import type { Db } from "@findme/db";

export type PersonalContext = {
  tenantId: string;
  subjectId: string;
};

export type EvidenceRow = {
  key: string;
  spanId: string;
  sourceItemId: string;
  quote: string;
  authorKind: string;
  eligibility: string;
  assessmentVersion: number | null;
  attributionStatus: string;
  contextCompleteness: string;
  temporalPrecision: string;
  assessmentRationale: string | null;
  /** Set for evidence from another experience; keeps its original independence group. */
  independenceGroup?: string;
};

/**
 * Where a model-backed Core mutation reads and writes. Account mode opens one
 * short RLS-scoped transaction per call so no model request runs inside a
 * database transaction; the default store uses the given handle directly.
 */
export type CoreStore = {
  read<T>(work: (db: Db) => Promise<T>): Promise<T>;
  write<T>(work: (db: Db) => Promise<T>): Promise<T>;
};

export function directCoreStore(db: Db): CoreStore {
  return { read: (work) => work(db), write: (work) => work(db) };
}
