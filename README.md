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

## The trading clock (adopted 13 Jul — "Arabian days")

The user's trading day begins at the prior 16:00 close: after-hours is the
opening session of the NEXT day, then the overnight gap, premarket, and the
regular session close the day at 16:00. Every email shows the **current day**
under this clock; anything from an earlier day is explicitly labeled prior.
Concretely, at 03:50 Thursday: "current day" = Wednesday 16:00 → Thursday
16:00, and the "prior US session" = Wednesday's regular hours + Wednesday's
premarket + **Tuesday-evening** after-hours (the AH that opened Wednesday).

## 03:50 Overnight Brief — what it does (and deliberately doesn't)

Sections: **Prior US session** — indices, sector rotation, then three
separate gainer lists for the day that just closed: regular hours 9:30–16:00
(FMP top gainers/losers with linked attribution), premarket 4:00–9:30 (bar-
computed vs the prior close), and the after-hours of the evening before
16:00–20:00 (bar-computed); **Overnight tape** (Nikkei/Hang Seng/FTSE/DAX via
FMP, BTC via Finnhub as risk proxy, treasury 2Y/10Y/2s10s — labeled proxies);
**After-hours movers — current day** (see below); today's earnings + IPO
calendars; long book; congressional placeholder; overnight news since 16:10;
positions. No cards, no grades, no table writes — the 03:50 email is context,
not calls.

**After-hours movers — current day:** the overnight watch list = the
16:00–20:00 ET session that opened the current trading day (the market is
closed 20:00–4:00, so at 03:50 this is the complete session). A scan universe
(top ~15 FMP regular-session gainers ∪ small-cap gappers ∪ after-the-bell
earnings reporters ∪ overnight news names, capped at 22) is priced off one
Polygon 5-min fetch spanning the last two trading days — that single fetch
also feeds the prior-premarket and prior-evening-AH lists above. Gainers ≥3%
rank into the watch table (AH volume, scan reason, linked catalyst);
decliners ≤−3% print as an AH-reversal line. Names only, not suggestions;
nothing in this email is labeled premarket (premarket opens 04:00, after the
pull).

## Premarket candidate source — Polygon plan reality (revised 9 Jul)

The 07:50 and 09:20 workflows source candidates from **Fetch Movers** (FMP
biggest-gainers → universe filter → Finnhub live quote + metric → gap
re-filter). A `TRADE SUB – Premarket Scan` was built to enrich those names with
Polygon same-day 5-minute bars, but **the Polygon key on this account is
effectively free-tier**: the snapshot endpoints 403 (`NOT_AUTHORIZED`) and,
critically, same-day/recent intraday aggregates 403 with *"Your plan doesn't
include this data timeframe"*. So there is no live premarket bar data at all —
the scan sub degraded every candidate to its FMP fallback and, worse, starved
grading. 07:50 and 09:20 were repointed back to Fetch Movers, which gets the
**live gap and premarket high/low from the Finnhub quote** (`h`/`l`/`c`/`pc`,
all symbols, no entitlement wall). PM-volume/RVOL columns render "—" with a
footnote — they need the intraday bars the plan lacks. (Prior-day intraday
*is* allowed once it's >15 min old, which is why the 03:50 after-hours section
still works.)

**Stale-levels fix (the big one, 9 Jul).** Because Compute Levels could not see
today's premarket (same-day bars 403), the breakout trigger fell back to
*yesterday's* high. For an overnight gapper that is far below the current
price, so 09:20 was suggesting entries at levels the stock had already blown
through by $4–5 — effectively yesterday's plan. Two-part fix: (a) Compute
Levels now blends the **live Finnhub premarket high/low** (passed by the
caller) into the trigger/confirm whenever bars lack today's premarket, tagged
`dataQuality: bars+quote-pm`, so the trigger tracks today's actual premarket
range; and (b) a hard guard in the 07:50/09:20 compose — if last price is
already **more than 3% above the trigger**, the card is dropped from the
suggested set and flagged **STALE LEVELS — do not chase** (mirrors the
below-confirm INVALIDATED guard). A setup is only suggested when price sits
between confirm and trigger, where the plan is still actionable.

Grading was also hardened: the Anthropic response was truncating mid-JSON
(extended-thinking tokens ate the budget) and returning U/ungradeable, which
the compose reads as "data unavailable" — the model token cap was raised so
real candidates grade instead of failing.

Card rules: a card below its confirm level is excluded and carries an amber
INVALIDATED banner; the 07:50 cards read like a curated daily watchlist
(ticker + linked catalyst headline, "worth watching if price breaks above X
and confirms above Y", range, chart pair) while 09:20 stays specific to
gainers at the open. Factor reason lines print once per stock — on the card
only; the gap list carries just the grade. Deliberate open limitation:
premarket-only gappers with no prior-session move are invisible to FMP's list,
and a true market-wide premarket movers feed needs a paid Polygon snapshot
entitlement.

## Current-day windows per email (13 Jul)

- **07:50** — gap list titled *"Premarket gainers (4:00–07:50 ET, today)"*:
  today's premarket gap vs prior close from live quotes. Cards as above.
- **09:20** — leads with *"Premarket gainers (4:00–09:20 ET, today)"*; the
  premarket-recap-vs-07:50 section was removed (it re-showed earlier data);
  then the A-list into the open, avoid list, swing watch, news.
- **16:10** — Day recap's mover lists are titled *"Regular hours top
  gainers/losers (9:30–16:00 ET, today)"*. **Scorecard** grades today's 07:50
  and 09:20 calls, resolved from the live quote's day high/low (same-day
  intraday bars are plan-blocked; the footer notes that "reached" outcomes
  are optimistic on ordering) — the old bar-based resolver returned
  "unresolved" for everything on this plan. New **"First 10 minutes of
  after-hours — top gainers (16:00–16:10 ET, today)"** board: last live print
  (~16:10) vs the frozen close on today's gainers list, gainer universe only.
  The swing section opens with an *Into premarket* line flagging each
  suggested name's first-10-min AH move — holders/extenders are the likeliest
  overnight continuations.

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
