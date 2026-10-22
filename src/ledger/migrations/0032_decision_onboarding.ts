/**
 * Migration 0032 (ADR-0068; FR-CTL-13, FR-PRJ-10 note 2026-10-20, LLD §20.3): `decision_request.onboarding_url`, the
 * repository a `request_decision` with `onboarding` proposes for a project that does not exist yet (or is the client's
 * own dynamic project waiting for approval). The value is the controller-normalised `https://<host>/<owner>/<repo>`
 * form (`src/projects/clone.ts`), never client text as given, so it carries no credential, query or fragment; NULL for
 * every other decision. `project_id` already has no foreign key (migration 0030), so a proposed id needs no change.
 *
 * Forward only (ADR-0005): one nullable column added in place; existing rows read NULL. Immutable once released: the
 * checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
ALTER TABLE decision_request ADD COLUMN onboarding_url TEXT
  CHECK (onboarding_url IS NULL OR (length(onboarding_url) BETWEEN 9 AND 512 AND onboarding_url LIKE 'https://%'));
`;
