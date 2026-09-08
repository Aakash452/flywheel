/**
 * Server-rendered SVG charts for the dashboard. No client JS: page.tsx has
 * been a pure server component since step 4 and this doesn't introduce
 * the first "use client" boundary just for charts — hover affordance comes
 * from native <title> tooltips instead of a custom crosshair layer. That's
 * a deliberate, documented trade against the dataviz skill's default
 * interaction layer, made for a single-operator internal tool with no
 * existing client-side runtime, not an oversight.
 *
 * Palette: light-mode-only categorical slots from the dataviz skill's
 * reference palette (validated via scripts/validate_palette.js — see the
 * build transcript), assigned in fixed order and never reused for a
 * different meaning across charts. This app has no dark mode by design
 * (see globals.css) so only the light steps are needed.
 */
import type { RetentionCurvePoint } from "../lib/cohort-economics";
import { formatCentsPrecise } from "./format";

const CHART_SURFACE = "#fcfcfb";
const INK_PRIMARY = "#0b0b0b";
const INK_SECONDARY = "#52514e";
const INK_MUTED = "#898781";
const GRIDLINE = "#e1e0d9";
const AXIS = "#c3c2b7";

// Categorical slots, fixed order — see dataviz skill references/palette.md.
const SLOT_BLUE = "#2a78d6";
const SLOT_ORANGE = "#eb6834";
const SLOT_AQUA = "#1baf7a";
const SLOT_YELLOW = "#eda100";
const COHORT_COLORS = [SLOT_BLUE, SLOT_ORANGE, SLOT_AQUA, SLOT_YELLOW];

/** Two-bar comparison: blended CAC vs blended RPS/month. The "gauge" the spec asks for — is the flywheel spinning (RPS > CAC payback-wise) or not. */
export function CacRpsGauge({
  cacCents,
  rpsCentsPerMonth,
}: {
  cacCents: number | null;
  rpsCentsPerMonth: number | null;
}) {
  const width = 480;
  const height = 140;
  const barHeight = 32;
  const gap = 28;
  const labelWidth = 90;
  const plotWidth = width - labelWidth - 60;

  const values = [cacCents ?? 0, rpsCentsPerMonth ?? 0];
  const max = Math.max(...values, 1);

  const bars = [
    { label: "Blended CAC", value: cacCents, color: SLOT_BLUE, y: 24 },
    { label: "RPS / month", value: rpsCentsPerMonth, color: SLOT_ORANGE, y: 24 + barHeight + gap },
  ];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Blended CAC ${cacCents !== null ? formatCentsPrecise(cacCents) : "unavailable"} versus RPS per month ${rpsCentsPerMonth !== null ? formatCentsPrecise(rpsCentsPerMonth) : "unavailable"}`}
      style={{ width: "100%", height: "auto", background: CHART_SURFACE }}
    >
      {bars.map((bar) => {
        const w = bar.value === null ? 0 : Math.max((bar.value / max) * plotWidth, bar.value > 0 ? 4 : 0);
        return (
          <g key={bar.label}>
            <text x={0} y={bar.y + barHeight / 2 + 4} fontSize="12" fill={INK_SECONDARY}>
              {bar.label}
            </text>
            <rect
              x={labelWidth}
              y={bar.y}
              width={plotWidth}
              height={barHeight}
              fill="none"
              stroke={GRIDLINE}
              strokeWidth={1}
            />
            {bar.value !== null && (
              <rect x={labelWidth} y={bar.y} width={w} height={barHeight} rx={4} fill={bar.color}>
                <title>{`${bar.label}: ${formatCentsPrecise(bar.value)}`}</title>
              </rect>
            )}
            <text
              x={labelWidth + plotWidth + 8}
              y={bar.y + barHeight / 2 + 4}
              fontSize="13"
              fontWeight={600}
              fill={INK_PRIMARY}
            >
              {bar.value === null ? "—" : formatCentsPrecise(bar.value)}
            </text>
          </g>
        );
      })}
      <line x1={labelWidth} y1={12} x2={labelWidth} y2={height - 12} stroke={AXIS} strokeWidth={1} />
    </svg>
  );
}

export interface RetentionSeries {
  cohortWeek: string;
  cohortSize: number;
  curve: RetentionCurvePoint[];
}

/**
 * Line chart of surviving-fraction retention curves, capped to at most 4
 * cohorts (categorical slots 1-4) so each line stays direct-labeled per
 * the dataviz skill's "<=4 series: legend AND direct labels" rule. The
 * full cohort list still renders as a table alongside this — callers
 * should include it, not rely on the chart alone.
 */
export function RetentionCurveChart({ series }: { series: RetentionSeries[] }) {
  const width = 640;
  const height = 260;
  const marginLeft = 40;
  const marginRight = 90;
  const marginTop = 16;
  const marginBottom = 30;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  // Every cohort starts at 100% retention by definition (week 0) — that
  // point isn't in computeRetentionCurve's output (it starts at
  // weekOffset 1, the first fully-elapsed week), but prepending it here
  // isn't fabricating data, just stating the trivially-true starting
  // condition so each line has a visible anchor.
  const withStart = series.map((s) => ({
    ...s,
    curve: [{ weekOffset: 0, survivingFraction: 1 }, ...s.curve],
  }));

  const maxWeeks = Math.max(1, ...withStart.map((s) => s.curve.at(-1)?.weekOffset ?? 0));
  const x = (weekOffset: number) => marginLeft + (weekOffset / maxWeeks) * plotWidth;
  const y = (fraction: number) => marginTop + (1 - fraction) * plotHeight;

  const yTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div>
      <ul className="chart-legend">
        {withStart.map((s, i) => (
          <li key={s.cohortWeek}>
            <span
              className="swatch"
              style={{ background: COHORT_COLORS[i % COHORT_COLORS.length] }}
            />
            Cohort {s.cohortWeek} (n={s.cohortSize})
          </li>
        ))}
      </ul>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Cohort retention curves, surviving subscriber fraction by week since signup"
        style={{ width: "100%", height: "auto", background: CHART_SURFACE }}
      >
      {yTicks.map((t) => (
        <g key={t}>
          <line
            x1={marginLeft}
            x2={width - marginRight}
            y1={y(t)}
            y2={y(t)}
            stroke={GRIDLINE}
            strokeWidth={1}
          />
          <text x={marginLeft - 8} y={y(t) + 4} fontSize="10" fill={INK_MUTED} textAnchor="end">
            {Math.round(t * 100)}%
          </text>
        </g>
      ))}
      <line
        x1={marginLeft}
        x2={width - marginRight}
        y1={marginTop + plotHeight}
        y2={marginTop + plotHeight}
        stroke={AXIS}
        strokeWidth={1}
      />
      <text x={marginLeft} y={height - 4} fontSize="10" fill={INK_MUTED}>
        week 0
      </text>
      <text x={width - marginRight} y={height - 4} fontSize="10" fill={INK_MUTED} textAnchor="end">
        week {maxWeeks}
      </text>

      {withStart.map((s, i) => {
        const color = COHORT_COLORS[i % COHORT_COLORS.length];
        const points = s.curve.map((p) => `${x(p.weekOffset)},${y(p.survivingFraction)}`).join(" ");
        const last = s.curve.at(-1);
        return (
          <g key={s.cohortWeek}>
            <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round">
              <title>{`Cohort ${s.cohortWeek} (n=${s.cohortSize})`}</title>
            </polyline>
            {last && (
              <>
                <circle cx={x(last.weekOffset)} cy={y(last.survivingFraction)} r={3} fill={color}>
                  <title>{`Cohort ${s.cohortWeek} (n=${s.cohortSize})`}</title>
                </circle>
                {/* A cohort that's only a week or two old ends its line
                    right where every other cohort's line also starts —
                    labeling it there just piles text on top of the
                    legend's dots. The legend above already names every
                    series by color, so skip the redundant, cluttered
                    label for a line ending in the chart's first 15%. */}
                {x(last.weekOffset) - marginLeft > plotWidth * 0.3 && (
                  <text x={x(last.weekOffset) + 6} y={y(last.survivingFraction) + 4} fontSize="10" fill={color}>
                    {s.cohortWeek}
                  </text>
                )}
              </>
            )}
          </g>
        );
      })}
      </svg>
    </div>
  );
}

export interface CpaLeaderboardRow {
  id: string;
  label: string;
  cpaCents: number;
}

/** Horizontal bar chart, ascending by CPA (cheapest acquisition first) — sequential single-hue magnitude encoding, one series so no legend needed. */
export function CpaLeaderboardChart({ rows }: { rows: CpaLeaderboardRow[] }) {
  if (rows.length === 0) return null;
  const width = 640;
  const rowHeight = 28;
  const labelWidth = 200;
  const marginRight = 70;
  const plotWidth = width - labelWidth - marginRight;
  const height = rows.length * rowHeight + 12;
  const max = Math.max(...rows.map((r) => r.cpaCents), 1);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Creative leaderboard by cost per acquisition, cheapest first"
      style={{ width: "100%", height: "auto", background: CHART_SURFACE }}
    >
      {rows.map((row, i) => {
        const y = i * rowHeight + 6;
        const w = Math.max((row.cpaCents / max) * plotWidth, 4);
        return (
          <g key={row.id}>
            <text x={0} y={y + rowHeight / 2 - 2} fontSize="11" fill={INK_SECONDARY}>
              {row.label.length > 28 ? `${row.label.slice(0, 27)}…` : row.label}
            </text>
            <rect x={labelWidth} y={y} width={w} height={rowHeight - 10} rx={4} fill={SLOT_BLUE}>
              <title>{`${row.label}: ${formatCentsPrecise(row.cpaCents)} CPA`}</title>
            </rect>
            <text x={labelWidth + w + 6} y={y + rowHeight / 2 - 2} fontSize="11" fill={INK_PRIMARY}>
              {formatCentsPrecise(row.cpaCents)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
