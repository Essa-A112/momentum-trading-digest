# Trading intelligence emails — n8n Cloud

Automated trading-intelligence emails per [PRD](./ARCHITECTURE.md#1-audit-of-the-existing-n8n-instance)
(see `ARCHITECTURE.md` for the audit and approved design). Phase 1: free API
tiers, four scheduled emails per US trading weekday, zero manual triggering.

**Status: 07:50 Premarket Brief built and in test. 03:50 / 09:20 / 16:10 to follow** —
per the build plan, one working email before the next.

## Workflows on the n8n instance

| Workflow | ID | Role |
|---|---|---|
| `TRADE 07:50 – Premarket Brief` | `d6zBGWsfGGM1fHWU` | Main orchestrator (first email) |
| `TRADE SUB – Market Gate` | `NuHBi32ah5TlEGI5` | Weekday + holiday/half-day check, ET slot window, run_log dedupe |
| `TRADE SUB – Fetch Movers` | `60zaDamifwOEu5JX` | FMP gainers → universe filter → Finnhub quote + metric |
| `TRADE SUB – Compute Levels` | `E3IcSgGjmmLrKDaZ` | Deterministic trigger/confirm/range/invalidation + OHLC series |
| `TRADE SUB – Grade Candidate` | `omcQfCxd6DcZ61Vh` | Anthropic 5-factor 0–2 scoring → A/B/C in code |
| `TRADE SUB – Render Charts` | `qqxEavKPwuZAUMGM` | QuickChart candlesticks with level annotations |
| `TRADE SUB – News Since` | `E8aPRgsyBbq1tRFA` | Finnhub news, window filter, Anthropic classification |
| `TRADE SUB – Compose + Send` | `wnj6cIAXy3HWXyUE` | Email shell, per-section degradation, Gmail, run_log |
| `ZZ Probe – API checks (temp)` | `q259zw78c3J9djOQ` | Endpoint verification scratchpad — safe to delete |

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
- **OHLC history (daily + 30-min intraday incl. premarket)**: pending a free
  **Polygon.io** API key (5 calls/min free tier covers all US tickers and is
  the PRD's phase-2 vendor — the paid upgrade is just a key swap). Until the
  key exists, levels degrade to quote-only derivation (trigger = premarket
  high from Finnhub quote, confirm = snapped prior close, range = +20% open
  cap) and charts are suppressed.

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

Anthropic scores five factors 0–2 (catalyst, RVOL, float/liquidity fit, level
structure, dilution) with one-line reasons; code validates the JSON, sums, and
maps 8–10→A, 6–7→B, <6→C (mention only). Catalyst 0 with RVOL <2 is capped at
C. LLM failure degrades to C mention-only — the email still sends.

## Credentials in use

FMP API (query auth) · Finnhub API (query auth) · Gmail OAuth2 ·
Anthropic API. Keys live only in n8n Cloud credentials, never in this repo.
