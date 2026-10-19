/**
 * Generated-input properties for the CI untrusted-block renderer (FR-QUE-03, NFR-MAINT-06, T8.11; LLD §18.6).
 *
 * Generated external text — including the block markers themselves, control characters and over-long input —
 * must never open or close the labelled block: the rendered block holds exactly one opener line and one closer
 * line, and the text stays within its bound. Deterministic: fixed seed, fixed run count.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { UNTRUSTED_SUMMARY_MAX, untrustedBlock, untrustedExternalText } from "./untrusted.js";

/** Fixed so a CI failure reproduces locally; bump only with the reason recorded. */
const SEED = 811503;
const NUM_RUNS = 100;

const OPENER = "[untrusted_external_text]";
const CLOSER = "[/untrusted_external_text]";

describe("CI untrusted-block properties (T8.11)", () => {
  it("generated text never opens or closes the block and stays within its bound", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 2000 }),
        fc.constantFrom("", OPENER, CLOSER, "{{ci_untrusted_summary}}", "[untrusted]", "[/untrusted]"),
        (raw, spike) => {
          const text = `${spike}\n${raw}\n${spike}`;
          const block = untrustedBlock(untrustedExternalText(text));
          const lines = block.split("\n");
          expect(
            lines.filter((l) => l === OPENER),
            JSON.stringify(text),
          ).toHaveLength(1);
          expect(
            lines.filter((l) => l === CLOSER),
            JSON.stringify(text),
          ).toHaveLength(1);
          expect(lines[0]).toBe(OPENER);
          expect(lines[lines.length - 1]).toBe(CLOSER);
          const inner = untrustedExternalText(text);
          expect(inner.text.length).toBeLessThanOrEqual(UNTRUSTED_SUMMARY_MAX);
        },
      ),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });
});
