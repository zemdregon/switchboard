/**
 * Submodule projects library (ADR-0079 items 2, 3 and 9): the manifest of an umbrella commit, shared object stores,
 * per-run attach/detach of submodule worktrees and the typed rows of the submodule tables. Pure library; the workspace
 * manager and the MCP tools wire it.
 */
export * from "./errors.js";
export * from "./ledger.js";
export * from "./manifest.js";
export * from "./store.js";
export * from "./worktree.js";
