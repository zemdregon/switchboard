/** The `host` environment (LLD §11.3): the identity implementation; today's behaviour, unchanged. */
import type { Invocation } from "../adapters/types.js";
import type { Environment, PreparedInvocation, RunContext } from "./types.js";

export const hostEnvironment: Environment = {
  kind: "host",
  prepare(_run: RunContext, invocation: Invocation): Promise<PreparedInvocation> {
    return Promise.resolve({ invocation });
  },
  teardown(): Promise<void> {
    return Promise.resolve();
  },
  sweepOrphans(): Promise<{ removed: string[] }> {
    return Promise.resolve({ removed: [] });
  },
};
