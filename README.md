# Momentum Trading Digest — n8n Cloud workflows

Three scheduled email digests for US small-cap momentum day trading, built for **n8n Cloud**.

| Workflow | File | Schedule (BST) | Cron |
|---|---|---|---|
| Premarket watchlist | `workflows/premarket-watchlist.json` | 12:00 | `0 12 * * 1-5` |
| Final premarket brief | `workflows/final-premarket-brief.json` | 14:15 | `15 14 * * 1-5` |
| Evening debrief + after-hours | `workflows/evening-debrief.json` | 21:00 | `0 21 * * 1-5` |

## Why these workflows look the way they do

n8n Cloud runs the **Code** node in a sandbox that blocks outbound network
calls (`this.helpers.httpRequest` is not available there, unlike
self-hosted n8n with `NODE_FUNCTION_ALLOW_EXTERNAL` set). So all external
HTTP calls are done by dedicated **HTTP Request** nodes; **Code** nodes are
used only for filtering/formatting, with no network access.

Each workflow is the same 8-node chain:

```
Schedule
  → Get AV movers        (HTTP Request: Alpha Vantage TOP_GAINERS_LOSERS)
  → Extract candidates    (Code: parse tickers, no network)
  → Get quote             (HTTP Request: Finnhub /quote, runs once per candidate)
  → Filter gappers        (Code: gap ≥5%, $2–$20, top 10, no network)
  → Get news               (HTTP Request: Finnhub /company-news, runs once per survivor)
  → Build email            (Code: HTML table, no network)
  → Send email              (Gmail)
```

HTTP Request nodes connected after a Code node that emits N items
automatically run once per item in n8n — that's how the per-symbol quote
and news lookups are done without any network code in the Code node.
Symbol pairing across hops uses n8n's built-in `itemMatching()` /
`pairedItem` item-linking rather than re-fetching or guessing by array
index.

## 1. API keys

- **Finnhub**: https://finnhub.io → Sign Up (free tier) → your key is shown
  on the dashboard immediately. Used for `/quote` and `/company-news`.
- **Alpha Vantage**: https://www.alphavantage.co/support/#api-key → enter
  email → key is issued instantly. Used for `TOP_GAINERS_LOSERS`. Free tier
  is rate-limited (25 req/day, 5/min) — this workflow makes exactly 1 AV
  call per run, so 3 runs/day on weekdays stays well within that.

**Keys are never committed to this repo.** They're entered directly into
n8n Cloud credentials (next section).

## 2. Set up credentials in n8n Cloud

n8n Cloud doesn't expose the public REST API on most plans (API access is
an Enterprise-tier feature), and Gmail OAuth2 can only be created through
the browser consent flow anyway — so credentials and workflow import both
go through the **n8n Cloud UI**, not the API.

In n8n Cloud → **Credentials → Add Credential**:

1. **Finnhub API** — type **Query Auth**. Name field: `token`. Value field:
   your Finnhub key.
2. **Alpha Vantage API** — type **Query Auth**. Name field: `apikey`.
   Value field: your Alpha Vantage key.
3. **Gmail account** — type **Gmail OAuth2 API**. Click the link in n8n's
   credential form to create a Google Cloud OAuth client (or use n8n's
   built-in OAuth helper if your plan includes it), then complete the
   Google consent screen to authorize n8n to send mail as you.

## 3. Import the workflows

For each file in `workflows/`:

1. n8n Cloud → **Workflows → Add Workflow → Import from File**.
2. Open the imported workflow. On **Get AV movers**, **Get quote**, and
   **Get news**, set the credential dropdown to the matching Query Auth
   credential created above. On **Send email**, set the credential
   dropdown to your Gmail OAuth2 credential.
3. On **Send email**, replace `YOU@EXAMPLE.COM` in the **To** field with
   your real address.
4. Leave the workflow **inactive** until it's been tested (see below).

## 4. Test before activating

Test `premarket-watchlist.json` first:

1. Open it in the n8n editor.
2. Click **Execute Workflow** (manual run) — this runs the full chain
   immediately regardless of the schedule.
3. Check each node's output panel in order: AV movers returns a ticker
   list → quotes come back with `c`/`pc` fields → Filter gappers produces
   0–10 rows → news returns headlines → Build email produces `subject` +
   `html`.
4. Confirm the email actually arrives in your inbox and the HTML table
   renders correctly (not as a giant string).
5. Only after that passes, activate all three workflows (toggle **Active**
   on each).

## Tunable filters

Inside the **Filter gappers** Code node of each workflow:

```js
const MIN_GAP     = 5;    // minimum gap % vs previous close
const PRICE_MIN   = 2;
const PRICE_MAX   = 20;
const MAX_RESULTS = 10;
```
