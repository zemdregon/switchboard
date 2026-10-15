// Antigravity dialect of the shared replay helper (T4.35, FR-ADP-11): `--prompt=<prompt> --output-format stream-json
// --dangerously-skip-permissions [--conversation <id>]` with the prompt in the one `--prompt=` argv word and stdin
// unused, and `AGY_CLI_DISABLE_AUTO_UPDATE=true` in the environment (src/adapters/antigravity/adapter.ts). Session
// placeholder: {{SESSION_ID}}. The version and help text below are SYNTHETIC test data, not a claim about the real CLI.
//
// `agy` parses flags like Go's `flag` package (live check C3, ADR-0045): one dash and two dashes name the same flag,
// `=value` is the same flag, a repeated flag keeps its last value, a bool flag does not take the next word, and parsing
// stops at `--` or the first non-flag word. An unknown flag is `flag provided but not defined` (C3). The walk below
// follows those rules and then accepts only the argv the adapter compiles, so a spelling Go would read differently
// from that argv cannot replay a success.
const opt = (list, name) => {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
};

const PROMPT = "--prompt=";
const SKIP = "--dangerously-skip-permissions";

// String flags take `=value` or the next word, even when that word looks like a flag. Bool flags are presence only.
// Names are the Go flag name (no leading dashes). `-p` / `--print` are documented prompt aliases ([H]); they are not
// the compiled spelling. Underscores are not dashes: `--gemini_dir` is its own flag (ADR-0045), and
// `--dangerously_skip_permissions` is not defined.
const STRING_FLAGS = new Set([
  "prompt",
  "print",
  "p",
  "output-format",
  "conversation",
  "gemini_dir",
  "add-dir",
  "mode",
  "model",
  "print-timeout",
  "agent",
  "effort",
  "input-format",
  "json-schema",
  "log-file",
  "project",
]);
const BOOL_FLAGS = new Set([
  "dangerously-skip-permissions",
  "yolo",
  "force",
  "always-approve",
  "approve-mcps",
  "full-auto",
  "remote-control",
  "continue",
  "c",
  "help",
  "version",
  "sandbox",
  "disable-slash-commands",
  "prompt-interactive",
  "i",
  "new-project",
]);

/** @returns {{ kind: "end" | "positional" | "bad" } | { kind: "flag", dashes: string, name: string, hasEq: boolean, value: string | undefined, raw: string }} */
const parseFlag = (word) => {
  if (word === "--") return { kind: "end" };
  if (word === "-" || !word.startsWith("-")) return { kind: "positional" };
  const dashes = word.startsWith("--") ? "--" : "-";
  let body = word.slice(dashes.length);
  if (body.length === 0 || body.startsWith("-") || body.startsWith("=")) return { kind: "bad" };
  let hasEq = false;
  let value;
  const eq = body.indexOf("=");
  if (eq >= 0) {
    hasEq = true;
    value = body.slice(eq + 1);
    body = body.slice(0, eq);
    if (body.length === 0) return { kind: "bad" };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(body)) return { kind: "bad" };
  return { kind: "flag", dashes, name: body, hasEq, value, raw: word };
};

// API-key mode stays disabled (adapter.ts ANTIGRAVITY_ENV_ALLOWLIST): none of these may reach the provider process.
const REFUSED_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_CLOUD_PROJECT"];

/** @type {import("./claude.mjs").Dialect} */
export default {
  check(argv, fail) {
    /** @type {Record<string, { dashes: string, name: string, hasEq: boolean, value: string | true, raw: string }[]>} */
    const got = {};
    const push = (name, rec) => {
      got[name] = [...(got[name] ?? []), rec];
    };
    for (let i = 0; i < argv.length; i++) {
      const word = argv[i];
      const parsed = parseFlag(word);
      if (parsed.kind === "end") {
        fail("`--` ends flag parsing, so a later flag would not reach agy", 64);
      }
      if (parsed.kind === "positional") {
        fail(`positional ${JSON.stringify(word)} stops flag parsing before later flags`, 64);
      }
      if (parsed.kind === "bad") fail(`bad flag syntax: ${word}`, 64);
      const { dashes, name, hasEq, raw } = parsed;
      if (BOOL_FLAGS.has(name)) {
        // `=false` beside the bare word is the same flag and the last value wins. The cell emits the bare word once.
        if (hasEq) fail(`bool flag ${raw} is not the bare word the cell compiles`, 64);
        push(name, { dashes, name, hasEq, value: true, raw });
        continue;
      }
      if (!STRING_FLAGS.has(name)) fail(`flag provided but not defined: -${name}`, 64);
      let value = parsed.value;
      if (!hasEq) {
        i += 1;
        if (i >= argv.length) fail(`flag needs an argument: -${name}`, 64);
        value = argv[i];
      }
      push(name, { dashes, name, hasEq, value: value ?? "", raw: hasEq ? raw : `${dashes}${name}` });
    }

    const formats = got["output-format"] ?? [];
    const format = formats[0];
    if (formats.length !== 1 || format?.dashes !== "--" || format.hasEq || format.value !== "stream-json") {
      fail(
        "expected exactly one `--output-format stream-json` (a repeated, one-dash or `=` form is the same flag)",
        64,
      );
    }
    const promptForms = ["prompt", "print", "p"].flatMap((name) => got[name] ?? []);
    const prompt = promptForms[0];
    if (
      promptForms.length !== 1 ||
      prompt?.name !== "prompt" ||
      prompt.dashes !== "--" ||
      !prompt.hasEq ||
      !prompt.raw.startsWith(PROMPT)
    ) {
      fail("expected exactly one --prompt=<prompt> word", 64);
    }
    const skips = got["dangerously-skip-permissions"] ?? [];
    if (skips.length !== 1 || skips[0]?.raw !== SKIP) {
      fail(`expected ${SKIP} exactly once, as its own word (a repeated, one-dash or \`=\` form is the same flag)`, 64);
    }
    const conversations = got.conversation ?? [];
    if (conversations.length > 1) fail("expected at most one `--conversation <id>`", 64);
    const conversation = conversations[0];
    if (conversation !== undefined) {
      const id = conversation.value;
      if (
        conversation.dashes !== "--" ||
        conversation.hasEq ||
        conversation.raw !== "--conversation" ||
        typeof id !== "string" ||
        id === "" ||
        id.startsWith("-")
      ) {
        fail("expected at most one `--conversation <id>` with an id", 64);
      }
    }
    const allowed = new Set(["output-format", "prompt", "dangerously-skip-permissions", "conversation"]);
    const extra = Object.keys(got).filter((name) => !allowed.has(name));
    if (extra.length > 0) fail(`flag refused: ${extra.join(" ")}`, 64);

    if (process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== "true") fail("expected AGY_CLI_DISABLE_AUTO_UPDATE=true", 64);
    const leaked = REFUSED_ENV.filter((k) => Object.hasOwn(process.env, k));
    if (leaked.length > 0) fail(`environment refused: ${leaked.join(" ")}`, 64);
  },
  probe(argv) {
    // Only the whole argv. A run that starts with `--help` or `--version` and then the compiled flags must fall
    // through to `check` (exit 64), not exit 0 with probe text and no fixture.
    if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-version")) return "0.0.1\n";
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-help" || argv[0] === "-h" || argv[0] === "--h")) {
      return "SYNTHETIC help: --prompt --output-format --dangerously-skip-permissions --conversation\n";
    }
    return undefined;
  },
  session(argv) {
    return { token: "{{SESSION_ID}}", value: opt(argv, "--conversation") };
  },
  prompt(argv) {
    const word = argv.find((a) => a.startsWith(PROMPT));
    return word === undefined ? "" : word.slice(PROMPT.length);
  },
  requireSynthetic: true,
};
