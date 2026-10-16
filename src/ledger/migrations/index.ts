import { sql as sql0001 } from "./0001_initial.js";
import { sql as sql0002 } from "./0002_project_id.js";
import { sql as sql0003 } from "./0003_git_commit.js";
import { sql as sql0004 } from "./0004_project_revision.js";
import { sql as sql0005 } from "./0005_inner_call.js";
import { sql as sql0006 } from "./0006_usage_inner_agent.js";
import { sql as sql0007 } from "./0007_git_commit_message_source.js";
import { sql as sql0008 } from "./0008_inner_task_state.js";
import { sql as sql0009 } from "./0009_pr_draft_artifact.js";
import { sql as sql0010 } from "./0010_oauth_token.js";
import { sql as sql0011 } from "./0011_oauth_client.js";
import { sql as sql0012 } from "./0012_oauth_pairing_code.js";
import { sql as sql0013 } from "./0013_http_subject.js";
import { sql as sql0014 } from "./0014_project_affinity.js";
import { sql as sql0015 } from "./0015_rag_record.js";
import { sql as sql0016 } from "./0016_handoff_condense_artifact.js";
import { sql as sql0017 } from "./0017_project_work_queue.js";
import { sql as sql0018 } from "./0018_control_plane_state.js";
import { sql as sql0019 } from "./0019_project_schedule.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  /** Run with `PRAGMA foreign_keys = OFF` and a `foreign_key_check` before commit (a rebuild of a referenced table). */
  readonly foreignKeysOff?: boolean;
}

/** Ordered, forward-only. Never edit or remove a released entry (ADR-0005); append a new one. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial", sql: sql0001 },
  { version: 2, name: "project_id", sql: sql0002 },
  { version: 3, name: "git_commit", sql: sql0003 },
  { version: 4, name: "project_revision", sql: sql0004 },
  { version: 5, name: "inner_call", sql: sql0005 },
  { version: 6, name: "usage_inner_agent", sql: sql0006 },
  { version: 7, name: "git_commit_message_source", sql: sql0007 },
  { version: 8, name: "inner_task_state", sql: sql0008 },
  { version: 9, name: "pr_draft_artifact", sql: sql0009, foreignKeysOff: true },
  { version: 10, name: "oauth_token", sql: sql0010 },
  { version: 11, name: "oauth_client", sql: sql0011 },
  { version: 12, name: "oauth_pairing_code", sql: sql0012 },
  { version: 13, name: "http_subject", sql: sql0013 },
  { version: 14, name: "project_affinity", sql: sql0014 },
  { version: 15, name: "rag_record", sql: sql0015 },
  { version: 16, name: "handoff_condense_artifact", sql: sql0016, foreignKeysOff: true },
  { version: 17, name: "project_work_queue", sql: sql0017 },
  { version: 18, name: "control_plane_state", sql: sql0018 },
  { version: 19, name: "project_schedule", sql: sql0019 },
];
