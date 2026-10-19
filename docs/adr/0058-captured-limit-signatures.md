# ADR-0058: Captured distinctive limit signatures map to QUOTA_EXHAUSTED

- Status: Accepted (owner decision 64)
- Date: 2026-10-18
- Decided by: Linus, relaying the owner's direction (owner-level choice (a), 2026-10-18: "keep the Cursor and
  Kimi mappings but only matching distinctive text from real captures in limit-captures/; requires a superseding
  ADR plus FR-ADP-04 and Q-100 amendment (structured-enough captured signatures, never generic words)"). The wording
  below is the relayed text, not checked against zemdregon's own words; the reading of it is Delegated. Nothing here
  changes what a bypass run may do.
- Supersedes in part: item 11 of [ADR-0055](0055-model-groups-and-usage-pacing.md) (a signal that is a
  structured-enough captured distinctive signature, as defined below, maps to a taxonomy code; the rest of item 11
  stands: mapping is otherwise from structured output only, a free-text-only signal stays unclassified, and a sourced
  usage or reset key enters `USAGE_KEYS` only through its own task). Item 11's text now reads "Superseded by
  ADR-0058 for captured distinctive signatures"; its former last two sentences ("An adapter maps a signal to a
  taxonomy code only from structured output (FR-ADP-04). A signal that a CLI gives only as free text stays
  unclassified until a decision says otherwise (Q-100).") are kept here as the superseded wording for the record.
- Related: FR-ADP-04 (amended), FR-CAP-11, Q-100 (answered by owner decision 64), ROADMAP T6.11, T6.15,
  [LLD §16.9](../design/LLD.md#169-usage-windows-and-pacing-fr-cap-09-fr-cap-10), [ADR-0007](0007-capacity-as-confidence-estimate.md)

## Context

[ADR-0055](0055-model-groups-and-usage-pacing.md) item 11 (accepted, owner decision 57) says an adapter maps a limit
signal to a taxonomy code only from structured output, and a free-text-only signal stays unclassified until a decision
says otherwise (Q-100). FR-ADP-04 (Must) forbids inferring status by pattern-matching free text. T6.11's captures hold
two recurring quota stops that are free text under that classification but are not generic prose: Cursor's out-of-usage
line (a provider-specific error class plus a limit phrase, exit 1) and Kimi Code's 5-hour usage-limit line (a
provider-specific status plus a limit phrase, exit 1, labelled `provider.auth_error` by its own CLI). PR #700 maps
both in `classifyFailure` (`cursorQuotaClassification`, `kimiQuotaClassification`); the doc-align gate held the merge
for an owner decision. The owner chose (a): keep the mappings, but only for distinctive text taken from real captures,
recorded in a superseding ADR with an FR-ADP-04 amendment answering Q-100.

## Decision

1. A **structured-enough captured distinctive signature** is a stderr-tail line that meets all of these:
   - (a) Taken verbatim from a real capture in `~/operator-runs/limit-captures/` from normal use (operator logs or
     the budgeted live-run channel, never generated load). The ADR or task row cites the capture file names, never
     contents beyond the matched phrases, and never an account identifier.
   - (b) A provider-specific error class/code token **and** a limit phrase, both required, on one stderr-tail line
     (today: Cursor `ActionRequiredError` + `out of usage`; Kimi Code `403` on word boundaries + `usage limit`).
   - (c) Matched only for a non-zero, unexpected exit: never on exit 0, never on a cancelled run, and the mapping
     replaces `TOOL_FAILURE` (Kimi: `TOOL_FAILURE` or `AUTH_REQUIRED`, since the CLI mislabels the stop) only, so
     every more specific verdict (timeout, crash, denial, auth/model error, protocol anomaly, rate limit) stands.
   - (d) Never a generic word alone: `limit`, `quota`, `rate`, `429` (or any bare status/number) without the paired
     provider-specific token maps nothing.
   - (e) Each signature ships with a positive test built from the capture text and at least one near-miss test (one
     half of the pair alone, the halves on different lines, a generic-word line), pinning (c) and (d).
2. The two T6.11 signatures above satisfy this definition and map to `QUOTA_EXHAUSTED` in `classifyFailure`. No reset
   is sourced from them and no `USAGE_KEYS` entry is declared by them.
3. **Misclassification bound.** The worst case is a different `ActionRequiredError` carrying the same limit phrase
   (Cursor) or a different `403` carrying a usage-limit phrase (Kimi) mapping to `QUOTA_EXHAUSTED`. The cost is
   bounded: `QUOTA_EXHAUSTED` only triggers the T6.6 ladder (failover, or wait for a known reset, else fail) — it
   never authorises a run, never bypasses a control, and never reports a success. A generic-word line can never
   match, by (d).
4. A future signature needs the same treatment: real capture, both halves, tests, and its own task row; this ADR
   does not bless free-text matching in general. FR-ADP-04 keeps its `Must` with one exception sentence pointing
   here.

## Alternatives considered

- **Keep fail closed (drop the two mappings).** Rejected by the owner: the captures are stable, provider-specific
  markers from normal use, and the misclassification cost is failover only.
- **Allow distinctive-phrase matching without captures.** Rejected: without a real capture there is no evidence the
  phrase is a stable CLI marker rather than paraphrase; (a) is the guardrail.
- **Treat the signatures as structured output.** Rejected: they are free text under T6.11's classification; calling
  them structured would weaken FR-ADP-04 instead of amending it.

## Consequences

- FR-ADP-04 and FR-CAP-11 gain one exception sentence each pointing here; Q-100 is answered by owner decision 64 (the
  Delegated fail-closed default stands as history).
- The PR #700 mappings (`cursorQuotaClassification`, `kimiQuotaClassification`) are accepted as built, with their
  tests plus the generic-word near-miss pins.

## Revisit when

- A capture shows either signature changing shape (new class name, new code, reworded phrase): the signature's task
  rewires or retires it; a changed phrase is a new signature, not an edit.
- A capture shows a structured field for either stop: the mapping moves to it and this ADR's exception narrows.
- A misclassification worse than failover is demonstrated: this ADR is revisited before any new signature is added.
