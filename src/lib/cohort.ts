/**
 * Cohort-week bucketing. A subscriber's cohort_week (see schema) is the
 * Monday of the ISO week they were acquired in, as a plain YYYY-MM-DD
 * string.
 *
 * Computed in UTC deliberately, not local time: acquisition timestamps
 * arrive from Beehiiv (Unix seconds) and, later, Meta — neither is in the
 * operator's timezone, and cohort boundaries need to be stable regardless
 * of what timezone a given server or person happens to be in.
 */
export function cohortWeekStart(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error(`cohortWeekStart received an invalid Date: ${date}`);
  }

  const utcMidnight = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = utcMidnight.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() + diffToMonday);

  const iso = utcMidnight.toISOString();
  const datePart = iso.slice(0, 10);
  if (!datePart) {
    throw new Error(`cohortWeekStart failed to format ${date.toISOString()}`);
  }
  return datePart;
}

/** Convenience for Beehiiv/Meta timestamps, which arrive as Unix seconds. */
export function cohortWeekStartFromUnixSeconds(unixSeconds: number): string {
  return cohortWeekStart(new Date(unixSeconds * 1_000));
}
