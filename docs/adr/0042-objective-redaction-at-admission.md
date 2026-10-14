# ADR-0042: Redact the objective and constraints at admission

- Status: Proposed
- Date: 2026-10-14
- Decided by: Delegated (the orchestrator, Linus, answering Q-68 on PR #108, 2026-10-14), under [owner decision
  25](../ROADMAP.md#42-owner-decisions) for everything outside bypass mode. Not a zemdregon quote and not
  owner-approved. Nothing here changes what an approved bypass run may do.
- Builds on: [ADR-0003](0003-no-credential-handling.md) (no provider credential handling). It does not change it.
- Related: NFR-SEC-01, FR-TEL-03, FRD C3, [LLD §1](../design/LLD.md#1-data-model),
  [LLD §15](../design/LLD.md#15-continuity-and-the-handoff-bundle-m5), ROADMAP
  [Q-68](../ROADMAP.md#73-open-questions-for-zemdregon-not-blocking-m2-unless-noted).

## Context

The NFR-SEC-01 secret scan (`test/secret-scan.test.ts`, PR #108) found that the run objective was stored verbatim in
`meta_session.objective` and `run.request_json`. Those columns are the continuity record. A credential an orchestrator
pastes into a prompt therefore reached the ledger, the raw SQLite file and its WAL. Constraints have the same problem:
they are stored in `meta_session.constraints_json` and `run.request_json`, and a continuation inherits the stored
constraints of the meta-session's latest run (FRD C3). Redacting the stored text changes what the provider receives,
because the stored text is what dispatch compiles and what a continuation or handoff sends again.

## Decision (proposed)

1. **Where.** Admission (`RunLifecycle.validate`, `src/lifecycle/lifecycle.ts`) applies the artifact secret redactor
   (`defaultRedactor`, `src/artifacts/redact.ts`, the same patterns as stored artifacts) to the objective and to each
   constraint. This happens after validation and before anything is written. A matched value is replaced by
   `[REDACTED]`. A key name or `Bearer` prefix is kept, as for artifacts.
2. **Fail closed: the original is not kept.** Only the redacted text is stored. Dispatch compiles the stored text, so
   the provider receives the redacted text on the first run. A continuation and a handoff send stored text, so they
   send it redacted too. No column, event or artifact holds the original.
3. **Record.** When the redactor replaced at least one value, `run.request_json` gets `admission_redactions`, the
   number of replaced values in the objective and constraints. Literal `[REDACTED]` markers already in the input are
   not counted. With nothing replaced the field is absent, so an unchanged request is stored, and hashed, as before.
4. **Hashing.** The default idempotency hash is computed over the stored, redacted request. The MCP layer passes its own
   SHA-256 hash of the canonical tool input (BR-10, `src/mcp/server.ts`), which is stored in `run.request_hash`. So for
   MCP callers a replay that differs only inside a redacted value is still told apart. The column holds a digest of the
   whole input, not the value.

## Consequences

- NFR-SEC-01 holds for prompt text that matches a redactor pattern. The patterns are best effort (`src/artifacts/
  redact.ts`), so a credential in an unrecognised shape is still stored. The primary control is still that credentials
  are never routed into a prompt.
- A task that needed a credential-shaped string in the prompt now gets `[REDACTED]` instead. This is intended: the
  provider never needs a credential from the orchestrator's prompt.
- `run.request_json` gains one optional field. No migration: existing rows keep their verbatim text.
