/**
 * UTC cron evaluation for Switchboard schedules (LLD §18.5, FR-QUE-02).
 *
 * Five fields: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-7, 0 and 7 = Sunday).
 * Vixie cron subset with `*`, `,`, `-`, `/`. No named months or aliases. UTC only.
 */

export class InvalidCronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCronError";
  }
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  allowSevenAsZero?: boolean;
}

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7, allowSevenAsZero: true },
];

/**
 * Parse one field token into a set of allowed integer values.
 */
function parseField(raw: string, spec: FieldSpec): { isWildcard: boolean; values: Set<number> } {
  if (raw === "") {
    throw new InvalidCronError(`empty cron field for ${spec.name}`);
  }

  // Reject any character outside digits, *, ,, -, /
  if (!/^[*0-9,\-/]+$/.test(raw)) {
    throw new InvalidCronError(`invalid characters in cron field ${spec.name}: ${JSON.stringify(raw)}`);
  }

  const items = raw.split(",");
  if (items.some((it) => it === "")) {
    throw new InvalidCronError(`empty item in comma-separated cron field ${spec.name}: ${JSON.stringify(raw)}`);
  }

  const values = new Set<number>();
  let isWildcard = false;

  for (const item of items) {
    const slashParts = item.split("/");
    if (slashParts.length > 2) {
      throw new InvalidCronError(`multiple slashes in cron item ${JSON.stringify(item)} of ${spec.name}`);
    }

    let step: number | undefined;
    if (slashParts.length === 2) {
      const stepStr = slashParts[1] ?? "";
      if (!/^\d+$/.test(stepStr)) {
        throw new InvalidCronError(`invalid step value in cron item ${JSON.stringify(item)} of ${spec.name}`);
      }
      step = Number.parseInt(stepStr, 10);
      if (step <= 0) {
        throw new InvalidCronError(`cron step must be positive in item ${JSON.stringify(item)} of ${spec.name}`);
      }
    }

    const rangePart = slashParts[0] ?? "";
    let start: number;
    let end: number;

    if (rangePart === "*") {
      start = spec.min;
      end = spec.max;
      if (step === undefined && items.length === 1) {
        isWildcard = true;
      }
    } else if (rangePart.includes("-")) {
      const dashParts = rangePart.split("-");
      const d0 = dashParts[0];
      const d1 = dashParts[1];
      if (dashParts.length !== 2 || !d0 || !d1 || !/^\d+$/.test(d0) || !/^\d+$/.test(d1)) {
        throw new InvalidCronError(`invalid range in cron item ${JSON.stringify(item)} of ${spec.name}`);
      }
      start = Number.parseInt(d0, 10);
      end = Number.parseInt(d1, 10);
      if (start > end) {
        throw new InvalidCronError(`range start greater than end in cron item ${JSON.stringify(item)} of ${spec.name}`);
      }
    } else {
      if (!/^\d+$/.test(rangePart)) {
        throw new InvalidCronError(`invalid number in cron item ${JSON.stringify(item)} of ${spec.name}`);
      }
      start = Number.parseInt(rangePart, 10);
      end = start;
    }

    if (start < spec.min || end > spec.max) {
      throw new InvalidCronError(
        `value ${rangePart} out of range [${spec.min}..${spec.max}] in cron field ${spec.name}`,
      );
    }

    const s = step ?? 1;
    for (let val = start; val <= end; val += s) {
      const mapped = spec.allowSevenAsZero && val === 7 ? 0 : val;
      values.add(mapped);
    }
  }

  return { isWildcard, values };
}

export interface ParsedCron {
  readonly expr: string;
  readonly fields: readonly { readonly isWildcard: boolean; readonly values: ReadonlySet<number> }[];
}

/**
 * Validate a five-field UTC cron expression. Throws InvalidCronError on invalid syntax.
 */
export function validateCronExpr(expr: string): ParsedCron {
  if (typeof expr !== "string" || expr.trim() === "") {
    throw new InvalidCronError("cron expression must be a non-empty string");
  }

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new InvalidCronError(
      `cron expression must have exactly 5 fields (minute hour dom month dow); got ${parts.length}: ${JSON.stringify(expr)}`,
    );
  }

  const fields = parts.map((part, i) => {
    const spec = FIELDS[i];
    if (!spec) {
      throw new InvalidCronError(`internal error: missing field spec at index ${i}`);
    }
    return parseField(part, spec);
  });
  return { expr, fields };
}

/**
 * Check if a validated cron expression matches a given UTC date/time.
 */
export function cronMatches(expr: string | ParsedCron, utcDate: Date): boolean {
  const parsed = typeof expr === "string" ? validateCronExpr(expr) : expr;

  const minute = utcDate.getUTCMinutes();
  const hour = utcDate.getUTCHours();
  const dom = utcDate.getUTCDate();
  const month = utcDate.getUTCMonth() + 1; // 1-12
  const dow = utcDate.getUTCDay(); // 0-6 (0 = Sun)

  const [minField, hourField, domField, monthField, dowField] = parsed.fields;
  if (!minField || !hourField || !domField || !monthField || !dowField) return false;

  if (!minField.values.has(minute)) return false;
  if (!hourField.values.has(hour)) return false;
  if (!monthField.values.has(month)) return false;

  // Vixie cron day matching: if neither DOM nor DOW is wildcard, either match satisfies.
  if (!domField.isWildcard && !dowField.isWildcard) {
    return domField.values.has(dom) || dowField.values.has(dow);
  }

  if (!domField.values.has(dom)) return false;
  if (!dowField.values.has(dow)) return false;

  return true;
}

/**
 * Format a Date to an ISO-8601 string truncated to minute precision: YYYY-MM-DDTHH:mm:00.000Z.
 */
export function formatMinuteAnchor(utcDate: Date): string {
  const y = utcDate.getUTCFullYear();
  const m = String(utcDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utcDate.getUTCDate()).padStart(2, "0");
  const h = String(utcDate.getUTCHours()).padStart(2, "0");
  const min = String(utcDate.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}:${min}:00.000Z`;
}

/**
 * Check if two ISO timestamps fall within the same UTC minute.
 */
export function isSameUtcMinute(isoA: string, isoB: string): boolean {
  const a = new Date(isoA);
  const b = new Date(isoB);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate() &&
    a.getUTCHours() === b.getUTCHours() &&
    a.getUTCMinutes() === b.getUTCMinutes()
  );
}

/**
 * Compute the next fire UTC date after `fromUtc` (minute granularity, searching up to maxMinutes ahead).
 */
export function computeNextFireUtc(expr: string | ParsedCron, fromUtc: Date, maxMinutes = 525600): Date | undefined {
  const parsed = typeof expr === "string" ? validateCronExpr(expr) : expr;
  // Start at next minute boundary
  const t = new Date(
    Date.UTC(
      fromUtc.getUTCFullYear(),
      fromUtc.getUTCMonth(),
      fromUtc.getUTCDate(),
      fromUtc.getUTCHours(),
      fromUtc.getUTCMinutes() + 1,
      0,
      0,
    ),
  );

  for (let i = 0; i < maxMinutes; i++) {
    if (cronMatches(parsed, t)) {
      return new Date(t.getTime());
    }
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  return undefined;
}
