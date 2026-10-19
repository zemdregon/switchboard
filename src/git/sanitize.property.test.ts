/**
 * Generated-input properties for the commit-message sanitiser (FR-GIT-04, NFR-MAINT-06, T8.11; ADR-0025).
 *
 * A generated canary — a controller id in a built-in shape, or a caller-supplied native session id — embedded in
 * generated surrounding text must never survive sanitising. Deterministic: fixed seed, fixed run count.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sanitizeMessage } from "./sanitize.js";

/** Fixed so a CI failure reproduces locally; bump only with the reason recorded. */
const SEED = 811039;
const NUM_RUNS = 100;

const ID_PREFIX = ["sess_", "run_", "evt_", "art_", "dec_", "ckp_", "rte_", "apv_", "adv_", "use_", "pbd_"] as const;
const ID_ALPHABET = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"];

/** A controller id in a built-in shape (LLD §3.0): prefix plus 26 identifier characters. */
const controllerId = () =>
  fc
    .tuple(
      fc.constantFrom(...ID_PREFIX),
      fc.array(fc.constantFrom(...ID_ALPHABET), { minLength: 26, maxLength: 26 }).map((chars) => chars.join("")),
    )
    .map(([prefix, tail]) => `${prefix}${tail}`);

/** A provider-native session id a caller would pass in `nativeSessionIds` (at least 6 characters). */
const nativeId = () =>
  fc.array(fc.constantFrom(...ID_ALPHABET), { minLength: 8, maxLength: 32 }).map((chars) => chars.join(""));

/** Surrounding text in an alphabet that cannot itself form an id or a trailer (lowercase words and spaces). */
const surrounding = () =>
  fc
    .array(fc.constantFrom("fix", "update", "the", "parser", "and", "tests", "wip", "refactor"), {
      minLength: 1,
      maxLength: 12,
    })
    .map((words) => words.join(" "));

describe("sanitiser properties (T8.11)", () => {
  it("a generated controller id never survives, whatever surrounds it", () => {
    fc.assert(
      fc.property(controllerId(), surrounding(), surrounding(), (canary, before, after) => {
        for (const message of [`${before} ${canary} ${after}`, `${before}\n${canary}\n${after}`, canary]) {
          const out = sanitizeMessage(message);
          expect(out.message, JSON.stringify(message)).not.toContain(canary);
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it("a generated native session id passed by the caller never survives", () => {
    fc.assert(
      fc.property(nativeId(), surrounding(), surrounding(), (canary, before, after) => {
        for (const message of [`${before} ${canary} ${after}`, `${before}\n${canary}\n${after}`]) {
          const out = sanitizeMessage(message, { nativeSessionIds: [canary] });
          expect(out.message, JSON.stringify(message)).not.toContain(canary);
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED + 1 },
    );
  });
});
