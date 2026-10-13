/** Inner-agent configuration types (T11.1). The schema and resolution live in `src/config/inner-agent.ts`; see there for why. */
export {
  COMMIT_MESSAGE_MODES,
  type CommitMessageMode,
  INNER_BACKEND_KINDS,
  INNER_DEFAULTS,
  INNER_TASKS,
  type InnerAgentConfig,
  type InnerAgentSettings,
  type InnerBackendKind,
  type InnerTask,
  type InnerTaskConfig,
  type InnerTaskSettings,
  mostRestrictiveInnerSetting,
  PROJECT_INNER_SETTINGS,
  type ProjectInnerSetting,
  SOURCE_CONTENT_TASKS,
} from "../config/inner-agent.js";
