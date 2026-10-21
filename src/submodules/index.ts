/**
 * Submodule projects library (ADR-0080 items 2, 3, 4 and 9): the manifest of an umbrella commit, shared object stores,
 * per-run attach/detach of submodule worktrees, submodule checkpoints, controller-made submodule commits and the typed
 * rows of the submodule tables. Pure library; the workspace manager, the commit path and the MCP tools wire it.
 */
export * from "./checkpoint.js";
export * from "./commit.js";
export * from "./errors.js";
export * from "./ledger.js";
export * from "./manifest.js";
export * from "./store.js";
export * from "./worktree.js";
