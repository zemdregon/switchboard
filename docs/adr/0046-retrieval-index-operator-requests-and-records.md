# ADR-0046: Retrieval index operator requests and records in the ledger

- Status: Proposed
- Date: 2026-10-14
- Decided by: Delegated (agent, 2026-10-14, ROADMAP T12.4), under [owner decision 25](../ROADMAP.md#42-owner-decisions).
  Not a zemdregon quote and not owner-approved. Retrieval is off unless the operator configures an embedding backend,
  and nothing here changes what an approved bypass run may do, its Git-write denial or its worktree isolation.
- Extends: [ADR-0031](0031-retrieval-index.md) (retrieval index) and [ADR-0005](0005-sqlite-ledger.md)
  (single-writer ledger, operator records applied by the daemon).
- Related: FR-RAG-11, FR-RAG-12, FR-RAG-14, [LLD §14.5](../design/LLD.md#145-incremental-build),
  [LLD §14.10](../design/LLD.md#1410-events-and-records), ROADMAP T12.4

## Context

FR-RAG-11 says `switchboard index {status,rebuild,clear}` writes only operator records that the `serve` daemon reads,
"as `approve` does", and FR-RAG-14 says a clear deletes vectors and chunk text while the ledger keeps counts. LLD §14.10
defines the append-only `rag_record` table for those counts but no place for the requests themselves. The existing
operator records (cancel, approve) are `run_event` rows, which need a run; an index request has no run. The cancel
convention in `src/cli/operator.ts` already names "a dedicated operator request table (new migration plus LLD §1 and an
ADR)" as the alternative.

## Decision

1. Ledger migration 15 adds `rag_record` as LLD §14.10 defines it (append-only guards; counts, codes and durations
   only), except that `run_id` has no foreign key, so retention GC can delete a run without knowing about this table
   (as `project_affinity.last_run_id`, migration 14).
2. The same migration adds `rag_request` (`id` `rrq_…`, `kind` `rebuild` or `clear`, `store_kind`, `project_key`,
   `requested_by`, `requested_at`, and `applied_at`, `outcome`, `detail` set once). The CLI inserts a row per store; the
   daemon applies pending rows in its one-second operator poll. With no daemon holding the data-directory lock, `clear`
   takes the lock and applies itself (as `approve` does); `rebuild` stays pending until `serve` starts, because only the
   daemon builds.
3. A clear deletes the store directory and writes one `rag_record` of kind `clear` with the file, chunk and byte counts
   it removed. A rebuild deletes the store and queues a build; a store for a project whose retrieval is on is rebuilt
   at its next trigger after a clear, so the operator sets `rag.mode: "off"` to keep it empty.
4. The ledger code for both tables lives in `src/ledger/rag.ts`, never in `src/retrieval/`, so the retrieval modules
   keep importing no ledger code (the T12.3 import test).

## Consequences

- One mutable table (`rag_request`, three columns written once) joins the append-only ones; it holds no content.
- `run_event` keeps only run-scoped records; index builds are not run events (`rag_index_built` and
  `rag_index_cleared` of LLD §14.10 are not written in this version; the `rag_record` row carries the same fields).
- A downgrade to a build before migration 15 refuses the ledger (forward-only migrations, ADR-0005).
