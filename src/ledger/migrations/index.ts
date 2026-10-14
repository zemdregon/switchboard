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
];
