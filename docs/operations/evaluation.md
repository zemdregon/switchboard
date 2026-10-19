# Own-repository evaluation (T8.14)

`switchboard eval` replays a fixed suite of your own past tasks as Switchboard runs on one provider, grades each
result in a network-off container with tests the agent never sees, and records pass, wall-clock time and reported usage
in the ledger (FR-OPS-06, [LLD §20.13](../design/LLD.md#2013-tamper-evident-ledger-provider-telemetry-evaluation-brief-and-critic-t813-t815-t814-t514-t1417)).
It is opt-in and operator-only. Nothing schedules it.

## Before you start

- **Real providers cost real quota.** Every provider except the test fake needs a live budget file (below). Each task
  is one run. Provider terms may treat evaluation suites as more than ordinary use (R-79); keep suites small.
- **It never runs in CI.** With `CI` set to anything but empty, `false` or `0`, `eval run` prints
  `EVAL_SKIPPED_IN_CI` and exits 0 without opening the ledger.
- **Stop `serve` first.** The command holds the data-directory lock for the whole suite, like `gc --apply`.
- **Docker.** Grading needs the rootless Docker runtime of the container environment
  ([ADR-0052](../adr/0052-container-environment-docker-backend.md)) and the grader image already present locally. The
  image is never pulled.

## Suite file

Write `<data_dir>/eval/<suite>.json`. The suite name is a plain file name (letters, digits, `_`, `-`).

```json
{
  "schema_version": 1,
  "project": "web",
  "grader": {
    "image_digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "timeout_seconds": 600,
    "test_command": ["sh", "-c", "cp -r /eval/tests/. . && npm test"]
  },
  "tasks": [
    {
      "id": "fix-123",
      "base_ref": "v1.4.0",
      "objective": "Fix the off-by-one in the pager so the last page is shown.",
      "hidden_tests": "bundles/fix-123"
    }
  ]
}
```

- `project` is a configured project. Each task runs in a fresh worktree of its primary context, starting from the
  task's `base_ref`.
- `trust_profile` (optional) defaults to `edit-untrusted`. `privileged` is refused, and the profile may not exceed the
  project's `max_trust_profile`.
- `hidden_tests` is a directory under `<data_dir>/eval/`, for example `<data_dir>/eval/bundles/fix-123/`. It must not
  be inside a project context. Symbolic links that lead outside `<data_dir>/eval/` are refused.
- The test command runs in the grader image with the agent's output (without `.git`) as the working directory
  `/eval/work`, which is writable, and the bundle read-only at `/eval/tests`. A task may set its own `test_command`. A
  task **passes only when the command exits 0**.
- The image is pinned by digest. The grader container gets no network, no login volume and no environment variables.

## Run it

```sh
# fake provider (test-only; needs SWITCHBOARD_TEST_FAKE_ADAPTER, never for real use)
switchboard eval run my-suite --provider fake

# a real provider: a budget file is required
cat > /tmp/claude-budget.json <<'EOF'
{"provider": "claude", "max_runs": 3}
EOF
switchboard eval run my-suite --provider claude --live-budget /tmp/claude-budget.json --json

# results recorded so far
switchboard eval results my-suite
```

The budget file must exist, be a JSON object, name the same provider and give `max_runs` as an integer above 0.
Otherwise the command fails with `EVAL_LIVE_BUDGET_REQUIRED` before any run is admitted. A suite with more tasks than
`max_runs` fails with `EVAL_LIVE_BUDGET_EXCEEDED`. On the Ampere operator host, real-provider runs also follow
`~/operator-runs/LIVE_TESTING.md` (check `live-usage.sh` first, cheapest model, one run, no reruns).

## Results

Each task writes one `eval_result` row. `--json` prints the same fields:

| Field | Meaning |
| --- | --- |
| `pass` | The hidden test command exited 0 |
| `test_exit_code` | The command's exit code; null when it was not run or did not complete |
| `grade_error` | Why the task was not graded or failed before the test: `EVAL_RUN_FAILED`, `EVAL_RUN_CANCELLED`, `EVAL_RUN_NOT_ADMITTED`, `EVAL_GRADER_UNAVAILABLE`, `EVAL_GRADER_NOT_ROOTLESS`, `EVAL_GRADER_IMAGE_NOT_PRESENT`, `EVAL_GRADER_IMAGE_AMBIGUOUS`, `EVAL_GRADER_NETWORK_NOT_OFF`, `EVAL_GRADER_FAILED` or `EVAL_TESTS_IN_WORKTREE` |
| `wall_clock_ms` | From submission to the run's terminal state |
| `usage_json` | The run's provider-reported usage metrics (`[]` when the provider reported none) |
| `run_id`, `run_state` | The normal run the task was replayed as. Inspect it with `switchboard runs show` |

`EVAL_TESTS_IN_WORKTREE` means a file of the hidden-test bundle was found in the agent's worktree at the same
relative path and with the same content, before or after grading. The task fails and the leak is worth investigating.
Test output is not stored.
