/**
 * The dashboard. Ledger/draft-approval sections have existed since step 4;
 * the flywheel gauge, cohort retention, creative leaderboard, active
 * experiments, and attribution sections land here with steps 5-8. No
 * settings page, no user management, no dark mode — all explicitly out of
 * scope (see globals.css).
 */
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { creatives, experiments, experimentTypeEnum, issues } from "../db/schema";
import { getBalanceCents, getRunwayDays } from "../db/queries/ledger";
import { isRunwayCritical } from "../lib/ledger-math";
import { renderIssueHtml } from "../lib/markdown";
import { computeAllocatorSummary } from "../services/allocator";
import { getAttributionSummary } from "../services/attribution/reconcile";
import {
  approveDraftAction,
  activateCreativeAction,
  createExperimentAction,
  generateCreativesAction,
  generateDraftAction,
  increaseBudgetAction,
  pushToMetaAction,
  sendIssueNowAction,
} from "./actions";
import { CacRpsGauge, CpaLeaderboardChart, RetentionCurveChart, type CpaLeaderboardRow, type RetentionSeries } from "./charts";
import { formatCents, formatCentsPrecise, formatPercent, formatRunway } from "./format";

// This page reads live DB state on every request — never statically cache it.
export const dynamic = "force-dynamic";

const RECOMMENDATION_BADGE_CLASS: Record<string, string> = {
  scale_up_20: "scale-up",
  hold: "hold",
  cut_50_and_new_experiment: "cut",
  halt_all_spend: "critical",
};

const RECOMMENDATION_LABEL: Record<string, string> = {
  scale_up_20: "Scale +20%",
  hold: "Hold",
  cut_50_and_new_experiment: "Cut 50%",
  halt_all_spend: "Halt spend",
};

export default async function DashboardPage() {
  const [
    balanceCents,
    runwayDays,
    draftIssues,
    approvedIssues,
    allocatorSummary,
    attributionSummary,
    activeExperiments,
    allCreatives,
  ] = await Promise.all([
    getBalanceCents(db),
    getRunwayDays(db),
    db
      .select()
      .from(issues)
      .where(eq(issues.status, "draft"))
      .orderBy(desc(issues.createdAt)),
    db
      .select()
      .from(issues)
      .where(eq(issues.status, "approved"))
      .orderBy(desc(issues.updatedAt)),
    computeAllocatorSummary(db),
    getAttributionSummary(db),
    db
      .select()
      .from(experiments)
      .where(eq(experiments.status, "active"))
      .orderBy(desc(experiments.createdAt)),
    db.select().from(creatives).orderBy(desc(creatives.createdAt)),
  ]);

  const runwayCritical = isRunwayCritical(runwayDays);

  const creativesByExperiment = new Map<string, typeof allCreatives>();
  for (const c of allCreatives) {
    const list = creativesByExperiment.get(c.experimentId) ?? [];
    list.push(c);
    creativesByExperiment.set(c.experimentId, list);
  }

  const retentionSeries: RetentionSeries[] = allocatorSummary.cohorts
    .filter((c) => c.retentionCurve.length > 0)
    .slice()
    .sort((a, b) => b.cohortWeek.localeCompare(a.cohortWeek))
    .slice(0, 4)
    .map((c) => ({ cohortWeek: c.cohortWeek, cohortSize: c.cohortSize, curve: c.retentionCurve }));

  const cpaRows: CpaLeaderboardRow[] = allCreatives
    .filter((c) => c.signups > 0 && c.spendCents > 0)
    .map((c) => ({ id: c.id, label: c.hook, cpaCents: Math.round(c.spendCents / c.signups) }))
    .sort((a, b) => a.cpaCents - b.cpaCents)
    .slice(0, 10);

  const activatableCreatives = allCreatives.filter(
    (c) => c.status === "paused" && c.platformCreativeId !== null,
  );

  const discrepantCreatives = attributionSummary.perCreative.filter((r) => r.discrepancy !== 0);

  return (
    <main>
      <h1>Flywheel</h1>

      <section aria-label="Cash position">
        <div className="stat-strip">
          <div className="stat">
            <span className="label">Balance</span>
            <span className="value">{formatCents(balanceCents)}</span>
          </div>
          <div className={`stat${runwayCritical ? " critical" : ""}`}>
            <span className="label">Runway (30d trailing burn)</span>
            <span className="value">{formatRunway(runwayDays)}</span>
          </div>
        </div>
        {runwayCritical && (
          <p className="warning">
            Runway is at or below the 21-day halt threshold. The Allocator
            (step 8) will enforce a spend halt automatically once it exists
            — for now, this is a manual signal to stop or cut ad spend.
          </p>
        )}
      </section>

      <section aria-label="Draft approval queue">
        <h2>Draft approval queue</h2>
        <form action={generateDraftAction} className="generate-form">
          <button type="submit">Generate draft</button>
        </form>

        {draftIssues.length === 0 && (
          <p className="empty">No drafts waiting for review.</p>
        )}

        {draftIssues.map((issue) => (
          <article className="card" key={issue.id}>
            <h3>{issue.subjectLine}</h3>
            {issue.subjectLineCandidates && issue.subjectLineCandidates.length > 1 && (
              <details className="candidates">
                <summary>
                  {issue.subjectLineCandidates.length} subject lines considered
                </summary>
                <ul>
                  {issue.subjectLineCandidates
                    .slice()
                    .sort((a, b) => b.score - a.score)
                    .map((c) => (
                      <li key={c.subjectLine}>
                        <strong>{c.score}</strong> — {c.subjectLine}
                        {c.reasoning ? ` (${c.reasoning})` : ""}
                      </li>
                    ))}
                </ul>
              </details>
            )}
            <div
              className="body-preview"
              // Rendering our own Claude-generated Markdown for operator
              // review — the same render sendIssue() uses at send time, so
              // approval reviews what will actually go out, not raw source.
              dangerouslySetInnerHTML={{ __html: renderIssueHtml(issue.bodyMd) }}
            />
            <div className="actions">
              <form action={approveDraftAction}>
                <input type="hidden" name="issueId" value={issue.id} />
                <button type="submit">Approve</button>
              </form>
            </div>
          </article>
        ))}
      </section>

      <section aria-label="Approved, awaiting send">
        <h2>Approved — awaiting send</h2>
        {approvedIssues.length === 0 && (
          <p className="empty">Nothing approved yet.</p>
        )}
        {approvedIssues.map((issue) => (
          <article className="card" key={issue.id}>
            <h3>{issue.subjectLine}</h3>
            <p className="meta">Approved {issue.updatedAt.toISOString()}</p>
            <div className="actions">
              <form action={sendIssueNowAction}>
                <input type="hidden" name="issueId" value={issue.id} />
                <button type="submit">Send now</button>
              </form>
            </div>
          </article>
        ))}
      </section>

      <section aria-label="Flywheel economics">
        <h2>Flywheel economics (30d trailing, blended)</h2>
        <div className="stat-strip">
          <div className="stat">
            <span className="label">Blended CAC</span>
            <span className="value">
              {allocatorSummary.blended.cacCents !== null
                ? formatCentsPrecise(allocatorSummary.blended.cacCents)
                : "—"}
            </span>
          </div>
          <div className="stat">
            <span className="label">RPS / month</span>
            <span className="value">
              {allocatorSummary.blended.rpsCentsPerMonth !== null
                ? formatCentsPrecise(allocatorSummary.blended.rpsCentsPerMonth)
                : "—"}
            </span>
          </div>
          <div className="stat">
            <span className="label">Contribution margin / mo</span>
            <span className="value">
              {allocatorSummary.blended.contributionMarginCentsPerMonth !== null
                ? formatCentsPrecise(allocatorSummary.blended.contributionMarginCentsPerMonth)
                : "—"}
            </span>
          </div>
          <div className="stat">
            <span className="label">Payback</span>
            <span className="value">
              {allocatorSummary.blended.paybackDays !== null
                ? `${allocatorSummary.blended.paybackDays.toFixed(0)}d`
                : "never"}
            </span>
          </div>
        </div>
        <div className="chart-wrap">
          <CacRpsGauge
            cacCents={allocatorSummary.blended.cacCents}
            rpsCentsPerMonth={allocatorSummary.blended.rpsCentsPerMonth}
          />
        </div>
      </section>

      <section aria-label="Cohort retention">
        <h2>Cohort retention</h2>
        {retentionSeries.length > 0 ? (
          <div className="chart-wrap">
            <RetentionCurveChart series={retentionSeries} />
          </div>
        ) : (
          <p className="empty">No cohort has an elapsed week yet.</p>
        )}
        {allocatorSummary.cohorts.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cohort week</th>
                  <th className="num">Size</th>
                  <th className="num">LTV</th>
                  <th className="num">LTV/CAC</th>
                  <th>Allocator recommendation</th>
                </tr>
              </thead>
              <tbody>
                {allocatorSummary.cohorts
                  .slice()
                  .sort((a, b) => b.cohortWeek.localeCompare(a.cohortWeek))
                  .map((c) => (
                    <tr key={c.cohortWeek}>
                      <td>{c.cohortWeek}</td>
                      <td className="num">{c.cohortSize}</td>
                      <td className="num">{formatCentsPrecise(c.ltvCents)}</td>
                      <td className="num">{c.ltvToCacRatio !== null ? c.ltvToCacRatio.toFixed(2) : "—"}</td>
                      <td>
                        <span
                          className={`badge ${RECOMMENDATION_BADGE_CLASS[c.recommendation.action]}`}
                          title={c.recommendation.reasoning}
                        >
                          {RECOMMENDATION_LABEL[c.recommendation.action]}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-label="Active experiments">
        <h2>Active experiments</h2>
        <form action={createExperimentAction} className="inline-form">
          <label>
            Hypothesis
            <input type="text" name="hypothesis" required size={30} />
          </label>
          <label>
            Type
            <select name="type" required defaultValue={experimentTypeEnum.enumValues[0]}>
              {experimentTypeEnum.enumValues.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            Budget ($)
            <input type="number" name="budgetDollars" min={1} step={1} required />
          </label>
          <label>
            Deadline
            <input type="date" name="deadline" required />
          </label>
          <label>
            Target CPA ($, optional)
            <input type="number" name="targetCpaDollars" min={0} step={0.01} />
          </label>
          <button type="submit">Create experiment</button>
        </form>

        {activeExperiments.length === 0 && <p className="empty">No active experiments.</p>}
        {activeExperiments.map((exp) => {
          const expCreatives = creativesByExperiment.get(exp.id) ?? [];
          const activeCount = expCreatives.filter((c) => c.status === "active").length;
          const pausedPushable = expCreatives.filter(
            (c) => c.status === "paused" && c.platformCreativeId === null,
          ).length;
          return (
            <article className="card" key={exp.id}>
              <h3>{exp.hypothesis}</h3>
              <p className="meta">
                {exp.type} · budget {formatCents(exp.budgetCents)} · spent {formatCents(exp.spentCents)} ·
                deadline {exp.deadline.toISOString().slice(0, 10)}
                {exp.targetCpaCents !== null ? ` · target CPA ${formatCentsPrecise(exp.targetCpaCents)}` : ""}
              </p>
              <p className="meta">
                {expCreatives.length} creative(s) — {activeCount} active, {pausedPushable} paused not yet pushed
              </p>
              <form action={generateCreativesAction} className="inline-form">
                <input type="hidden" name="experimentId" value={exp.id} />
                <label>
                  Offer
                  <input type="text" name="offer" required placeholder="e.g. free weekly newsletter" size={28} />
                </label>
                <button type="submit">Generate creatives</button>
              </form>
              <div className="actions">
                <form action={pushToMetaAction}>
                  <input type="hidden" name="experimentId" value={exp.id} />
                  <button type="submit" className="secondary">
                    Push paused creatives to Meta
                  </button>
                </form>
                <form action={increaseBudgetAction}>
                  <input type="hidden" name="experimentId" value={exp.id} />
                  <button type="submit" className="secondary">
                    Increase budget +20%
                  </button>
                </form>
              </div>
            </article>
          );
        })}
      </section>

      <section aria-label="Creative leaderboard">
        <h2>Creative leaderboard (lowest CPA first)</h2>
        {cpaRows.length > 0 ? (
          <div className="chart-wrap">
            <CpaLeaderboardChart rows={cpaRows} />
          </div>
        ) : (
          <p className="empty">No creatives with confirmed signups yet.</p>
        )}

        <h3>Ready to activate</h3>
        {activatableCreatives.length === 0 && (
          <p className="empty">Nothing paused and pushed to Meta right now.</p>
        )}
        {activatableCreatives.map((c) => (
          <article className="card" key={c.id}>
            <h3>{c.hook}</h3>
            <p className="meta">
              {c.angle} · {c.format} · {c.audienceFraming} · {c.impressions} impr · {c.clicks} clicks ·{" "}
              {c.signups} signups · {formatCents(c.spendCents)} spent
            </p>
            <div className="actions">
              <form action={activateCreativeAction}>
                <input type="hidden" name="creativeId" value={c.id} />
                <button type="submit">Activate</button>
              </form>
            </div>
          </article>
        ))}
      </section>

      <section aria-label="Attribution">
        <h2>Attribution</h2>
        <div className="stat-strip">
          <div className="stat">
            <span className="label">Total subscribers</span>
            <span className="value">{attributionSummary.totalSubscribers}</span>
          </div>
          <div className="stat">
            <span className="label">Attributed</span>
            <span className="value">{attributionSummary.attributedSubscribers}</span>
          </div>
          <div className="stat">
            <span className="label">Attribution rate</span>
            <span className="value">
              {attributionSummary.attributionRatePercent !== null
                ? formatPercent(attributionSummary.attributionRatePercent / 100)
                : "—"}
            </span>
          </div>
        </div>
        {discrepantCreatives.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <h3>Creatives with a Meta/Beehiiv signup discrepancy</h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Creative</th>
                  <th className="num">Meta signups</th>
                  <th className="num">Confirmed subscribers</th>
                  <th className="num">Discrepancy</th>
                </tr>
              </thead>
              <tbody>
                {discrepantCreatives.map((r) => (
                  <tr key={r.creativeId}>
                    <td>{r.creativeId.slice(0, 8)}</td>
                    <td className="num">{r.metaReportedSignups}</td>
                    <td className="num">{r.confirmedSubscribers}</td>
                    <td className="num">{r.discrepancy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
