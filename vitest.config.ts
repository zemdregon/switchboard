import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    passWithNoTests: false,
    // Lifecycle, workspace and serve tests drive real Git worktrees and child processes; under CPU contention
    // (parallel test files, shared CI runners) they exceed the 5 s default without any logic fault.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
