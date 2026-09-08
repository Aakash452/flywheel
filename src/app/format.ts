/** Shared display formatters for the dashboard — pulled out of page.tsx so charts.tsx can use them too without a circular import. */

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/** Same as formatCents but keeps cents precision — for small per-subscriber figures where rounding to whole dollars hides the number entirely. */
export function formatCentsPrecise(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export function formatRunway(days: number): string {
  if (!Number.isFinite(days)) return "∞ (profitable or break-even)";
  return `${Math.floor(days)} days`;
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}
