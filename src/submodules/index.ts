/**
 * Submodule projects library (ADR-0079 items 2 and 3): the manifest of an umbrella commit, shared object stores and
 * per-run attach/detach of submodule worktrees. Pure library; the workspace manager and the MCP tools wire it.
 */
export * from "./errors.js";
export * from "./manifest.js";
export * from "./store.js";
export * from "./worktree.js";
