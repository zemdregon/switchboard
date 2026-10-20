/**
 * Held-lock registry (T8.10; FR-EXE-09, LLD §20.14). Every lock this module hands out (the data-directory lock and each
 * verification slot) is listed here from acquisition until release, in this process. It is instrumentation, not a
 * control: it lets a test assert, without sleeping, which locks are held at a given moment, for example that the
 * verification stage holds no box-wide lock while it waits for a slot.
 */

export type HeldLock =
  | { readonly kind: "data_dir"; readonly lockPath: string }
  | { readonly kind: "verification_slot"; readonly index: number };

const held = new Set<HeldLock>();

/** Record `lock` as held; the returned function forgets it (idempotent). */
export function trackHeldLock(lock: HeldLock): () => void {
  held.add(lock);
  return () => {
    held.delete(lock);
  };
}

/** The locks this process holds now, in acquisition order. */
export function heldLocks(): readonly HeldLock[] {
  return [...held];
}
