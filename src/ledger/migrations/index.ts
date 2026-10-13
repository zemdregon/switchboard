import { sql as sql0001 } from "./0001_initial.js";
import { sql as sql0002 } from "./0002_project_id.js";
import { sql as sql0003 } from "./0003_git_commit.js";
import { sql as sql0004 } from "./0004_project_revision.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** Ordered, forward-only. Never edit or remove a released entry (ADR-0005); append a new one. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial", sql: sql0001 },
  { version: 2, name: "project_id", sql: sql0002 },
  { version: 3, name: "git_commit", sql: sql0003 },
  { version: 4, name: "project_revision", sql: sql0004 },
];
