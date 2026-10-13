// Claude Code dialect of the shared replay helper (T4.3): the documented headless shape is `-p --output-format
// stream-json` with the prompt on stdin (src/adapters/claude/adapter.ts). Session placeholder: {{SESSION_ID}}.
const opt = (list, name) => {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
};

/**
 * @typedef {object} Dialect
 * @property {(argv: string[], fail: (msg: string, code: number) => never) => void} check
 *   Exits 64 (through `fail`) when the provider argv is not the documented headless shape.
 * @property {(argv: string[]) => string | undefined} probe  Output for a probe invocation (exit 0), or undefined.
 * @property {(argv: string[]) => { token: string, value: string | undefined }} session  Placeholder and its value.
 * @property {boolean} requireSynthetic  The fixture's first line must carry { _fixture: { synthetic: true } }.
 */

/** @type {Dialect} */
export default {
  check(argv, fail) {
    if (!argv.includes("-p") || opt(argv, "--output-format") !== "stream-json") {
      fail("expected claude -p --output-format stream-json", 64);
    }
  },
  probe: () => undefined,
  session: (argv) => ({
    token: "{{SESSION_ID}}",
    value: opt(argv, "--resume") ?? "00000000-0000-4000-8000-000000000001",
  }),
  requireSynthetic: false,
};
