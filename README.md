# Trading intelligence emails — n8n Cloud

Automated trading-intelligence emails per [PRD](./ARCHITECTURE.md#1-audit-of-the-existing-n8n-instance)
(see `ARCHITECTURE.md` for the audit and approved design). Phase 1: free API
tiers, four scheduled emails per US trading weekday, zero manual triggering.

**Status: live. All five workflows published and running on schedule since
Mon 6 Jul 2026 (first fully clean scheduled sends: 09:20 and 16:10 that day;
03:50 and 07:50 recovered manually after a late activation and a zero-item
bug respectively, both since fixed). Tue 7 Jul: all slots fired and sent on
schedule; a 10-item fix pass from Monday's live emails shipped the same
morning — see "Premarket scan (Polygon)" and the hardening notes below.**

## Workflows on the n8n instance

| Workflow | ID | Role |
|---|---|---|
| `TRADE 03:50 – Overnight Brief` | `7p5QTGOkoDr7mdMd` | Prior-session recap, overnight tape (world indices/BTC/treasuries), earnings+IPO calendar, premarket watch (names only), long book, overnight news |
| `TRADE 07:50 – Premarket Brief` | `d6zBGWsfGGM1fHWU` | Gap list w/ grades+reasons, candidate cards, news, positions |
| `TRADE 09:20 – Open Plan` | `Kt0DiUU7csAPGlDH` | Premarket recap vs 07:50 watchlist, A-list cards, EDGAR-backed avoid list, swing watch |
| `TRADE 16:10 – Close Report` | `zeERtfVkvCYMBEIv` | Day recap (indices/sectors/movers), scorecard w/ outcome writeback, after-hours, swing cards, long book, Friday sections |
| `TRADE Position Intake (email replies)` | `c5P5kL61g2ki1CNm` | Polls Gmail replies, Haiku parses buys/sells, writes positions (never guesses; flags unparseable) |
| `TRADE SUB – Market Gate` | `NuHBi32ah5TlEGI5` | Weekday + holiday/half-day check, ET slot window (fail-closed), run_log dedupe |
| `TRADE SUB – Fetch Movers` | `60zaDamifwOEu5JX` | FMP gainers → universe filter (funds + non-common share classes excluded) → Finnhub quote + metric → post-quote gap re-filter. Used by 03:50 recap and 16:10 swing scan |
| `TRADE SUB – Premarket Scan` | `SrtFvpxJCEgWWUfv` | FMP gainers universe → Polygon same-day 5-min bars (PM high/low/vol, live gap vs Polygon prev close) → Finnhub metric → RVOL. Candidate source for 07:50 and 09:20 |
| `TRADE SUB – Compute Levels` | `E3IcSgGjmmLrKDaZ` | Polygon daily+30min bars (15s pacing, retries), deterministic levels, quote-only fallback |
| `TRADE SUB – Grade Candidate` | `omcQfCxd6DcZ61Vh` | Anthropic scores 0–2 or null per factor, code renormalizes to 0–10 → A/B/C/U |
| `TRADE SUB – Render Charts` | `qqxEavKPwuZAUMGM` | QuickChart candlesticks with level annotations |
| `TRADE SUB – News Since` | `E8aPRgsyBbq1tRFA` | Finnhub news, signal filter, ticker validation, hyperlinks, Anthropic classification, hardened catalyst attribution |
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

03:50 → `50 7` + `50 8` · 07:50 → `50 11` + `50 12` · 09:20 → `20 13` +
`20 14` · 16:10 → `10 20` + `10 21` (all `* * 1-5`, Europe/London).

## Data sources (phase 1, free) — and what we learned the hard way

- **FMP free tier**: `biggest-gainers`, index quotes (`^GSPC`), treasury rates
  work. **Per-symbol quote/EOD/intraday endpoints 402 on micro-cap symbols** —
  the free tier only covers a restricted symbol universe, which is fatal for a
  small-cap momentum system. FMP is therefore only used for the gainers list
  and macro data (~4 calls/day of the 250/day budget).
- **Finnhub free tier**: quotes (all symbols — verified on live micro-cap
  gappers), `stock/metric` (10-day avg volume, market cap), company + general
  news, market holidays, earnings + IPO calendars (used by the 03:50 brief),
  crypto quotes (`BINANCE:BTCUSDT` as the overnight risk proxy). No hard daily
  cap. This carries most per-symbol load.
- **Yahoo chart API**: 429-blocked from n8n Cloud's shared IPs. Dead end.
- **Stooq**: serves a JavaScript anti-bot challenge to datacenter IPs. Dead end.
- **QuickChart**: `POST /chart/create` works, candlestick + annotation verified.
- **Anthropic**: `claude-sonnet-5` via the n8n Anthropic node. Note: passing
  `temperature: 0` makes the node emit a bad request — omit temperature.
- **Polygon.io** (aggregates): daily + intraday aggregates incl. premarket
  for all US tickers power the level engine, RVOL, PM stats and charts. If
  Polygon fails, levels degrade to quote-only derivation (trigger = premarket
  high from Finnhub quote, confirm = snapped prior close, range = +20% open
  cap) and charts are suppressed — the email still sends.
  **Starter-plan findings (7 Jul)**: the snapshot endpoints
  (`/v2/snapshot/.../gainers`) return 403 NOT_AUTHORIZED on this key — no
  full-market premarket movers scan, so the premarket scan keeps FMP's
  gainers list as its universe and enriches it with Polygon aggregates. And
  despite Starter advertising unlimited calls, the key rate-limited (429) a
  burst of 16 concurrent aggregate calls in the first live scan — behavior
  matching the free tier's 5 calls/min, worth checking on the Polygon
  dashboard that the Starter subscription is attached to this exact key.
  Every Polygon call is therefore throttled: scan HTTP nodes batch 1 request
  / 13s with retry-on-fail, and the levels sub keeps its 15s Wait pacing
  (reverted after a brief 1s experiment that starved 6 of 8 candidates of
  levels on the first live run).

## Context store (n8n data tables)

`api_cache` `DX4hYHnK0itEBzok` · `watchlist` `0DmgyeReARhBVIbM` · `calls`
`xXUsSKUJSwGQpYcx` · `news_log` `5PKuOVnKdzIdiFYp` · `long_book`
`Y0RpE6uOqsL1Aju2` · `congress_trades` `OiNedcvYkzQJ1Wnv` · `run_log`
`3UGSUcR2CiON1iYu` · `positions` `PVdNOs7jNw5insN5`

## 03:50 Overnight Brief — what it does (and deliberately doesn't)

Sections: prior US session (indices, sector rotation, gainers/losers with
linked attribution), overnight tape (Nikkei/Hang Seng/FTSE/DAX via FMP, BTC
via Finnhub as risk proxy, treasury 2Y/10Y/2s10s via FMP — labeled proxies,
no free US-futures feed), today's earnings + IPO calendars (Finnhub; econ
releases are phase 2), premarket watch (prior-close movers ∪ overnight news —
**names only, explicitly NOT suggestions**; premarket opens 04:00 ET after
this email's pull, so levels/RVOL/grades wait for 07:50), long book,
congressional placeholder, overnight news since 16:10 (3-day lookback on
Mondays), positions. No cards, no grades, no table writes — the 03:50 email
is context, not calls.

## Premarket scan (Polygon) — 07:50/09:20 candidate source (added 7 Jul)

The 07:50 and 09:20 workflows source candidates from `TRADE SUB – Premarket
Scan` instead of the quote-based Fetch Movers (which stays in place for the
03:50 prior-session recap and the 16:10 swing scan). The scan takes FMP's
biggest-gainers list, applies the shared universe filter (funds, non-common
share classes, loose price band), takes the top 10, and pulls per-symbol
Polygon same-day 5-minute bars (15-min delayed on Starter) plus the previous
close: premarket high/low/volume, last premarket print, **live gap = (PM last
− prev close)/prev close**, and RVOL = PM volume / Finnhub 10-day average.
Every field falls back to the FMP listed values when a Polygon call fails, so
the scan output contract is identical to Fetch Movers and the mains degrade
rather than break. The 09:20 email leads with a premarket top-gainers table
(ticker, gap, price, PM high/low/vol, RVOL, grade, linked catalyst), then the
cards. Known limitation, deliberate: gappers with no prior-session move that
only started running in premarket are invisible to FMP's list — fixing that
needs the Polygon snapshot entitlement (plan upgrade).

Two content rules shipped in the same pass: a candidate card whose last price
is **below its confirm level is not an active setup** — it is excluded from
the suggested set and, when shown for transparency, carries an amber
INVALIDATED banner; and the 07:50 cards read like a curated daily watchlist
(ticker + linked catalyst headline, "worth watching if price breaks above X
and confirms above Y", range, chart pair) while 09:20 stays specific to
gainers at the open. Factor reason lines print once per stock — on the card
only; the gap list carries just the grade.

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
failure degrades to U — the email still sends. Two rules hardened 7 Jul:
**dilution 2 requires an affirmative clean EDGAR check** (edgarFilings exactly
0 and no dilution language) — an absent or failed EDGAR call is null, never a
clean bill; and **catalyst freshness looks back 3–5 trading days** (2 =
catalyst within 2 trading days, 1 = real catalyst 3–5 days old), instead of
only since the last email. The context line always names the date of the
original move, never today. The email prints all five
one-line reasons per graded name, in the gap list and on cards.

The verdict box distinguishes three states and never presents a data failure
as a trading call: **no trade** (graded, nothing reached B), **no qualifying
gappers** (universe empty), and **data unavailable** (movers/enrichment/
grading failed — amber box, explicitly "not a trading verdict").

### Catalyst attribution (feeds grading — hardened 2026-07-05)

Per-symbol catalyst headlines come from Finnhub company news. Finnhub's
`related` tag indexes roundup listicles under every ticker they mention, which
once rendered a SurgePays headline as DSY's "catalyst". The catalyst path now
(a) only attributes to symbols the run actually queried, (b) dedupes per
symbol+url instead of first-wins across symbols, and (c) drops listicle/
roundup headlines ("Top movers…", "12 Health Care Stocks Moving…", and since
7 Jul "Which stocks are experiencing notable movement…" variants) by regex —
deterministic rather than LLM-classified because catalystJson feeds the
grading factor and must stay safe when the Anthropic call fails. A name with
only listicle coverage renders "no clear catalyst identified" and its grading
facts carry no headlines. The universe filter also excludes non-common share
classes (rights/warrants/units/preferred/when-issued, by security name and by
symbol suffix incl. the NASDAQ 5th-letter R/W/U/V codes), and the raw
gainers/losers display lines in the 03:50/16:10 emails apply the same
exclusion. The display lines also drop moves >300% — FMP's pre-open Monday
gainers list computes weekend reverse splits as +2000% "gains"; the candidate
path was already immune because the movers sub re-checks gaps against live
quotes.

**Zero-item chain death (root-caused live, 6 Jul):** an n8n HTTP node whose
response is an empty JSON array outputs zero items, and every downstream node
silently never runs — the execution still reports "success". This killed the
first production 07:50: Finnhub company-news returned `[]` for the single
candidate, News Since died at that node, and the send never happened. Every
HTTP node that can return a bare empty array now has `alwaysOutputData`
(News Since general+company news, Fetch Movers gainers, the 03:50/16:10
index/sector/gainers/losers/treasury/calendar fetches); downstream code
already filters empty items. The 09:20 recap path was already
sentinel-protected. Extended 7 Jul: every non-gate Execute-Workflow node in
all four mains also carries `alwaysOutputData` + continue-on-error, so a sub
that dies or returns nothing degrades its section instead of killing the
send (the gate stays strict/fail-closed). Verified by forced test: with a
news sub sabotaged to return zero items, the 07:50 still sent with the news
and gap sections marked unavailable and an amber non-verdict box. The
Fetch Movers gap re-filter also stopped treating a stale Finnhub quote
(current == previous close, i.e. no print this session) as a 0% gap — it
keeps the FMP listed gap instead.

Two delivery-layer safeguards (added after inspecting received messages, not
compose output): the Compose + Send shell encodes `=` as `&#61;` inside every
href/src so Gmail's quoted-printable transfer encoding can never consume
`=hex` pairs in URLs (verified end-to-end by fetching the delivered message);
and the 03:50 premarket watch checks each name's catalyst headlines for
drop/reversal/offering language — flagged names are excluded from the subject
line and tagged **[AH reversal reported]** instead of being presented as clean
gainers (prior-close move data cannot see after-hours reversals in phase 1,
but the headline text can).

## Scheduling gate (verified 2026-07-03)

Production fires are fail-closed: unknown execution modes are treated as
production and must pass weekday + holiday + ±20-min ET window + run_log
dedupe. A pinned-data production simulation on the observed Independence Day
holiday was rejected on three independent grounds (holiday, window, mode).
Manual runs always proceed (explicit human action = test send).

## Credentials in use

FMP API (query auth) · Finnhub API (query auth) · Polygon API (query auth) ·
Gmail OAuth2 · Anthropic API. Keys live only in n8n Cloud credentials, never
in this repo.
