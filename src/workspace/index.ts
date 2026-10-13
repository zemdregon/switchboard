export {
  findOrphans,
  type GcOptions,
  type GcPlan,
  type GcPlanUnit,
  type GcResult,
  type GcStep,
  type GcUnitResult,
  type OrphanReport,
  planRetentionGc,
  runRetentionGc,
} from "./gc.js";
export { CONTROLLER_IDENTITY, GitError, MIN_GIT_VERSION } from "./git.js";
export {
  type FinalizeResult,
  type MutationAssessment,
  type PreparedWorkspace,
  type PrepareInput,
  parseNameStatus,
  type RollbackResult,
  WorkspaceError,
  type WorkspaceErrorCode,
  WorkspaceManager,
  type WorkspaceManagerOptions,
} from "./manager.js";
