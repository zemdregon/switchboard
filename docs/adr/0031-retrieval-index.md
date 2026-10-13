# ADR-0031: Per-project and deployment-wide retrieval index

- Status: Proposed (every mechanism is unverified; nothing is implemented)
- Date: 2026-10-13
- Decided by: zemdregon (the product request, owner decision 40, 2026-10-13: "per project automatic RAG/Vector DB for
  reduced context requirements, as well as possibly a deployment wide RAG for general info across all projects").
  Delegated (agent, 2026-10-13) for everything else: the storage format, the backend port, the exclusions, the privacy
  gates, the sharing rules and the M12 placement. Not owner-approved.
- Related: FR-RAG-01–14, CAP-13, BO-9, FR-INN-03, FR-INN-06, FR-INN-16, FR-PRJ, NFR-PRIV-01, NFR-SEC-01,
  [ADR-0003](0003-no-credential-handling.md), [ADR-0013](0013-projects-environments-and-contexts.md),
  [ADR-0016](0016-inner-agent.md), [ADR-0022](0022-nested-repositories-excluded-from-controller-git.md),
  [ADR-0026](0026-per-run-tool-channel-socket-and-token.md)
- Extends: [ADR-0016](0016-inner-agent.md) (reuses its locality classification and privacy gates for a second kind of
  model call), without changing its decision.

## Context

Every delegated run starts with whatever context the orchestrator puts in the prompt plus whatever the provider agent
reads for itself. Both cost subscription capacity, which the product exists to conserve (BO-1). zemdregon asked for an
automatic per-project index (RAG, a vector database) so a run needs less context passed in, and possibly a
deployment-wide one for general information across projects.

No retrieval, embedding or vector material exists anywhere in the research or the specifications (audit, 2026-10-13), so
this is new. It crosses four existing constraints. Switchboard never handles provider credentials (ADR-0003). Controller
data stays on the host except provider CLI traffic and configured telemetry (NFR-PRIV-01), so sending source text to an
embedding service is a new egress, the same kind ADR-0016 gated. Repository content is untrusted input, so indexed text
is a prompt-injection path (R-55). And projects are isolated from each other (ADR-0013), so a deployment-wide index is a
cross-project data flow.

## Decision

All Proposed and Delegated.

1. **A retrieval service, COMP-RAG, owns the index** (FR-RAG-01). It is called by admission, the MCP layer and `doctor`.
   It is not part of the policy path (item 6).
2. **One store per project, kept in the data directory, never in the repository** (FR-RAG-01, FR-RAG-03). Mode `auto` is
   on if and only if an embedding backend is configured; `off` and `on` exist (Q-49). With no backend the feature is
   inert and nothing else changes.
3. **Embeddings come from a backend port with kinds `local` and `http`**, using the inner-agent locality classification
   and gates. A `remote` backend sees source content only with both `allow_remote` and `allow_source_content`.
   Switchboard holds no key (FR-RAG-04, ADR-0003).
4. **Only readable context files are indexed, with exclusions and redaction before embedding**: nested repositories,
   escaping symlinks, binary and oversized files, ignored files, a built-in secret denylist, operator `exclude`, and the
   FR-INN-16 redaction on chunk text (FR-RAG-02). The denylist is best effort (R-56).
5. **A context pack is optional and bounded.** At admission the controller may prepend retrieved snippets within
   `max_context_tokens`, each labelled with path, index revision, score and an "untrusted reference data" marker. The
   original request text is stored unchanged, the ledger holds snippet ids and hashes, and any retrieval failure means
   no retrieval, never a failed run (FR-RAG-05, FR-RAG-08).
6. **Retrieved content has no authority.** It is never an input to a profile, policy snapshot, eligibility, approval,
   ceiling, push or commit decision. Enforced by structure, with an import-boundary test like ADR-0016's (FR-RAG-07).
7. **Store layout (Proposed, to be settled by the T12.0 spike).** One SQLite file per project plus one for the global
   index, chunk text and float32 vectors as BLOBs, brute-force cosine search in process under a hard chunk cap, so no
   new native dependency. An approximate-nearest-neighbour index or vector extension only if the spike shows the cap is
   too low (Q-48). The embedding model is an operator choice; no model name, dimension or latency is stated here.
8. **The deployment-wide index is off by default and opt-in on both sides.** It holds operator-added local knowledge
   sources and content a project explicitly contributes (`contribute_to_global`, default false; `untrusted` contexts do
   not contribute by default). A run reads it only if its project sets `use_global: true`; every global snippet names
   its origin project (FR-RAG-09, FR-RAG-10, Q-50).
9. **Search is read-only and project-scoped.** The MCP tool `search_project_context` returns bounded results for the
   client's own projects only (FR-RAG-06). An agent-callable search through the per-run tool channel waits for an
   adapter with an injected channel (FR-RAG-13, ADR-0026).
10. **Builds run in the background in `serve`**, are bounded, never block admission, and mark a partial index
    incomplete. Operators can clear any index (FR-RAG-11, FR-RAG-14). Embedding calls are recorded separately and never
    enter `usage_observation` or capacity (FR-RAG-12).
11. **Placement.** New milestone M12, after M9 (projects) and using the M11 backend port (T11.1) and its privacy gates.

## Alternatives considered

- **No retrieval (status quo).** Rejected: it leaves the context cost with the orchestrator and the provider agent,
  which is what zemdregon asked to reduce. Kept as the fallback for every failure.
- **An index inside the repository.** Rejected: it would put model-derived content and possibly sensitive chunks into a
  tree that agents and the operator commit from, and conflicts with the controlled-commit boundary (ADR-0014).
- **A vector database service (a server process or hosted service).** Not adopted for the first version: a new
  dependency, a new network surface and a possible credential, for a data size the T12.0 spike may show fits in process.
  Reconsidered if the spike shows the in-process cap is too low.
- **A deployment-wide index on by default, or shared automatically.** Rejected: it moves one project's code into another
  project's prompts. Opt-in on both the contributing and the using side is the least that stops that.
- **Let retrieval pick the trust profile or the files to expose.** Rejected outright, as for the inner agent: indexed
  text is injectable, so it cannot hold a security decision (FR-RAG-07).

## Consequences

- A new component, COMP-RAG, and new trust boundaries: embedding egress (like TB-10) and the global store (a
  cross-project data flow). The HLD owns their numbers.
- A new persistent store under the data directory, holding chunk text and vectors unencrypted (R-56). It is deleted with
  its project and clearable by the operator.
- Indexed repository content, and content from other projects through the global index, can carry prompt injection into
  later runs (R-55). Labelling and the no-authority rule limit the worst case to a misled agent inside its own profile.
- Retrieval may be stale or wrong, and the token saving is unmeasured (R-57). Freshness checks, index revisions and
  recorded snippet hashes make this visible.
- The `delegate_task` prompt assembly, `doctor`, the `index` operator commands and `search_project_context` are
  interface changes covered by this ADR and by the LLD.
- Tests must pass with no embedding backend (a fake backend with deterministic vectors is part of the suite); live
  embedding calls are opt-in like all live provider calls.

## Revisit when

The T12.0 spike shows the in-process cap is too low or too slow; measured runs show retrieval does not reduce context
cost (R-57); a backend needs a credential the operator cannot keep in a local gateway; or zemdregon asks for sharing
beyond one operator's installation (currently excluded, ADR-0011).
