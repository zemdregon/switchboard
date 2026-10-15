/**
 * NFR-SEC-04: the controller runs as an unprivileged user and never requires root. `serve` refuses to start and
 * `doctor` reports a failing check when the effective uid is 0.
 *
 * Delegated (agent work, not owner-approved):
 * - There is no override flag or environment variable. TDD §3.4 had proposed "unless explicitly overridden"; no ADR or
 *   owner decision defines one, so none is offered (fail closed).
 * - An effective uid that cannot be read (`process.geteuid` absent, as on native Windows, NFR-PORT-03 Deferred) is
 *   treated as unverified and also refused: the requirement cannot be shown to hold, so the check fails closed.
 * - Only the effective uid is checked. Root inside a user namespace (for example rootless Docker, where container uid 0
 *   is an unprivileged host user) is still uid 0 to this process and is refused; whether to allow it is an open question.
 */

/** Effective uid of this process, or `undefined` when the platform does not expose one. Injectable for tests. */
export type EffectiveUidGetter = () => number | undefined;

export const defaultEffectiveUid: EffectiveUidGetter = () =>
  typeof process.geteuid === "function" ? process.geteuid() : undefined;

export type PrivilegeCheck =
  | { readonly ok: true; readonly uid: number }
  | { readonly ok: false; readonly code: "RUNNING_AS_ROOT" | "UID_UNKNOWN"; readonly message: string };

/** Classify the effective uid. A getter that throws or returns a non-integer counts as unknown (fail closed). */
export function checkUnprivileged(getUid: EffectiveUidGetter = defaultEffectiveUid): PrivilegeCheck {
  let uid: number | undefined;
  try {
    uid = getUid();
  } catch {
    uid = undefined;
  }
  if (uid === undefined || !Number.isInteger(uid) || uid < 0) {
    return {
      ok: false,
      code: "UID_UNKNOWN",
      message: "cannot read the effective user id, so running unprivileged cannot be verified (NFR-SEC-04)",
    };
  }
  if (uid === 0) {
    return {
      ok: false,
      code: "RUNNING_AS_ROOT",
      message: "running as root (effective uid 0); run switchboard as an unprivileged user (NFR-SEC-04)",
    };
  }
  return { ok: true, uid };
}
