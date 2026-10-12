import { sql as sql0001 } from "./0001_initial.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** Ordered, forward-only. Never edit or remove a released entry (ADR-0005); append a new one. */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: "initial", sql: sql0001 }];
