# Trading intelligence emails — n8n Cloud

Automated trading-intelligence emails per [PRD](./ARCHITECTURE.md#1-audit-of-the-existing-n8n-instance)
(see `ARCHITECTURE.md` for the audit and approved design). Phase 1: free API
tiers, four scheduled emails per US trading weekday, zero manual triggering.

**Status: 07:50, 09:20 and 16:10 built (inactive, pending go-live approval).
Position tracking via email replies built. 03:50 comes last.**

## Workflows on the n8n instance

| Workflow | ID | Role |
|---|---|---|
| `TRADE 07:50 – Premarket Brief` | `d6zBGWsfGGM1fHWU` | Gap list w/ grades+reasons, candidate cards, news, positions |
| `TRADE 09:20 – Open Plan` | `Kt0DiUU7csAPGlDH` | Premarket recap vs 07:50 watchlist, A-list cards, EDGAR-backed avoid list, swing watch |
| `TRADE 16:10 – Close Report` | `zeERtfVkvCYMBEIv` | Day recap (indices/sectors/movers), scorecard w/ outcome writeback, after-hours, swing cards, long book, Friday sections |
| `TRADE Position Intake (email replies)` | `c5P5kL61g2ki1CNm` | Polls Gmail replies, Haiku parses buys/sells, writes positions (never guesses; flags unparseable) |
| `TRADE SUB – Market Gate` | `NuHBi32ah5TlEGI5` | Weekday + holiday/half-day check, ET slot window (fail-closed), run_log dedupe |
| `TRADE SUB – Fetch Movers` | `60zaDamifwOEu5JX` | FMP gainers → universe filter → Finnhub quote + metric → post-quote gap re-filter |
| `TRADE SUB – Compute Levels` | `E3IcSgGjmmLrKDaZ` | Polygon daily+30min bars (15s pacing, retries), deterministic levels, quote-only fallback |
| `TRADE SUB – Grade Candidate` | `omcQfCxd6DcZ61Vh` | Anthropic scores 0–2 or null per factor, code renormalizes to 0–10 → A/B/C/U |
| `TRADE SUB – Render Charts` | `qqxEavKPwuZAUMGM` | QuickChart candlesticks with level annotations |
| `TRADE SUB – News Since` | `E8aPRgsyBbq1tRFA` | Finnhub news, signal filter, ticker validation, hyperlinks, Anthropic classification |
| `TRADE SUB – Positions Section` | `9GERsQU80SaDguXd` | Per-email positions block: price vs entry, days held, deterministic swing verdicts |
| `TRADE SUB – Compose + Send` | `wnj6cIAXy3HWXyUE` | Email shell + positions append, per-section degradation, Gmail, run_log |
| `ZZ Probe – API checks (temp)` | `q259zw78c3J9djOQ` | Endpoint verification scratchpad — safe to delete |

## Position tracking (reply to any digest)

Reply to a digest email in free text — `bought SURG at 0.52, 2000 shares,
swing` opens a tracked position (storing the matching call's levels and
context as of that moment); `sold SURG at 1.10` closes it. Haiku parses the
reply; anything ambiguous is **flagged in the next email, never guessed**.
New positions print a "now tracking … reply if wrong" confirmation. Every
email carries a Positions section: current price, % vs entry, days held, and
a deterministic swing verdict (below the stored confirm level = EXIT SIGNAL).
Long-horizon positions get Friday thesis re-grades (plumbing lands with the
03:50 build). Intake polls Gmail every 30 minutes once activated.

The three original `Momentum – *` workflows are superseded; they stay inactive
until the new system has run clean for a few days, then get archived.

## Scheduling (DST-proof by construction)

n8n Cloud's workflow SDK cannot set a workflow timezone, and the instance
default is Europe/London. London–New York offset is +5h most of the year and
+4h for a few weeks when the US and UK switch DST on different dates. So every
main workflow fires **two crons — ET target +4h and +5h London time** — and the
Market Gate sub only lets the fire within ±20 minutes of the ET target proceed
(production runs only; manual test runs skip the window check). A `run_log`
dedupe guarantees one send per slot per day even if both fires pass.

07:50 ET brief: `50 11 * * 1-5` and `50 12 * * 1-5` (Europe/London).

## Data sources (phase 1, free) — and what we learned the hard way

- **FMP free tier**: `biggest-gainers`, index quotes (`^GSPC`), treasury rates
  work. **Per-symbol quote/EOD/intraday endpoints 402 on micro-cap symbols** —
  the free tier only covers a restricted symbol universe, which is fatal for a
  small-cap momentum system. FMP is therefore only used for the gainers list
  and macro data (~4 calls/day of the 250/day budget).
- **Finnhub free tier**: quotes (all symbols — verified on live micro-cap
  gappers), `stock/metric` (10-day avg volume, market cap), company + general
  news, market holidays. No hard daily cap. This carries most per-symbol load.
- **Yahoo chart API**: 429-blocked from n8n Cloud's shared IPs. Dead end.
- **Stooq**: serves a JavaScript anti-bot challenge to datacenter IPs. Dead end.
- **QuickChart**: `POST /chart/create` works, candlestick + annotation verified.
- **Anthropic**: `claude-sonnet-5` via the n8n Anthropic node. Note: passing
  `temperature: 0` makes the node emit a bad request — omit temperature.
- **Polygon.io free tier** (added): daily + 30-min aggregates incl. premarket
  for all US tickers power the level engine, RVOL, PM stats and charts. The
  5-calls/min limit is respected with 15s Wait nodes before each Polygon call
  in the levels sub (≈4 calls/min worst case) plus retry-on-429. If Polygon
  fails, levels degrade to quote-only derivation (trigger = premarket high
  from Finnhub quote, confirm = snapped prior close, range = +20% open cap)
  and charts are suppressed — the email still sends.

## Context store (n8n data tables)

`api_cache` `DX4hYHnK0itEBzok` · `watchlist` `0DmgyeReARhBVIbM` · `calls`
`xXUsSKUJSwGQpYcx` · `news_log` `5PKuOVnKdzIdiFYp` · `long_book`
`Y0RpE6uOqsL1Aju2` · `congress_trades` `OiNedcvYkzQJ1Wnv` · `run_log`
`3UGSUcR2CiON1iYu`

## Level derivation (deterministic — the LLM never picks numbers)

Implemented and unit-tested in `src/levels.js` (13 assertions); the same code
runs in the Compute Levels sub-workflow:

- **Trigger**: premarket high, or the most recent regular-session high if above it.
- **Confirm**: nearest prior reclaimed pivot high below the trigger, snapped to
  $0.50/$1.00 when within 2%. Fallbacks: prior close → premarket low → −10%.
- **Range**: nearest daily anchor above trigger, priority 200MA → gap-fill →
  multi-day shelf; `+` (open-ended) when nothing within +20%.
- **Invalidation**: the confirm level.

## Grading

Anthropic scores five factors (catalyst, RVOL, float/liquidity fit, level
structure, dilution) with one-line reasons. Each factor is 0–2 **or null when
its underlying data is missing** — missing data is never scored as 0. Code
validates the JSON and renormalizes: score = sum over available factors scaled
to 0–10; ≥8→A, ≥6→B, <6→C (mention only). Fewer than 3 available factors →
**U (ungradeable)**, mention only. Catalyst 0 with RVOL <2 caps at C. LLM
failure degrades to U — the email still sends. The email prints all five
one-line reasons per graded name, in the gap list and on cards.

The verdict box distinguishes three states and never presents a data failure
as a trading call: **no trade** (graded, nothing reached B), **no qualifying
gappers** (universe empty), and **data unavailable** (movers/enrichment/
grading failed — amber box, explicitly "not a trading verdict").

## Scheduling gate (verified 2026-07-03)

Production fires are fail-closed: unknown execution modes are treated as
production and must pass weekday + holiday + ±20-min ET window + run_log
dedupe. A pinned-data production simulation on the observed Independence Day
holiday was rejected on three independent grounds (holiday, window, mode).
Manual runs always proceed (explicit human action = test send).

## Credentials in use

FMP API (query auth) · Finnhub API (query auth) · Gmail OAuth2 ·
Anthropic API. Keys live only in n8n Cloud credentials, never in this repo.
