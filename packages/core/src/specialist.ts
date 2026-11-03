/** Shared specialist contracts. Export from the package root when the owning
 * integration layer is wired; kept separate from the legacy core barrel. */
export type SpecialistPathway = "general" | "adhd";
export type SelfReportedDiagnosis = "diagnosed" | "concern" | "none" | "prefer_not_to_say";
export type AdjustmentKind =
  | "environment"
  | "task_structure"
  | "written_instruction"
  | "distraction_reduction"
  | "movement_break";
export type ProposalStatus = "proposed" | "accepted" | "rejected" | "paused";
export type TrialExecution = "completed" | "not_executed" | "partly_executed" | "unknown";
export type TrialOutcome = "helpful" | "no_effect" | "worse" | "mixed" | "unknown";
