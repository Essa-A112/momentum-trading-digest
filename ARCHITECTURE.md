# Trading intelligence emails — audit & proposed architecture

Status: **proposed, awaiting approval** (PRD process step 2).
Scope: Phase 1 only — free API tiers, four scheduled emails, zero manual triggering.

---

## 1. Audit of the existing n8n instance

### What exists

Four workflows, all currently **inactive** (never published), all clones of the same
9-node chain:

| Workflow | ID | Cron (Europe/London) |
|---|---|---|
| Momentum – Premarket watchlist (09:00 BST) | `VMOjmU9pWyjSjLA9` | `0 9 * * 1-5` |
| Momentum – Premarket watchlist (pre-trade) (13:00 BST) | `yM6rSp3VoyJq0DAe` | `0 13 * * 1-5` |
| Momentum – Final premarket brief (14:15 BST) | `YmDhsCW3nNmtboaH` | `15 14 * * 1-5` |
| Momentum – Evening debrief (21:00 BST) | `K1sTXNcGOuwwrj1j` | `0 21 * * 1-5` |

Shared chain:

```
Schedule → Get FMP Movers (stable/biggest-gainers)
        → Extract Candidates (Code, top 25)
        → Get Quote (Finnhub /quote, fan-out per symbol)
        → Filter Gappers (Code: gap ≥5%, $2–$20, top 10, itemMatching pairing)
        → Has Gappers? (If)
            ├─ yes → Get News (Finnhub /company-news per symbol) → Build Watchlist Email (Code/HTML) → Gmail
            └─ no  → Build Stay Flat Email → Gmail
```

Credentials (all working, verified via 13 successful executions, latest 2026-07-01):

- `FMP API` (httpQueryAuth, id `4mNxc8K46RxnI2R4`)
- `Finnhub API` (httpQueryAuth, id `6TgkolgZTg2bJpVS`)
- `Gmail account` (gmailOAuth2, id `kE4wzZFGzf5rllCt`) → sends to essaabikar12@gmail.com

### Discrepancies vs the brief

1. **No Anthropic anywhere.** No credential, no LLM node in any workflow. "Catalyst"
   today is the raw first Finnhub headline. An **Anthropic API credential must be added
   in the n8n UI** (MCP cannot create credentials) before grading/classification can be built.
2. **Timezone is Europe/London** — exactly the DST-drift problem the PRD forbids.
3. **No data tables exist** — no context store, so no "since the last email", no scorecard.
4. Repo exports are stale (README/JSON reference Alpha Vantage; live workflows use FMP).
5. The FMP gainers list is polluted with leveraged ETFs (2x Long MSTR/META/PLTR etc.) —
   the universe filter must exclude ETFs/funds/warrants/units.
6. No holiday check, no levels, no grading, no charts, no congress tracking, no long book.

### Reusable / modified / new

**Reusable as-is (proven patterns):**
- Gmail send node config + credential.
- FMP `biggest-gainers` HTTP node + query-auth credential.
- Finnhub `/quote` and `/company-news` per-item fan-out with `itemMatching()` pairing.
- The If-branch degraded-email pattern ("stay flat" fallback) — generalises to
  per-section degradation.
- `onError: continueRegularOutput` on every HTTP node.
- Hard constraint that shaped these workflows and still applies: **n8n Cloud's Code node
  sandbox blocks network calls** — all fetches must be HTTP Request nodes, Code nodes
  are transform-only.

**Modified:**
- Schedules → four ET slots, workflow timezone `America/New_York`.
- Universe filter → PRD day-trade rules (gap >10%, $1–$20, ETF exclusion) + new swing
  and long-term screens.
- Email builder → sectioned HTML with suggestion cards, charts, standard risk footer.

**New (nothing exists today):**
- Market-day gate (holiday/half-day check at top of every run).
- Context store (7 data tables, schema below).
- Deterministic level-derivation engine.
- Anthropic catalyst classification + 5-factor grading.
- QuickChart chart rendering (intraday + daily, annotated levels).
- SEC EDGAR dilution check.
- Congressional trade tracking (source risk — see §4).
- Scorecard resolution in the close report.
- Long book with thesis re-grading.
- Overnight tape + calendars.

**Fate of the old four:** leave inactive during the build; archive once the new system
has run clean for a few days. (The 13:00 BST "pre-trade" workflow is the closest
ancestor of the new 07:50 ET brief.)

---

## 2. Proposed architecture

### Main workflows (thin orchestrators, one per email)

All with workflow timezone `America/New_York`, weekday crons:

| Workflow | Cron (ET) |
|---|---|
| `TRADE 03:50 – Overnight Brief` | `50 3 * * 1-5` |
| `TRADE 07:50 – Premarket Brief` | `50 7 * * 1-5` |
| `TRADE 09:20 – Open Plan` | `20 9 * * 1-5` |
| `TRADE 16:10 – Close Report` | `10 16 * * 1-5` |

Shape of every main workflow:

```
Schedule (ET)
 → SUB Market Gate ──(closed/holiday/half-day → end, no send)
 → section fetch branches (each HTTP node onError: continue)
 → candidate pipeline: SUB Fetch Movers → SUB Compute Levels → SUB Grade → SUB Render Charts
 → compose sections (Code; a failed branch renders "data unavailable")
 → SUB Compose+Send (Gmail) → run_log write
```

### Shared sub-workflows (Execute Workflow trigger)

1. **`SUB Market Gate`** — Finnhub `/stock/market-holiday` (cached 24h in `api_cache`);
   returns `{isTradingDay, isHalfDay, dateET}`. Per PRD: exit early on holidays **and**
   half days.
2. **`SUB Fetch Movers`** — FMP biggest-gainers (+losers where the email needs them) →
   Code filter (exclude ETF/fund/warrant/unit by name+exchange heuristics, price band,
   gap threshold per strategy) → Finnhub `/quote` fan-out → FMP `/profile` for float,
   shares out, market cap, avg volume (**cache-miss only**, profiles cached 7 days).
3. **`SUB Compute Levels`** — fetches FMP daily EOD history (~1y) + FMP 30-min intraday
   (both cached per symbol per day), then one Code node computes, exactly per PRD:
   - *Trigger* = premarket high, or most recent regular-session HOD if higher.
   - *Confirm* = nearest prior reclaimed resistance below trigger, snapped to $0.50/$1.00
     when within 2%.
   - *Range* = nearest daily anchor above trigger, priority: daily 200MA → gap-down
     origin → multi-day consolidation shelf; `+` suffix when no resistance within +20%.
   - *Invalidation* = confirm.
   Returns the numbers, the anchor label, and the OHLC series (reused by charts —
   no double fetch). **The LLM never touches these numbers.**
4. **`SUB Grade`** — builds a fact block (catalyst headlines, computed RVOL, float,
   EDGAR filing hits, level-structure stats) → Anthropic (temperature 0, strict JSON
   output) scores the five PRD factors 0–2 with one-line reasons and writes the context
   line + risk notes → Code validates the JSON, sums the score, maps 8–10=A / 6–7=B /
   <6=C. C = mention only, never a card.
5. **`SUB Render Charts`** — two QuickChart `POST /chart/create` calls per card
   (chart.js financial plugin): intraday 30-min last 3–5 sessions with VWAP + EMA
   9/20/50; daily ~6 months with MA 20/50/200. Both annotated with trigger line,
   confirm line in red, range-target line, and a shaded supply-zone box between confirm
   and trigger. No arrows, no drawn paths. Returns short URLs for `<img>` embeds.
6. **`SUB News Since`** — Finnhub general + company news for watchlist/holds, dedupe
   against `news_log` (URL hash), Anthropic classifies new items (macro / stock /
   political, affected tickers — presidential statements tagged here), writes
   `news_log`, returns only items newer than the previous slot's send.
7. **`SUB Compose+Send`** — takes `[{title, html, ok}]` sections + subject slot, wraps
   the standard shell (header, risk-rules footer: 1% risk, 2:1 min R/R, mental stop
   before entry, stop at -3R), renders `ok:false` sections as "data unavailable",
   sends via Gmail, writes `run_log`.

### Context store (n8n data tables)

| Table | Columns (sketch) | Purpose |
|---|---|---|
| `api_cache` | key, payload(JSON string), expiresAt | FMP 250/day budget protection |
| `watchlist` | dateET, slot, symbol, gapPct, price, pmHigh, pmLow, pmVol, float, catalystHeadline, catalystType, status | today's names, carried across slots |
| `calls` | callId, dateET, slot, strategy, symbol, trigger, confirm, rangeLow, rangeHigh, rangeAnchor, grade, scores(JSON), contextLine, riskNotes, chartUrls, outcome, resolvedAt | every graded card; the scorecard reads this |
| `news_log` | ts, headline, url, source, tickers, tag, summary, firstSeenSlot | "since the last email" |
| `long_book` | symbol, thesis, invalidation, tranches(JSON), status, lastGrade, lastRegradeAt, notes | long-term positions |
| `congress_trades` | filedAt, txDate, member, chamber, ticker, side, amountRange, notable, includedInEmail | daily check + Friday digest |
| `run_log` | dateET, slot, sentAt, ok, degradedSections | PoC reliability metric |

### Scorecard (16:10)

For each `calls` row from today's 07:50/09:20 with outcome `pending`: fetch the day's
intraday bars (already cached for charts), determine — trigger broken? half range
reached? full range? confirm lost after trigger? → grade the call
(`no_trigger / triggered / reached_half / reached_full / failed`), write back, render
the table with per-grade hit rates (A vs B separation).

### FMP call budget (250/day)

movers 4 · profiles ~10 (cache misses only) · daily OHLC ~8 · intraday ~8 ·
calendars 3 · treasury/market 2 → **~35 typical, <80 worst case**. 3x headroom.

### Free-tier realities (stated, not hidden)

- **Overnight tape** uses proxies: SPY/QQQ (futures), UUP (dollar), USO (oil),
  Finnhub `BINANCE:BTCUSDT` (bitcoin). 10-year yield via FMP treasury endpoint if
  free tier allows, else the line degrades. Asia/Europe via FMP index quotes if
  free tier allows, else ETF proxies with a "prior close" label. Every proxy is
  labelled as such in the email.
- **Premarket micro-cap coverage is thin** on free tiers (PRD accepts this; the
  scorecard is how we find out if it matters).

---

## 3. LLM usage (Anthropic)

- Model: `claude-sonnet-5`, temperature 0, JSON-schema-constrained outputs.
- The LLM: classifies catalysts, scores the five grading factors 0–2 with one-line
  reasons, writes card context lines and risk notes, tags news, re-grades long-book
  theses. The LLM never: picks trigger/confirm/range numbers, invents causes (it is
  instructed to output "no clear catalyst" when none is identifiable).
- **Blocker: an Anthropic API credential must be created in the n8n Cloud UI by the
  account owner.** Everything else can be built around it; grading nodes will be wired
  to the credential name once it exists.

## 4. Congressional data (highest-risk source)

Verified 2026-07-02: the Senate/House Stock Watcher S3 buckets return `AccessDenied` —
the free feeds named in the PRD are dead (House confirmed inaccessible since early
2026; the GitHub repo survives but the hosted feed does not).

- Plan A: `senate-stock-watcher-data` GitHub raw JSON (Senate only) — check freshness
  at build time.
- Plan B: Lambda Finance free REST API (dual chamber, normalized records) — verify
  signup/limits at build time.
- Plan C: the section degrades to "data unavailable" — the email still sends.

Built last (close-report iteration), consistent with "expect gaps and lag".

## 5. Open PRD question 2 — long book ownership

Per the PRD's own recommendation: **the user picks long-term positions; the system only
tracks and re-grades.** Emails still surface long-term *candidates* when the screen
fires, but nothing enters `long_book` unless the user adds the row (n8n data table UI
to start; a small entry form workflow can come later).

## 6. Build order (PRD process steps 3–4)

1. **07:50 Premarket Brief end-to-end** (hardest: gate, movers, news-since, levels,
   grade, charts, compose, store) → test send → iterate card/chart format to PRD.
2. **09:20 Open Plan** (adds premarket recap from `watchlist`, avoid list, EDGAR
   dilution, swing watch).
3. **16:10 Close Report** (adds scorecard, after-hours first-10-min, swing/overnight
   cards, long book notes, Friday congress digest + weekly thesis re-grade).
4. **03:50 Overnight Brief** (adds overnight tape, calendars, daily congress check,
   premarket watch).

Deferred to build-time verification via n8n test executions (this dev sandbox has no
API keys and its egress proxy blocks QuickChart): FMP free-tier access to
`historical-chart/30min`, EOD history, calendars, treasury; QuickChart `/chart/create`;
Finnhub `market-holiday`; congress feed freshness.

Each build step is committed to this repo (SDK source + notes) so the repo stops
drifting from the instance.
