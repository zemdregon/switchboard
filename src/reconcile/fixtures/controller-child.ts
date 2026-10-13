/**
 * Fault-injection child (T1.9): a real controller code path (ledger, workspace manager, run lifecycle, fake adapter)
 * in its own process, so the test can SIGKILL it mid-RUNNING. Usage (see reconcile.test.ts):
 *   node --experimental-transform-types --import ./ts-register.mjs controller-child.ts '<json config>'
 * Prints one JSON line `{"running": {...}}` once the provider process is spawned and its pid is committed, then idles.
 */
import path from "node:path";
import { FakeAdapter, type FakeScenario } from "../../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../../adapters/index.js";
import { ArtifactStore } from "../../artifacts/index.js";
import { createIdGenerator } from "../../ids/index.js";
import { createLedger, openLedger, type TrustProfile } from "../../ledger/index.js";
import { RunLifecycle } from "../../lifecycle/index.js";
import { WorkspaceManager } from "../../workspace/index.js";

interface ChildConfig {
  dataDir: string;
  root: string;
  repo: string;
  scenario?: FakeScenario;
  /** Custom fake CLI script (overrides scenario). */
  script?: string;
  /** T3.4: also admit a privileged run with this scope first (it stays AWAITING_APPROVAL). */
  privilegedScope?: unknown;
  /** T9.5: objective of the run (a fake-agent plan for the `git_attempts` scenario). */
  objective?: string;
}

const cfg = JSON.parse(process.argv[2] ?? "{}") as ChildConfig;
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

const db = openLedger(cfg.dataDir);
const ids = createIdGenerator();
const ledger = createLedger(db, { ids });
const artifacts = new ArtifactStore(path.join(cfg.dataDir, "artifacts"));
const workspace = new WorkspaceManager({ db, artifacts, dataDir: cfg.dataDir, allowedRoots: [cfg.root], ids });
const adapter = new FakeAdapter({
  ...(cfg.script ? { script: cfg.script } : { scenario: cfg.scenario ?? "hang" }),
  timeouts: { wallClockMs: 120_000, idleMs: 120_000, killGraceMs: 300 },
});

let privilegedRunId: string | undefined;
const lifecycle = new RunLifecycle({
  ledger,
  workspace,
  artifacts,
  adapters: new AdapterRegistry().register(adapter),
  allowedRoots: [cfg.root],
  globalConcurrency: 2,
  resolveProfile: profileFor,
  onTransition: (n) => {
    if (n.to !== "RUNNING") return;
    const run = ledger.getRunRecord(n.runId);
    process.stdout.write(
      `${JSON.stringify({ running: { runId: n.runId, metaSessionId: run?.meta_session_id, pgid: run?.pgid, privilegedRunId } })}\n`,
    );
  },
});

if (cfg.privilegedScope !== undefined) {
  privilegedRunId = (
    await lifecycle.submit({
      clientId: "client-a",
      objective: "privileged work",
      workspace: cfg.repo,
      trustProfile: "privileged",
      provider: "fake",
      privileged: { scope: cfg.privilegedScope },
    })
  ).runId;
}
const submitted = await lifecycle.submit({
  clientId: "client-a",
  objective: cfg.objective ?? "hang until killed",
  workspace: cfg.repo,
  trustProfile: "edit-untrusted",
  provider: "fake",
});
process.stderr.write(`submitted ${submitted.runId}\n`);
lifecycle.start();
setInterval(() => {}, 1000); // idle until SIGKILL
