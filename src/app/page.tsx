/**
 * The one page that matters (for now). Per the build spec, the full
 * dashboard — flywheel gauge, cohort retention, creative leaderboard,
 * active experiments — lands with the Allocator in step 8, once creatives
 * and subscribers exist to show. This page ships what's real today:
 * balance/runway (the ledger has existed since step 1) and the draft
 * approval queue (this step's actual deliverable). No settings page, no
 * user management, no dark mode — all explicitly out of scope.
 */
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { issues } from "../db/schema";
import { getBalanceCents, getRunwayDays } from "../db/queries/ledger";
import { isRunwayCritical } from "../lib/ledger-math";
import { renderIssueHtml } from "../lib/markdown";
import {
  approveDraftAction,
  generateDraftAction,
  sendIssueNowAction,
} from "./actions";

// This page reads live DB state on every request — never statically cache it.
export const dynamic = "force-dynamic";

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatRunway(days: number): string {
  if (!Number.isFinite(days)) return "∞ (profitable or break-even)";
  return `${Math.floor(days)} days`;
}

export default async function DashboardPage() {
  const [balanceCents, runwayDays, draftIssues, approvedIssues] = await Promise.all([
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
  ]);

  const runwayCritical = isRunwayCritical(runwayDays);

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
    </main>
  );
}
