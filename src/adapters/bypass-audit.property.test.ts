/**
 * Generated-input properties for the argv audit (NFR-MAINT-06, T8.11; ADR-0037, ADR-0045, FR-POL-03).
 *
 * For every declared bypass flag, short spelling and flag value the audit must refuse the generated spelling
 * without a context: bare, `flag=value`, short spellings inside clusters and joined to values, and flag values in
 * both the space-separated and `=` forms with arbitrary letter case. Deterministic: fixed seed, fixed run count.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  auditInvocation,
  bypassClassFlags,
  bypassClassShortFlags,
  bypassClassValues,
  findBypassFlags,
} from "./audit.js";
import { scopedBypassFlags } from "./providers.js";

/** Fixed so a CI failure reproduces locally; bump only with the reason recorded. */
const SEED = 811037;
const NUM_RUNS = 100;

const invocation = (...words: string[]) => ({ argv: ["cli", ...words], policyFlags: [] as string[] });
const inPolicy = (...words: string[]) => ({ argv: ["cli"], policyFlags: [...words] });

/** Arbitrary ASCII word fragment that cannot add bypass meaning of its own (no dashes, no `=`, no glob). */
const fragment = () =>
  fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), { maxLength: 6 }).map((chars) => chars.join(""));

describe("argv audit properties (T8.11)", () => {
  it("every declared bypass flag is refused bare and with =value, in argv and in policyFlags", () => {
    fc.assert(
      fc.property(fragment(), (suffix) => {
        for (const flag of bypassClassFlags()) {
          for (const inv of [invocation(flag), invocation(`${flag}=${suffix}`), inPolicy(flag)]) {
            expect(findBypassFlags(inv), `${flag} in ${JSON.stringify(inv)}`).toContain(flag);
            expect(auditInvocation(inv).length, `${flag} refused in ${JSON.stringify(inv)}`).toBeGreaterThan(0);
          }
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it("every declared short spelling is refused alone, clustered, joined and with =value", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), {
          minLength: 1,
          maxLength: 4,
        }),
        fragment(),
        (letters, suffix) => {
          for (const short of bypassClassShortFlags()) {
            const letter = short.slice(1);
            const cluster = `-${[...letters, letter].join("")}`;
            for (const inv of [
              invocation(short),
              invocation(cluster),
              invocation(`${short}${suffix}`),
              invocation(`${short}=${suffix}`),
              inPolicy(cluster),
            ]) {
              expect(findBypassFlags(inv), `${short} in ${JSON.stringify(inv)}`).toContain(short);
              expect(auditInvocation(inv).length, `${short} refused`).toBeGreaterThan(0);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: SEED + 1 },
    );
  });

  it("every declared bypass value is refused space-separated and joined, in any letter case", () => {
    const values = bypassClassValues();
    expect(values.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: values.length - 1 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 32 }),
        (index, bits) => {
          const entry = values[index] as { flag: string; value: string };
          const cased = [...entry.value]
            .map((c, i) => (/[a-z]/i.test(c) && bits[i % bits.length] === true ? c.toUpperCase() : c.toLowerCase()))
            .join("");
          const hit = `${entry.flag} ${entry.value}`;
          for (const inv of [
            invocation(entry.flag, cased),
            invocation(`${entry.flag}=${cased}`),
            inPolicy(entry.flag, cased),
          ]) {
            expect(findBypassFlags(inv), `${hit} in ${JSON.stringify(inv)}`).toContain(hit);
            expect(auditInvocation(inv).length, `${hit} refused`).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: SEED + 2 },
    );
  });

  it("provider-scoped flags of an unknown provider are refused in every generated spelling", () => {
    const scoped = scopedBypassFlags("no-such-provider-t811");
    expect(scoped.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(fragment(), (suffix) => {
        for (const flag of scoped) {
          const forms =
            flag.length === 2
              ? [flag, `-${`q${flag.slice(1)}q`}`, `${flag}${suffix}`, `${flag}=${suffix}`]
              : [flag, `${flag}=${suffix}`];
          for (const words of forms) {
            const inv = invocation(words);
            expect(findBypassFlags(inv, "no-such-provider-t811"), words).toContain(flag);
          }
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED + 4 },
    );
  });
});
