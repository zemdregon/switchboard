import type Database from "better-sqlite3";
import { backfillChains } from "../chain.js";
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
import { sql as sql0019 } from "./0019_gc_orphan.js";
import { sql as sql0020 } from "./0020_project_schedule.js";
import { sql as sql0021 } from "./0021_skill_store.js";
import { sql as sql0022 } from "./0022_dependency_seed.js";
import { sql as sql0023 } from "./0023_ci_fix_cap.js";
import { sql as sql0024 } from "./0024_ci_transient.js";
import { sql as sql0025 } from "./0025_eval_result.js";
import { postSql as postSql0026, sql as sql0026 } from "./0026_ledger_chain.js";
import { sql as sql0027 } from "./0027_verification_result.js";
import { sql as sql0028 } from "./0028_oauth_cimd_client.js";
import { sql as sql0029 } from "./0029_published_ref_conflicts.js";
import { sql as sql0030 } from "./0030_decision_request.js";
import { sql as sql0031 } from "./0031_merge_policy.js";
import { sql as sql0032 } from "./0032_decision_onboarding.js";
import { sql as sql0033 } from "./0033_mcp_publication.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  /** Run with `PRAGMA foreign_keys = OFF` and a `foreign_key_check` before commit (a rebuild of a referenced table). */
  readonly foreignKeysOff?: boolean;
  /**
   * Data step run after `sql` in the same transaction (migration 26's chain backfill). Its code is as immutable as the
   * SQL once released; it is not part of the checksum.
   */
  readonly backfill?: (db: Database.Database) => void;
  /** SQL run after `backfill` in the same transaction (recreating guards `sql` dropped); part of the checksum. */
  readonly postSql?: string;
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
  { version: 19, name: "gc_orphan", sql: sql0019 },
  { version: 20, name: "project_schedule", sql: sql0020 },
  { version: 21, name: "skill_store", sql: sql0021 },
  { version: 22, name: "dependency_seed", sql: sql0022, foreignKeysOff: true },
  { version: 23, name: "ci_fix_cap", sql: sql0023 },
  { version: 24, name: "ci_transient", sql: sql0024 },
  { version: 25, name: "eval_result", sql: sql0025 },
  { version: 26, name: "ledger_chain", sql: sql0026, backfill: backfillChains, postSql: postSql0026 },
  { version: 27, name: "verification_result", sql: sql0027, foreignKeysOff: true },
  { version: 28, name: "oauth_cimd_client", sql: sql0028 },
  { version: 29, name: "published_ref_conflicts", sql: sql0029 },
  { version: 30, name: "decision_request", sql: sql0030, foreignKeysOff: true },
  { version: 31, name: "merge_policy", sql: sql0031 },
  { version: 32, name: "decision_onboarding", sql: sql0032 },
  { version: 33, name: "mcp_publication", sql: sql0033, foreignKeysOff: true },
];
