// Explicit public contract: adding an export to an implementation module does not publish it.
// Preserve the existing domain schemas and types, including consumers outside this workspace.
export {
  AttributionStatus,
  AuthorKind,
  ClaimDraft,
  ClaimKind,
  ClaimMode,
  ClaimStatus,
  ConfidenceLevel,
  ContextCompleteness,
  ContributionLevel,
  CorrectionInput,
  CorrectionType,
  EvidenceDirectness,
  EvidenceRelation,
  EvidenceUse,
  KnowledgeGap,
  InteractionPreferenceDraft,
  PriorUnderstandingEffect,
  PriorUnderstandingUpdate,
  RevisionDraft,
  SourceAssessmentInput,
  SourceEligibility,
  SourceKind,
  TemporalPrecision,
  UnderstandingDraft,
  UnderstandingWithPriorDraft,
  UpdateSourceAssessmentInput,
} from "./model.js";
export {
  AmendSourceInput,
  CompleteExplorationInput,
  ContinueExplorationInput,
  CorrectUnderstandingInput,
  ExplorationOutcome,
  ExplorationPhase,
  ExplorationPlan,
  ExplorationStatus,
  ExplorationUnderstanding,
  GuidedQuestion,
  RespondToExplorationInput,
  RevisedExplorationUnderstanding,
  StartExplorationInput,
} from "./t1.js";
export {
  DiagnosticEvidenceSnapshot,
  DiagnosticFeedback,
  DiagnosticFinding,
  DiagnosticMethod,
  DiagnosticProposal,
  DiagnosticRun,
  DiagnosticSourceAssessment,
  DiagnosticSourceSnapshot,
  DiagnosticStatus,
  DiagnosticTargetQuestion,
  FindingVersionRef,
  ReportRevision,
  SourceVersionRef,
} from "./diagnostic.js";
export {
  AuditIssueCode,
  EvidencePacket,
  ReasoningEvidence,
  ReasoningSource,
  ReasoningStance,
  RevisionOperation,
  RevisionRelation,
  reasoningAuditSchema,
  reasoningCandidateSchema,
} from "./diagnostic-reasoning.js";
export type {
  ReasoningAudit,
  ReasoningCandidate,
} from "./diagnostic-reasoning.js";
export {
  OldClaimDisposition,
  OldClaimReview,
  UNDERSTANDING_VERSION,
  UnderstandingAudit,
  UnderstandingFinding,
  UnderstandingLink,
  UnderstandingNode,
  UnderstandingRelation,
  UnderstandingReport,
  UnderstandingType,
  UseRepair,
  UseRepairs,
} from "./understanding-baseline.js";
export {
  CoreReportSourceBinding,
  CoreReportTarget,
  CoreReportTransferInput,
  UNDERSTANDING_APP_VERSION,
  UnderstandingFeedbackInput,
  UnderstandingOverallRequest,
  UnderstandingRecoveryRequest,
  UnderstandingSourceAction,
  UnderstandingSourceRebind,
} from "./understanding-app.js";
export type {
  UnderstandingAppView,
  UnderstandingExactEvidence,
  UnderstandingFeedbackReceipt,
  UnderstandingProcessingStatus,
  UnderstandingReportHistory,
  UnderstandingReportVersion,
  UnderstandingSourceStatus,
  UnderstandingTopicView,
  UnderstandingVersionView,
} from "./understanding-app.js";
export {
  FrameworkAmendInput,
  FrameworkAssertion,
  FrameworkAudit,
  FrameworkCandidate,
  FrameworkContinueInput,
  FrameworkDefinition,
  FrameworkDomainAssessment,
  FrameworkRef,
  FrameworkRespondInput,
  FrameworkStartInput,
  FrameworkSynthesis,
  FrameworkVersionInput,
} from "./framework.js";
export type {
  FrameworkAnswer,
  FrameworkCatalog,
  FrameworkQuestion,
  FrameworkRunView,
} from "./framework.js";
export {
  CloudBlobDeclaration,
  CloudDiagnosticCreate,
  CloudDiagnosticResponse,
  CloudEvidenceBinding,
  CloudProcessRequest,
  CloudReportCandidate,
} from "./cloud-diagnostic.js";
export {
  CoreImportEnvelope,
  CoreImportSource,
} from "./cloud-ingest.js";
export {
  ContentApplicabilityKey,
  ContentBundle,
  ContentCardVersion,
  ContentClaim,
  ContentEvidenceChunk,
  ContentPublicationStatus,
  ContentReviewChecklist,
  ContentSource,
  ReflectionInput,
  isReleaseReady,
} from "./content.js";
export {
  KnowledgeCoverageDisposition,
  KnowledgeEvidenceItem,
  KnowledgeFeedbackInput,
  KnowledgeFeedbackKind,
  KnowledgeProcessingRecord,
  KnowledgeTopicProcessInput,
  KnowledgeTopicResult,
  buildKnowledgeTopicResult,
} from "./knowledge-processing.js";
export type { KnowledgeClaimEvidence } from "./knowledge-processing.js";
export type {
  AdjustmentKind,
  ProposalStatus,
  SelfReportedDiagnosis,
  SpecialistPathway,
  TrialExecution,
  TrialOutcome,
} from "./specialist.js";

export {
  UnderstandingDomain,
  UnderstandingDimensions,
  UnderstandingImport,
  StoredUnderstandingDetails,
} from "./understanding-import.js";
