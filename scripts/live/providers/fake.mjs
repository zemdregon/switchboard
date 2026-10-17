/**
 * Fake live plug-in (T8.9, test fixture). It exports the whole plug-in contract (see `claude.mjs`) but stands for no
 * provider CLI: `fixture: true` makes `scripts/live-smoke.mjs` and `scripts/live-pair.mjs` stop right after the
 * live-test budget guard (`scripts/live/budget.mjs`), before `dist/` is loaded or any process is spawned, and hand this
 * plug-in the compile request the shared flow would audit. It is selectable but not listed in the scripts' messages.
 *
 * "Spawning" the fake is `createAdapter`; each call and each compile is appended as one JSON line to the file named by
 * SWITCHBOARD_LIVE_FAKE_RECORD (when set), so a test can assert the fake was never reached on a refusal and which model
 * it received on an admitted run. It records ids and the model only.
 */
import { appendFileSync } from "node:fs";

const note = (rec) => {
  const file = process.env.SWITCHBOARD_LIVE_FAKE_RECORD;
  if (file) appendFileSync(file, `${JSON.stringify(rec)}\n`);
};

export default {
  id: "fake",
  group: "T8.9",
  checkPrefix: "F",
  fixture: true,
  createAdapter: () => {
    note({ hook: "createAdapter" });
    return {
      id: "fake",
      compile(request) {
        note({ hook: "compile", runId: request.runId, model: request.model ?? null });
        return { argv: ["fake"], policyFlags: [] };
      },
    };
  },
  async probeChecks() {},
  async authChecks() {},
  observeEvent() {},
  streamChecks() {},
  gitWriteChecks() {},
};
