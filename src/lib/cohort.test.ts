import { describe, expect, it } from "vitest";
import { cohortWeekStart, cohortWeekStartFromUnixSeconds } from "./cohort";

describe("cohortWeekStart", () => {
  it("returns the same date when given a Monday", () => {
    // 2026-09-07 is a Monday.
    expect(cohortWeekStart(new Date("2026-09-07T15:30:00Z"))).toBe(
      "2026-09-07",
    );
  });

  it("rolls a Sunday back to the previous Monday", () => {
    // 2026-09-13 is a Sunday; the ISO week it belongs to starts 2026-09-07.
    expect(cohortWeekStart(new Date("2026-09-13T23:59:59Z"))).toBe(
      "2026-09-07",
    );
  });

  it("rolls a Saturday back to that week's Monday", () => {
    // 2026-09-12 is a Saturday.
    expect(cohortWeekStart(new Date("2026-09-12T00:00:00Z"))).toBe(
      "2026-09-07",
    );
  });

  it("is stable across a month boundary", () => {
    // 2026-10-01 is a Thursday; that week starts 2026-09-28.
    expect(cohortWeekStart(new Date("2026-10-01T12:00:00Z"))).toBe(
      "2026-09-28",
    );
  });

  it("is stable across a year boundary", () => {
    // 2027-01-01 is a Friday; that week starts 2026-12-28.
    expect(cohortWeekStart(new Date("2027-01-01T00:00:00Z"))).toBe(
      "2026-12-28",
    );
  });

  it("ignores time-of-day and only depends on the UTC calendar date", () => {
    const early = cohortWeekStart(new Date("2026-09-09T00:00:01Z"));
    const late = cohortWeekStart(new Date("2026-09-09T23:59:59Z"));
    expect(early).toBe(late);
  });

  it("throws on an invalid date", () => {
    expect(() => cohortWeekStart(new Date("not-a-date"))).toThrow();
  });
});

describe("cohortWeekStartFromUnixSeconds", () => {
  it("matches cohortWeekStart for the equivalent Date", () => {
    const unixSeconds = 1_788_000_000; // arbitrary fixed instant
    const expected = cohortWeekStart(new Date(unixSeconds * 1_000));
    expect(cohortWeekStartFromUnixSeconds(unixSeconds)).toBe(expected);
  });
});
