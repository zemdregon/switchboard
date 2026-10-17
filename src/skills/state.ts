/**
 * Skill state derivation (T16.1; LLD §19.2, ADR-0056 items 3 and 11). Pure: state is never stored, it is derived from
 * the append-only `skill_event` rows. A version is `draft` until its newest `approved`/`revoked` event says otherwise;
 * a name is retired while its newest `retired`/`unretired` event is `retired`.
 */

export type SkillEventKind = "added" | "approved" | "revoked" | "retired" | "unretired";
export type SkillVersionState = "draft" | "approved" | "revoked";

export interface SkillEventFact {
  /** Ledger order (`skill_event.id`); a larger id is newer. */
  readonly id: number;
  readonly name: string;
  readonly version: number | null;
  readonly kind: SkillEventKind;
}

export interface SkillNameState {
  readonly name: string;
  readonly retired: boolean;
  /** One entry per version in `versions`, ascending. */
  readonly versions: readonly { readonly version: number; readonly state: SkillVersionState }[];
}

function newestOf(events: readonly SkillEventFact[], pick: (e: SkillEventFact) => boolean): SkillEventFact | undefined {
  let newest: SkillEventFact | undefined;
  for (const e of events) if (pick(e) && (newest === undefined || e.id > newest.id)) newest = e;
  return newest;
}

export function deriveVersionState(
  events: readonly SkillEventFact[],
  name: string,
  version: number,
): SkillVersionState {
  const e = newestOf(
    events,
    (x) => x.name === name && x.version === version && (x.kind === "approved" || x.kind === "revoked"),
  );
  return e === undefined ? "draft" : e.kind === "approved" ? "approved" : "revoked";
}

export function deriveRetired(events: readonly SkillEventFact[], name: string): boolean {
  return (
    newestOf(events, (x) => x.name === name && (x.kind === "retired" || x.kind === "unretired"))?.kind === "retired"
  );
}

/** State of one name and each of its stored versions. Events of other names are ignored. */
export function deriveSkillState(
  name: string,
  versions: readonly number[],
  events: readonly SkillEventFact[],
): SkillNameState {
  return {
    name,
    retired: deriveRetired(events, name),
    versions: [...versions]
      .sort((a, b) => a - b)
      .map((version) => ({ version, state: deriveVersionState(events, name, version) })),
  };
}

/** Newest approved version of a name, or `undefined` when the name is retired or none is approved (LLD §19.2). */
export function newestApprovedVersion(state: SkillNameState): number | undefined {
  if (state.retired) return undefined;
  let newest: number | undefined;
  for (const v of state.versions) if (v.state === "approved") newest = v.version;
  return newest;
}
