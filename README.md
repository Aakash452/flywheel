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

**All eight build-order steps are done:** schema + migrations + ledger
queries; the Beehiiv integration (subscriber sync with attribution, send
with a verified approval gate, stats polling); the sourcing pipeline (RSS +
Reddit + HN → dedup → batched relevance scoring → persist above threshold);
the draft generator + approval-queue dashboard; the Creative Engine +
Meta push/activate/poll; the Reaper (cascade-kill on deadline or
overspend); Attribution reconciliation (Meta-reported vs. Beehiiv-confirmed
signups); and the Allocator + the full dashboard (flywheel gauge, cohort
retention, creative leaderboard, active experiments). Most of it has been
run end-to-end against a real Postgres 17 + pgvector and real Redis, the
HN/RSS connectors and the Anthropic API have been run against the real live
services, and the dashboard has been built and rendered against a real
6-month synthetic seed dataset — not just unit-tested against mocks. See
"What's been verified live," below, for exactly what has and hasn't been
exercised against real infrastructure.

The build spec's own recommendation was to ship 1–4, then run the
newsletter manually for a few weeks before building the acquisition
machinery (steps 5–8). That manual-operation period was explicitly skipped
here at the operator's direction — steps 5–8 were built immediately after
1–4 rather than gated behind weeks of real operation. The code itself
still enforces every structural gate the spec calls for (paused-by-default
ad creation, no-override Reaper kills, approval rows required for
activation/budget increases) regardless of how much real operating history
exists when someone starts using it.

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
subreddits). Before the Creative Engine or Meta push produce anything: fill
in `src/config/meta.ts` (`pageId`, `defaultAdSetId`, `destinationUrl`,
`signupActionTypes` — all still `REPLACE_ME` placeholders). All four ship
as placeholders — see the comments in each.

`npm run db:seed` (`src/db/seed.ts`) generates ~6 months of internally
consistent synthetic data — subscribers, creatives, experiments, ledger
entries — so the Allocator and dashboard have something to show without
waiting on real traffic. **Point it at a scratch database, never your real
one** (it doesn't clear existing data first, so running it twice doubles
everything): `DATABASE_URL=postgres://flywheel:flywheel@localhost:5432/flywheel_seed npm run db:seed`.
It is deliberately not part of `npm test` or any migration.

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
    creative.ts                        # minVariants / variantsPerCall / maxRounds for the Creative Engine
    meta.ts                              # PLACEHOLDER — pageId, adSetId, destinationUrl, signupActionTypes
    pricing.ts                             # per-token cost table backing every ledger api_cost entry
  db/
    schema.ts             # Drizzle schema — the source of truth for the data model
    client.ts              # Postgres pool + Drizzle instance; Database/Transaction/DbClient types
    migrate.ts              # migration runner (bootstraps the vector extension)
    testing.ts               # test-only: withRollback() transaction isolation, isDatabaseAvailable()
    seed.ts                   # standalone `npm run db:seed` — ~6mo synthetic data for a scratch DB
    queries/
      ledger.ts             # balance / burn-rate / runway, backed by the pure math below
  lib/
    ledger-math.ts          # pure balance/burn/runway functions + unit tests
    metrics.ts               # pure CPC/CPA/CTR/conversion/open-rate functions + unit tests
    cohort.ts                 # pure cohort-week bucketing (UTC ISO-week Monday) + unit tests
    cohort-economics.ts        # pure CAC/RPS/margin/payback/LTV/retention-curve/recommendAllocation
    markdown.ts                  # renders issues.body_md to HTML (Beehiiv send, dashboard preview)
    vectors.ts                     # pure cosine similarity — sourcing dedup + Creative Engine diversity
  integrations/
    beehiiv/
      client.ts              # typed Beehiiv v2 API client (subscriptions, posts) + retry/backoff
      types.ts                 # zod schemas for the Beehiiv responses this client parses
    meta/
      client.ts               # MetaClient — createAdCreative/createAd (always PAUSED)/updateAdStatus/getAdInsights
      types.ts                  # zod schemas for Meta Marketing API v25.0 responses
    embeddings/
      voyage-client.ts          # embedding provider (sourcing dedup + Creative Engine diversity)
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
    creative-engine/
      prompt.ts                  # pure prompt-building + response-parsing; angle/format/audience axes
      diversity.ts                 # axis-coverage check + pgvector >0.9 cosine dedup against experiment
      priors.ts                     # recent Reaper kill reasons, fed back into the generation prompt
      anthropic-creative-generator.ts # Claude Sonnet 4.6, direct call
      factory.ts                     # wires real deps (needs both ANTHROPIC_API_KEY and VOYAGE_API_KEY)
      index.ts                        # orchestrates: generate → embed → filter → top-up loop → persist
    meta/
      push-creatives.ts          # creates paused Meta ad creatives/ads for an experiment's creatives
      activate-creative.ts         # the only call site for updateAdStatus(..., "ACTIVE") — approval-gated
      poll-performance.ts           # every 4h: pulls insights, writes creatives + incremental ledger spend
    reaper/
      index.ts                   # kill on >2x target CPA w/ 0 conversions, or deadline — cascades to creatives
    attribution/
      reconcile.ts                # Meta-reported signups vs. Beehiiv-confirmed subscribers, per creative
    allocator/
      queries.ts                  # DB-backed inputs (cohort weeks, ledger windows) for cohort-economics.ts
      index.ts                     # blended economics + per-cohort LTV/recommendation — read-only, no writes
    experiments/
      increase-budget.ts          # applies a +20% budget raise — the only 'increase_budget' approval writer
  queue/
    connection.ts              # shared ioredis connection for BullMQ
    queues.ts                   # queue definitions, cron schedule, all enqueue*() functions
    worker.ts                    # process entrypoint — `npm run worker`
  app/
    layout.tsx                  # root layout — no theming system, no dark mode
    page.tsx                      # the dashboard: ledger, drafts, flywheel gauge, cohorts, experiments,
                                   #   creative leaderboard, attribution — all sections in one page
    actions.ts                     # server actions backing every dashboard button
    charts.tsx                      # server-rendered SVG charts (no client JS) — see its header comment
    format.ts                        # shared display formatters (formatCents, formatRunway, ...)
    globals.css                       # minimal styling, light-mode only
drizzle/
  0000_*.sql                     # generated table/enum/index/FK migration
  0001_append_only_triggers.sql  # hand-written: makes ledger + subscriber_events append-only
  0002_*.sql                     # issues.beehiiv_post_id
  0003_*.sql                     # approvals.sequence (monotonic tiebreaker — see below)
  0004_*.sql                     # sources.embedding
  0005_*.sql                     # issues.recipients, issues.subject_line_candidates
  0006_*.sql                     # experiments.target_cpa_cents, creatives.kill_reason, creatives.image_url
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

## How the Creative Engine actually works

On demand (the dashboard's "Generate creatives" form, per experiment): make
**one direct (non-Batch) Claude Sonnet 4.6 call** requesting
`creativeEngineConfig.variantsPerCall` variants at once, covering every
combination of the three axes (angle × format × audience framing) the
prompt asks for. Each returned variant is embedded (Voyage) and rejected if
its cosine similarity to any existing variant *in the same experiment*
exceeds 0.9 — the same dedup threshold sourcing uses, applied to creative
diversity instead of source novelty. If a round doesn't reach
`minVariants` after filtering, it loops (up to `maxRounds`), asking again
and passing back which axis combinations are still missing so the model
fills gaps rather than regenerating what already exists.

Recent Reaper kills feed back in as `pastFailures` in the prompt — real
angle/format/audience combinations that got killed, and why — so a
mediocre creative doesn't get regenerated indefinitely. This is an LLM
judgment conditioned on real outcomes, not a fitted model, same posture as
drafting's subject-line scoring.

Every persisted creative defaults to `status: 'paused'` and has no
`platform_creative_id` until pushed to Meta — nothing here talks to Meta
directly; that's a separate, later step (below).

## How Meta push / activation / polling actually works

**Push** (`pushCreativesToMeta`, on demand): for each of an experiment's
paused, not-yet-pushed creatives, calls `MetaClient.createAdCreative()`
then `createAd()` — which **always** sends `status: "PAUSED"`, hardcoded,
with no parameter or code path that can create an ad as `ACTIVE`. The
resulting ad id is stored as `creatives.platform_creative_id`. The
destination link gets `?utm_content=<creativeId>` appended
(`buildAttributedLink`) — the same id `syncSubscribers()` later reads back
off a Beehiiv subscription to attribute it.

**Activation** (`activateCreative`, the dashboard's "Activate" button): the
*only* call site for `updateAdStatus(..., "ACTIVE")` in the codebase.
Refuses a creative that hasn't been pushed, is already active, or was
killed by the Reaper (no override — "create a new experiment instead," per
spec) — and independently re-verifies an `activate_ad` approval row exists
before calling Meta, mirroring `sendIssue()`'s gate exactly. The dashboard
action records that approval and enqueues the job in one click; the
worker's `activateCreative()` call re-checks the approval itself rather
than trusting the enqueue.

**Polling** (`pollCreativePerformance`, every 4 hours per the spec):
pulls insights per pushed creative, writes `impressions`/`clicks`/`signups`
back, and logs the *incremental* spend delta (this poll's reported spend
minus what was already logged) as an `ad_spend` ledger row — never the
cumulative total, which would double-count across polls. The same delta
also increments the parent experiment's `spent_cents`, since nothing else
updates that column.

## How the Reaper actually works

Runs hourly (per spec). Two independent kill rules, both cascading the
same way: **overspend** — a creative that has spent more than 2× its
experiment's `target_cpa_cents` with zero signups — and **deadline** — any
experiment past its `deadline` that's still `active`. Killing an experiment
kills every one of its still-live creatives and calls Meta to pause each
one's ad (pausing needs no approval; only activation does) — a Meta
failure here is caught and logged, not allowed to block the local kill,
since "the local ledger is right" matters more than "Meta's dashboard is
right" for an operator deciding what's dead. `CreativeKilledError` has no
override path anywhere in the codebase — the spec's "no override" is
enforced structurally, not just documented.

## How Attribution reconciliation actually works

Read-only. `getAttributionReconciliation()` LEFT JOINs `creatives` against
`subscribers` (via `source_creative_id`) and compares the count of actually
-confirmed subscribers against `creatives.signups` (Meta's own reported
count, written by the poller above). A nonzero `discrepancy` is a real
signal — a stripped UTM parameter, a sync that hasn't caught up, or a Meta
conversion pixel firing without a confirmed Beehiiv subscription — not
noise to explain away. Verified end-to-end against the real
`syncSubscribers()` path (not a reimplementation) in
`reconcile.db.test.ts`.

## How the Allocator actually works

Also read-only — "nothing here writes a budget change or acts on
anything; a human reads this and decides" (see the file header in
`src/services/allocator/index.ts`). Blended figures (CAC, RPS, contribution
margin, payback) are computed newsletter-wide over a trailing 30-day
window, since a per-cohort breakdown of *ad spend specifically* isn't
something the ledger tracks. What genuinely varies per cohort is
retention — each cohort's own observed survival curve — so LTV, LTV/CAC,
and `recommendAllocation()`'s four-branch recommendation
(`scale_up_20` / `hold` / `cut_50_and_new_experiment` / `halt_all_spend`,
in that precedence, with runway < 21 days overriding everything) are
computed per cohort against the shared blended CAC/payback. Applying a
`scale_up_20` recommendation to an actual experiment's budget is a
separate, human judgment call (the dashboard's "Increase budget +20%"
button, `src/services/experiments/increase-budget.ts`) — the Allocator
tells you a *cohort* is worth doubling down on; deciding which
*experiment* is driving that cohort isn't a formula.

## Non-negotiables enforced in code, not docs

- **`ledger` and `subscriber_events` are append-only at the database
  level.** `drizzle/0001_append_only_triggers.sql` installs `BEFORE UPDATE`
  and `BEFORE DELETE` triggers that raise on both tables. Verified live: a
  direct `UPDATE`/`DELETE` against a real Postgres instance was rejected —
  see "What's been verified live."
- **Every experiment requires a budget and a deadline at creation** —
  `experiments.budget_cents` and `experiments.deadline` are `NOT NULL` with
  no default.
- **Sending an issue, activating an ad, or raising a budget all require a
  prior row in `approvals`.** All three are fully wired end-to-end:
  `sendIssue()`, `activateCreative()`, and `increaseBudget()` each throw
  `ApprovalRequiredError` before doing anything irreversible if no approval
  is on file — even if a cached status column says otherwise (tested
  explicitly for sends: flipping `issues.status` directly, bypassing
  `approveIssue()`, still gets refused). The dashboard's Approve/Activate
  and Send Now/Generate are deliberately separate actions — reviewing
  content or deciding to scale is not the same click as the irreversible
  act itself. (Sponsor outreach has an `approval_action_type` reserved for
  it in the schema but no service built around it yet — no sponsor-contact
  code exists to gate.)
- **All creatives are created `paused`, and Meta ad creation has no
  parameter that can override that.** `MetaClient.createAd()` hardcodes
  `status: "PAUSED"` in every call — there is no code path from anywhere in
  this codebase to an ad going live on Meta without a human clicking
  Activate.
- **The Reaper's kill has no override.** `CreativeKilledError` is thrown
  unconditionally by `activateCreative()` for any creative the Reaper has
  killed — reviving one isn't a config flag or an admin action, only
  creating a new experiment.
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
15. `experiments.target_cpa_cents` was added (nullable) — the Reaper's
    "spent >2× target CPA with 0 conversions" rule is meaningless without a
    target CPA to compare against, and it's inherently per-experiment (a
    landing-page test and a channel test don't share one number), not a
    niche-wide constant. Null for experiment types that don't have one; the
    Reaper skips the CPA-based kill check (not the deadline check) when
    absent.
16. `creatives.kill_reason` and `creatives.image_url` were added.
    `kill_reason` backs the spec's own requirement that the Reaper's kill
    log "becomes training data for the creative engine's priors" — that
    needs knowing *why*, not just *that*, a creative died. `image_url` is
    where a real rendered asset lives once one exists; there is **no
    image-generation model in this stack** (only the Anthropic SDK for
    text), so the Creative Engine only produces `image_prompt` — pushing a
    creative to Meta requires a real `image_url`, which is a manual or
    future-pipeline step explicitly out of scope here.
17. Cohort-level economics interpretation: the spec's "per cohort" framing
    for CAC/RPS/margin/payback isn't fully explicit about whether those are
    blended or truly per-cohort. This build computes them blended
    newsletter-wide (the ledger doesn't break ad spend out per cohort) and
    computes retention/LTV/the resulting recommendation per cohort — see
    "How the Allocator actually works," above, and the file header in
    `src/services/allocator/index.ts` for the full reasoning.
18. `recommendAllocation()`'s four spec rules aren't perfectly mutually
    exclusive as written (e.g., "payback < 30 days but 2 ≤ LTV/CAC ≤ 3" is
    covered by no literal rule). That gap defaults to `hold` — the
    conservative choice for a case the spec is silent on — documented in
    the function's own comment rather than left as an implicit fallthrough.
19. Applying a `scale_up_20`/`cut_50` recommendation to a real budget is a
    separate human action (`src/services/experiments/increase-budget.ts`),
    not something the Allocator itself does — see "How the Allocator
    actually works," above.
20. The dashboard's charts (`src/app/charts.tsx`) are server-rendered SVG
    with no client-side JS — the app has had zero `"use client"` boundaries
    through step 4, and adding the first one just for hover crosshairs
    wasn't judged worth the new pattern for a single-operator internal
    tool. Hover affordance comes from native SVG `<title>` tooltips
    instead of a custom interaction layer; this is a documented trade
    against a fuller charting approach, not an oversight.
21. `src/db/seed.ts` (the 6-month synthetic dataset) was built ahead of the
    build order's literal step 8 placement, alongside the rest of steps
    5–8, since the Allocator/dashboard are hard to demo or sanity-check
    against an empty database. It is standalone (`npm run db:seed`),
    deliberately excluded from `npm test` and from any migration, and
    intended for a scratch database only.

## Testing

`npm test` runs 276 tests across 39 files (256 executable in this
environment; 20 are DB-required suites' skip placeholders — this
environment does have `DATABASE_URL` set, so in practice all 276 run and
pass; the skip path exists for an environment without one).

- **Always run, no DB needed** — `ledger-math`, `metrics`, `cohort`,
  `cohort-economics` (26 tests — the pure CAC/RPS/margin/payback/LTV/
  retention-curve/`recommendAllocation` math, including one test per
  allocation-recommendation branch), `markdown`, `vectors`, `cost-control`
  (the pure `estimateCostCents`), `relevance-scoring`, drafting's
  `prompt`/`ranking`, creative-engine's `prompt`/`diversity` (axis-coverage
  logic), the Meta client (`src/integrations/meta/client.test.ts` — a
  `fetchStub` pattern proving `createAd()` always sends `status=PAUSED`
  regardless of input), the sourcing connectors (`rss`, `reddit`,
  `hackernews`), and `dedupe`'s in-memory URL collapsing: pure functions
  and typed-client parsing tested against fixture data. These are the
  functions that will drive real spending and content decisions, per the
  build spec's testing requirement.
- **Run against a real Postgres, skip cleanly without one** — `approvals`,
  `sync-subscribers`, `send-issue` (including the "status says approved
  but no approval row exists" defense-in-depth case), `poll-issue-stats`,
  `cost-control`'s daily-spend queries, sourcing's `dedupe` and
  `runSourcingCycle`, drafting's `ranking` and `runDraftGeneration`,
  creative-engine's `runCreativeGeneration` and `diversity` (real pgvector
  cosine dedup), Meta's `push-creatives`/`activate-creative`/
  `poll-performance` (fake `MetaClient` implementations, real DB
  read/write), the Reaper's both kill rules and the cascade case,
  Attribution's `reconcile` (driving the real `syncSubscribers()` path, not
  a reimplementation), and the Allocator's `queries` and `index` (hand-
  computed expected CAC/payback figures checked against real Postgres
  aggregation), plus `experiments/increase-budget` (the +20% raise,
  atomicity with the approval write, and refusing killed/won experiments).
  Each DB-backed suite checks `isDatabaseAvailable()` up front and uses
  `describe.skipIf` — the same posture the build spec takes toward
  Meta/Beehiiv sandbox tests: real coverage when the environment supports
  it, no false failures when it doesn't.
- **Tests and real usage no longer share a database.** `vitest.config.ts`
  loads `.env.test` (gitignored; `.env.test.example` is committed),
  pointing `DATABASE_URL` at a separate `flywheel_test` database, distinct
  from both the real `flywheel` database and the scratch `flywheel_seed`
  database `npm run db:seed` writes to. This was added after a real
  incident during development — see "What's been verified live," below.

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
- **Ran the real Anthropic API** (a real `sk-ant-...` key, not a fake) for
  both relevance scoring and draft generation. This caught two real bugs
  neither mocks nor unit tests would have: relevance scoring's
  `max_tokens: 1024` silently truncated ~10/16 real batch chunks
  (`stop_reason: "max_tokens"`, pulled directly from
  `messages.batches.results()`), fixed by raising the limit and adding
  truncation-recovery parsing; and a placeholder `[NAME]` literal in
  `voice.ts` got taken literally by the model, which invented a fictional
  byline — flagged as a content fix, not a code fix.
- **Ran the real Beehiiv API** against real publication credentials. This
  caught a real schema mismatch: the documented-as-required
  `total_results` field is actually absent from real cursor-paginated
  `/subscriptions` responses, which made every real response fail Zod
  validation until the field was made optional (with the real captured
  response kept as a regression fixture in `client.test.ts`).
- **Ran `npm run db:seed` and verified the output against real Postgres**
  (not just "did it insert without erroring") — pulled `getBalanceCents`,
  `getRunwayDays`, `getAttributionSummary`, and `computeAllocatorSummary`
  against the seeded `flywheel_seed` database and confirmed the numbers
  hang together: positive balance, 98%+ attribution rate with zero
  creatives showing a signup discrepancy, and cohorts spanning all four
  `recommendAllocation()` branches (`scale_up_20`, `hold`,
  `cut_50_and_new_experiment` — `halt_all_spend` is unit-tested directly
  but deliberately not forced into the seed data, since a demo dataset
  that starts the business insolvent isn't a useful demo).
- **Rendered the full dashboard against that seeded data with a real
  browser** (Playwright + Chromium, not just `curl`) and screenshotted it —
  caught a real bug this way: SVG `<title>` tooltip elements built from
  JSX text+expression children (`<title>{label}: {value}</title>`) trigger
  a React warning and don't render as valid tooltips, because React
  special-cases any element literally named `title`; fixed by using
  template-string children instead. Also caught and fixed a label-collision
  readability issue in the cohort retention chart (a very recent cohort's
  end-label piling up on top of the legend/other lines) by suppressing the
  direct label — not the data point — for a line whose last point falls in
  the chart's first 30%, since the always-present legend already
  identifies it by color.

**Not yet exercised against the real thing:** the Meta Marketing API (no
Meta credentials configured in this environment — `src/config/meta.ts` is
still `REPLACE_ME` placeholders; `MetaClient` is covered instead by 11
unit tests against a `fetchStub`, and its zod response schemas are
explicitly flagged in `src/integrations/meta/types.ts` as not independently
verified against a real API response, unlike Beehiiv's), the Reddit OAuth
flow (no `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` configured — covered by
unit tests with an injected fetch stub), Voyage's real embeddings endpoint
for the Creative Engine's diversity gate specifically (sourcing's use of it
*is* exercised live via the relevance-scoring runs above, and the
diversity-gate math itself is covered against real pgvector in
`diversity.db.test.ts` — just not with a real Voyage embedding backing a
real Creative Engine generation call), image generation (there is no
image-generation model anywhere in this stack — see deviation #16 — so
`creatives.image_url` has never been populated by anything other than a
test fixture), and actually clicking the dashboard's buttons in a browser
(Next.js Server Actions dispatch through an internal protocol that isn't
practical to replay via raw HTTP without a JS environment; the underlying
functions each button calls are independently covered by the DB-backed
suites above, and the resulting page *rendering* was verified live as
described above).
