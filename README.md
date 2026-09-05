# Flywheel

The intelligence layer for a paid-acquisition newsletter business: find and
exploit a repeatable loop where $1 of ad spend produces more than $1 of
gross profit within 30 days, then reinvest automatically.

This is not an email service provider — Beehiiv handles sending, subscriber
management, referrals, and the sponsorship marketplace. Flywheel is the
brain on top of it: sourcing, drafting, creative testing, attribution,
budget-killing, and allocation, all measured against one number —
contribution margin per subscriber per month, minus blended CAC.

## Status

**Build order steps 1–4 are done:** schema + migrations + ledger queries;
the Beehiiv integration (subscriber sync with attribution, send with a
verified approval gate, stats polling); the sourcing pipeline (RSS + Reddit
+ HN → dedup → batched relevance scoring → persist above threshold); and
the draft generator + approval-queue dashboard. Most of it has been run
end-to-end against a real Postgres 17 + pgvector and real Redis, the
HN/RSS connectors have been run against the real live services, and the
dashboard has been built and rendered against real seeded data — not just
unit-tested against mocks. See "What's been verified live," below, for
exactly what has and hasn't been exercised against real infrastructure.

Per the build spec: **ship 1–4, then run the newsletter manually for a few
weeks before building the acquisition machinery.** Steps 5–8 (creative
engine, attribution reconciliation, Reaper, Allocator, the rest of the
dashboard) are not started, and per the spec shouldn't be until that
manual-operation period has actually happened.

## Getting started

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL, ANTHROPIC_API_KEY, etc.
docker compose up -d        # local Postgres (with pgvector) + Redis
npm run db:migrate          # creates the vector extension, then applies drizzle/*.sql
npm test                    # full suite: pure-function unit tests + DB integration tests
npm run worker              # starts the BullMQ worker
npm run dev                 # starts the dashboard at http://localhost:3000
```

Before sourcing or drafting produce anything: fill in `src/config/niche.ts`
(what this newsletter covers, its audience, topics), `src/config/voice.ts`
(how it's written), and `src/config/sourcing.ts` (real RSS feeds,
subreddits). All three ship as placeholders — see the comments in each.

`npm run db:generate` regenerates migrations from [src/db/schema.ts](src/db/schema.ts) after a
schema edit — run `git diff drizzle/` afterward to review what it produced
before committing.

`npm test` needs `DATABASE_URL` pointing at a real Postgres to exercise the
DB-backed suites; without it, those suites skip themselves cleanly rather
than failing (see "Testing," below). The pure-function suites always run.

**No Docker in this environment**, so the local setup above was actually
verified via Homebrew instead: `brew install postgresql@17 pgvector redis`.
One gotcha worth knowing if you hit it too: Homebrew's `pgvector` bottle
only ships built against `postgresql@17`/`@18`, not `@16` — if you're on
`postgresql@16`, either switch to `@17`, or copy
`$(brew --prefix pgvector)/lib/postgresql@17/vector.dylib` and the matching
`share/postgresql@17/extension/vector*` files into your Postgres's own
`lib/postgresql/` and `share/postgresql/extension/` directories. `docker
compose up -d` sidesteps this entirely (the `pgvector/pgvector:pg16` image
already has it built in) and is what's documented above as the normal path.

**The dashboard has no login of its own.** There's no user-management
system in scope (explicitly excluded by the spec), so `npm run dev` /
`npm run start` should sit behind network-level access control — bind to
localhost, put it behind a VPN, or front it with an auth proxy — not be
exposed directly. `OPERATOR_EMAIL` in `.env` just labels who approved what
in the `approvals` table; it isn't a credential.

## Layout

```
src/
  config/
    niche.ts                   # PLACEHOLDER — this newsletter's niche; sourcing scores against it
    voice.ts                     # PLACEHOLDER — how this newsletter is written; drafting conditions on it
    sourcing.ts                    # PLACEHOLDER — RSS feeds, subreddits, HN settings
    drafting.ts                      # source count / few-shot count / subject-line-candidate count
    pricing.ts                        # per-token cost table backing every ledger api_cost entry
  db/
    schema.ts             # Drizzle schema — the source of truth for the data model
    client.ts              # Postgres pool + Drizzle instance; Database/Transaction/DbClient types
    migrate.ts              # migration runner (bootstraps the vector extension)
    testing.ts               # test-only: withRollback() transaction isolation, isDatabaseAvailable()
    queries/
      ledger.ts             # balance / burn-rate / runway, backed by the pure math below
  lib/
    ledger-math.ts          # pure balance/burn/runway functions + unit tests
    metrics.ts               # pure CPC/CPA/CTR/conversion/open-rate functions + unit tests
    cohort.ts                 # pure cohort-week bucketing (UTC ISO-week Monday) + unit tests
    markdown.ts                # renders issues.body_md to HTML (Beehiiv send, dashboard preview)
    vectors.ts                   # pure cosine similarity — sourcing dedup today, Creative Engine later
  integrations/
    beehiiv/
      client.ts              # typed Beehiiv v2 API client (subscriptions, posts) + retry/backoff
      types.ts                 # zod schemas for the Beehiiv responses this client parses
    embeddings/
      voyage-client.ts          # embedding provider (semantic dedup + later Creative Engine diversity)
  services/
    approvals.ts              # the structural human-gate: record/require an approval before acting
    cost-control.ts             # every LLM/embedding call's estimated cost -> ledger; daily spend cap
    beehiiv/
      sync-subscribers.ts     # pulls Beehiiv subscriptions, attributes via utm_content → creative
      send-issue.ts            # approveIssue() + sendIssue() — the only call site for a real send
      poll-issue-stats.ts       # refreshes opens/clicks/recipients for recently-sent issues
    sourcing/
      connectors/                # rss.ts, reddit.ts, hackernews.ts, index.ts (combines all three)
      dedupe.ts                   # URL dedup + pgvector semantic dedup (last 30 days, >0.9 cosine)
      relevance-scoring.ts          # pure prompt-building + response-parsing; RelevanceScorer interface
      anthropic-relevance-scorer.ts   # Claude Batch API-backed scorer (Haiku 4.5 — see cost comment)
      factory.ts                       # wires the real deps (Anthropic client, Voyage, connectors) from env
      index.ts                          # orchestrates: fetch → dedup → score → persist above threshold
    drafting/
      ranking.ts                 # picks few-shot issues (by open rate) and source material (by relevance)
      prompt.ts                    # pure prompt-building + response-parsing; DraftGenerator interface
      anthropic-draft-generator.ts   # Claude Messages API-backed generator (Sonnet 4.6, direct call)
      factory.ts                      # wires the real deps from env
      index.ts                         # orchestrates: rank → generate → log cost → insert draft
  queue/
    connection.ts              # shared ioredis connection for BullMQ
    queues.ts                   # queue definitions, cron schedule, enqueueSendIssue(), enqueueDraftGeneration()
    worker.ts                    # process entrypoint — `npm run worker`
  app/
    layout.tsx                  # root layout — no theming system, no dark mode
    page.tsx                      # the one page: balance/runway strip + draft approval queue
    actions.ts                     # server actions: generate draft, approve draft, send now
    globals.css                     # minimal styling, light-mode only
drizzle/
  0000_*.sql                     # generated table/enum/index/FK migration
  0001_append_only_triggers.sql  # hand-written: makes ledger + subscriber_events append-only
  0002_*.sql                     # issues.beehiiv_post_id
  0003_*.sql                     # approvals.sequence (monotonic tiebreaker — see below)
  0004_*.sql                     # sources.embedding
  0005_*.sql                     # issues.recipients, issues.subject_line_candidates
```

## How Beehiiv attribution actually works

The Creative Engine (step 5, not built yet) will encode a creative's id as
`utm_content` on every ad/landing-page link it produces. Beehiiv captures
`utm_content` at signup and returns it on the subscription object.
`syncSubscribers()` (`src/services/beehiiv/sync-subscribers.ts`) checks each
new subscriber's `utm_content` against real creative ids and, on a match,
sets `subscribers.source_creative_id` and snapshots that creative's current
CPA (`spend_cents / signups`) as `acquisition_cost_cents` — a fact frozen at
first sync, never recomputed on a later resync (idempotent insert via
`ON CONFLICT (beehiiv_id) DO NOTHING`).

Sending works the other direction: Beehiiv is never contacted while an issue
is a local draft. `approveIssue()` flips `draft → approved` and records the
approval row in one transaction; `sendIssue()` independently re-verifies
that approval row exists (not just the status column) before making the one
and only call to `BeehiivClient.createPost()` in the codebase, which always
sends `status: "confirmed"` — there is no "create-draft-in-Beehiiv" path to
accidentally trigger a send from.

## How sourcing actually works

Every 6 hours: fetch candidates from RSS/Reddit/HN → collapse in-memory
duplicates → drop any URL already in `sources` → embed survivors and drop
any with >0.9 cosine similarity to something persisted in the last 30 days
→ score everything left, 20 at a time, in **one Claude Batch API call**
covering every chunk from this run → persist only candidates whose score
clears `niche.relevanceThreshold`.

A candidate that fails to score (batch timeout, unparseable response) is
never written as "pending" — it's simply not persisted this cycle, and gets
re-fetched and re-attempted next run. Nothing here ever creates an issue or
sends anything — a persisted source is raw material for the draft
generator, which is itself still gated by a human approving the resulting
issue.

Model choice for scoring is **Haiku 4.5, not the Sonnet 4.6 the build spec
names for generation** — the spec pins Sonnet 4.6 for generation but calls
relevance scoring "a cheap ... call," and Haiku 4.5 is materially cheaper
for a batched classification task. See the comment atop
`anthropic-relevance-scorer.ts` for the full reasoning.

## How drafting actually works

On demand (the dashboard's "Generate draft" button — the spec gives no
cadence for this the way it does for sourcing): pick the top
`draftingConfig.sourceCount` unused sources by relevance score, pick the
top `fewShotCount` *sent* issues by open rate as few-shot examples, and make
**one direct (non-Batch) Claude Sonnet 4.6 call** that returns the full
issue body in Markdown plus 5 scored subject-line candidates in one JSON
response.

The "scored against historical open rates" requirement is implemented as an
LLM judgment conditioned on real data, not a fitted statistical model —
with a 5-issue few-shot window there isn't remotely enough data to fit one
honestly. The model sees each historical subject line next to its actual
open rate and is asked to score its own candidates by predicted relative
appeal against that pattern; treat the score as an informed qualitative
judgment, not a calibrated probability. All 5 candidates are stored on the
issue (`subject_line_candidates`), not just the winner, so the dashboard can
show what else was considered.

Drafting never sends anything — it inserts a `status: 'draft'` row and
marks the sources it drew from as used (`sources.used_in_issue_id`), inside
one transaction so a crash mid-run can't leave sources marked used with no
corresponding issue. Getting from there to a subscriber's inbox still needs
a human to click Approve, then Send Now, on the dashboard.

## Non-negotiables enforced in code, not docs

- **`ledger` and `subscriber_events` are append-only at the database
  level.** `drizzle/0001_append_only_triggers.sql` installs `BEFORE UPDATE`
  and `BEFORE DELETE` triggers that raise on both tables. Verified live: a
  direct `UPDATE`/`DELETE` against a real Postgres instance was rejected —
  see "What's been verified live."
- **Every experiment requires a budget and a deadline at creation** —
  `experiments.budget_cents` and `experiments.deadline` are `NOT NULL` with
  no default.
- **Sending an issue, activating an ad, raising a budget, or contacting a
  sponsor all require a prior row in `approvals`.** For sends, this is
  fully wired end-to-end: `sendIssue()` throws `ApprovalRequiredError`
  before ever touching the network if no approval is on file — even if
  `issues.status` says `'approved'` (tested explicitly: flipping the status
  column directly, bypassing `approveIssue()`, still gets refused). The
  dashboard's Approve and Send Now are deliberately two separate buttons —
  approving reviews the content; sending is the separate, irreversible act.
  Activating an ad / raising a budget / sponsor outreach will enforce the
  same way once steps 5–8 land.
- **All creatives are created `paused`** (`creatives.status` defaults to
  `'paused'`) — activation is a separate, human-gated step (step 5).
- **Sending is not idempotent against Beehiiv.** `sendIssue()` refuses to
  send an already-`sent` issue rather than risk a duplicate email.
- **Sourcing never auto-publishes.** It only ever writes to `sources`;
  there is no code path from a persisted source to an issue being drafted,
  approved, or sent without a human in the loop.
- **A daily API-spend cap halts LLM calls, checked before any connector or
  generation call runs.** `isDailyApiCapExceeded()` is the first thing both
  `runSourcingCycle()` and `runDraftGeneration()` check — if today's logged
  `api_cost` spend has already reached `DAILY_API_SPEND_CAP_CENTS`, the
  whole cycle is skipped rather than spending more than it can afford.

## Deliberate deviations from the literal spec

See the file header in [src/db/schema.ts](src/db/schema.ts) for the full reasoning. Short version:

1. Money is `integer` cents throughout (not `bigint`) — ~$21.4M ceiling per
   column, which is far beyond this business's scale; called out so it's a
   deliberate choice, not an oversight.
2. CPC, CPA, conversion rate, and open rate are **not** stored generated
   columns — they're pure functions in `src/lib/metrics.ts`, unit tested
   against fixtures, called by query helpers. Same reasoning applies to
   ledger balance/burn/runway (`src/lib/ledger-math.ts`).
3. `creatives` gained three columns beyond the spec's literal list:
   `format` and `audience_framing` (the other two Creative Engine axes —
   without them as columns, the diversity-matrix coverage check has
   nothing to group by), `status` (backs the paused-by-default gate and
   the Reaper's kill action), and `embedding` (`vector(1024)`, backs the
   >0.9 cosine-similarity de-dup rule; dimension assumes Voyage AI's
   voyage-3-large — revisit if a different embedding provider is chosen).
4. `landing_pages.experiment_id` and `issues.sponsor_id` → `sponsors` were
   added because `experiments.type` includes `landing_page_test` and the
   spec's own creatives table references sponsor economics — both are
   meaningless without something to join against.
5. `approvals` is a single polymorphic table (`target_table` + `target_id`)
   rather than four separate approval tables, since the gate logic is
   identical across all four gated actions. Referential integrity on
   `target_id` is enforced in application code, not a DB constraint —
   Postgres has no conditional multi-table foreign key.
6. `issues.beehiiv_post_id` was added — Beehiiv is only ever contacted at
   send time (see above), and this is the id that call returns, needed for
   the stats poller to have anything to poll.
7. `approvals.sequence` (a `bigserial`) was added after live testing caught
   a real bug: Postgres's `now()`/`defaultNow()` is frozen at *transaction
   start*, not statement execution, so two approvals recorded in the same
   transaction get an identical `approved_at` — `ORDER BY approved_at DESC
   LIMIT 1` is then ambiguous. `sequence` is a monotonic tiebreaker that
   never ties, and `getLatestApproval()` orders by it instead.
8. `sources.embedding` (`vector(1024)`) — same reasoning as #3, backing the
   "semantic similarity against the last 30 days" dedup rule.
9. **Voyage AI** is the embedding provider assumed throughout (sourcing
   dedup here, the Creative Engine's diversity gate later) — the spec's
   integrations list names none, but both "semantic similarity" rules are
   impossible without one. Sourcing degrades gracefully (URL-only dedup,
   with a logged warning) if `VOYAGE_API_KEY` is unset.
10. Relevance scoring uses **Haiku 4.5**, not the Sonnet 4.6 the spec pins
    for generation — see "How sourcing actually works," above.
11. Voyage's per-token cost in `src/config/pricing.ts` is an **unverified
    placeholder** (env-overridable) — no authoritative current rate was
    available while building this. Every embedding call still gets logged
    to the ledger as *some* cost rather than silently looking free;
    correct the constant before trusting it for a real budget decision.
12. `issues.recipients` was added — "select the last 5 high-performing
    issues by open rate" needs a rate, and `opens` alone is a raw count,
    incomparable across issues sent to a growing subscriber base.
    `issues.subject_line_candidates` was added to keep the 4 subject lines
    the draft generator *didn't* pick, for operator visibility, rather than
    discarding them.
13. "Scored against historical open rates" is an LLM judgment conditioned
    on real (subject line, open rate) pairs, not a fitted statistical
    model — see "How drafting actually works," above.
14. The dashboard has no authentication of its own — assumed to run behind
    network-level access control. No user-management system is in scope
    per the spec, and building one wasn't asked for.

## Testing

`npm test` runs 153 tests across 23 files (144 executable in this
environment; 9 are DB-required suites' skip placeholders):

- **Always run, no DB needed** — `ledger-math`, `metrics`, `cohort`,
  `markdown`, `vectors`, `cost-control` (the pure `estimateCostCents`),
  `relevance-scoring` and drafting's `prompt`/`ranking` (prompt building +
  response parsing), the sourcing connectors (`rss`, `reddit`,
  `hackernews`), and `dedupe`'s in-memory URL collapsing: pure functions
  tested against fixture data. These are the functions that will drive real
  spending and content decisions, per the build spec's testing requirement.
- **Run against a real Postgres, skip cleanly without one** — `approvals`,
  `sync-subscribers`, `send-issue` (including the "status says approved
  but no approval row exists" defense-in-depth case), `poll-issue-stats`,
  `cost-control`'s daily-spend queries, sourcing's `dedupe` and
  `runSourcingCycle` (pgvector dedup including the 30-day window boundary;
  full orchestration with fake connectors/scorer/embeddings), and
  drafting's `ranking` and `runDraftGeneration` (full orchestration with a
  fake generator, including the source-marking transaction). Each DB-backed
  suite checks `isDatabaseAvailable()` up front and uses `describe.skipIf`
  — the same posture the build spec takes toward Meta/Beehiiv sandbox
  tests: real coverage when the environment supports it, no false failures
  when it doesn't.

DB-backed tests run inside `src/db/testing.ts`'s `withRollback()`, which
drives the outer transaction through Drizzle's own `db.transaction()`
(rather than a raw `BEGIN`/`ROLLBACK` on a borrowed connection) specifically
so that code under test which opens its *own* nested transaction —
`approveIssue()` and `runDraftGeneration()` both do — gets a real
`SAVEPOINT` instead of silently committing the "rolled back" test data.
That failure mode is exactly what happened during development here; see
the file's header comment.

### What's been verified live

Everything above was exercised against real infrastructure, not just
mocks, during development:

- Ran `npm run db:migrate` against a real Postgres 17 + pgvector from
  empty, across all six migrations, including `CREATE EXTENSION vector`.
- Proved the append-only triggers actually reject writes: a direct
  `UPDATE` and `DELETE` against a live `ledger` row both failed with the
  trigger's error message; a negative `amount_cents` insert failed its
  `CHECK`.
- Verified empirically (not assumed) how Drizzle round-trips a
  `vector(1024)` column — inserted and re-selected a real embedding
  against live pgvector and confirmed it comes back as a plain `number[]`
  — before writing any dedup code that depended on that shape.
- Ran the full `npm test` suite against that live database repeatedly —
  this is what caught the `approvals.sequence` bug and the nested-
  transaction rollback bug described above, neither of which a mock-based
  test would have surfaced.
- Ran the actual `npm run worker` process against real Redis and a local
  stub HTTP server standing in for Beehiiv's API (via the
  `BEEHIIV_API_BASE_URL` override — also useful for pointing at Beehiiv's
  real sandbox later): enqueued one-off `subscriber-sync`, `send-issue`,
  and `issue-stats-poll` jobs and confirmed end-to-end — two fake
  subscriptions synced with one correctly attributed, an approved issue
  rendered from Markdown to HTML and "sent" (the stub returned a fake post
  id, stored on the row), and stats polling wrote opens/clicks back.
- Ran the HN and RSS connectors against the real live Hacker News API and
  a real public RSS feed (read-only, no auth, no cost) and got back
  correctly-shaped candidates from actual current content.
- Ran `next build` for real — one route (`/`), correctly compiled as
  dynamic (server-rendered per request, not statically cached) rather than
  attempted at build time. Then ran `next dev` against the live database
  with seeded data and fetched the real rendered page over HTTP: confirmed
  the balance/runway strip computed correctly from real ledger rows
  (including the "∞, profitable" case), a draft issue's Markdown body
  rendered to the correct HTML, its 5 subject-line candidates rendered
  sorted by score, and both the draft and approved-issue cards carried the
  correct per-row `issueId` in their form's hidden field.

**Not yet exercised against the real thing:** the Anthropic Batch API call
for relevance scoring and the direct Messages API call for drafting (no
`ANTHROPIC_API_KEY` configured in this environment — both covered instead
by unit tests against fakes, and the SDK version was confirmed to expose
`messages.batches` as a stable, non-beta surface after an upgrade from the
originally-pinned `0.32.1`), the Reddit OAuth flow (no
`REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` configured — covered by unit
tests with an injected fetch stub), Voyage's real embeddings endpoint (no
`VOYAGE_API_KEY` configured — covered by unit tests with a fake
`EmbeddingProvider`; sourcing degrades to URL-only dedup without one, which
*is* exercised live), and actually clicking the dashboard's buttons in a
browser (Next.js Server Actions dispatch through an internal
protocol that isn't practical to replay via raw HTTP without a JS
environment; the underlying functions each button calls — `approveIssue`,
`enqueueSendIssue`, `enqueueDraftGeneration` — are independently covered by
the DB-backed suites above).

Integration tests against Meta's sandbox land with the Creative Engine
(step 5); the 6-month synthetic-cohort seed script lands with the Allocator
(step 8) — both per the build order.
