# Momentum Trading Digest — n8n Cloud workflows

Four scheduled email digests for US small-cap momentum day trading, built for **n8n Cloud**.

| Workflow | File | Schedule (BST) | Cron |
|---|---|---|---|
| Premarket watchlist | `workflows/premarket-watchlist.json` | 09:00 | `0 9 * * 1-5` |
| Premarket watchlist (pre-trade) | `workflows/premarket-pretrade.json` | 13:00 | `0 13 * * 1-5` |
| Final premarket brief | `workflows/final-premarket-brief.json` | 14:15 | `15 14 * * 1-5` |
| Evening debrief + after-hours | `workflows/evening-debrief.json` | 21:00 | `0 21 * * 1-5` |

> **Status note:** the 09:00 workflow currently runs the same live-scan logic as
> the other three. This is scheduled to be reworked into an "overnight recap"
> that grades the previous evening's after-hours picks instead of running a
> live scan (09:00 BST = 04:00 ET, before genuine premarket volume exists, so
> a live scan at that hour structurally can't find real gappers). That rework,
> plus footer-text standardization on the 14:15/21:00 workflows and a Data
> Table write-back layer, is tracked as pending work — see below.

## Why these workflows look the way they do

n8n Cloud runs the **Code** node in a sandbox that blocks outbound network
calls (`this.helpers.httpRequest` is not available there, unlike
self-hosted n8n with `NODE_FUNCTION_ALLOW_EXTERNAL` set). So all external
HTTP calls are done by dedicated **HTTP Request** nodes; **Code** nodes are
used only for filtering/formatting, with no network access.

Each workflow is the same 10-node chain:

```
Schedule
  → Get FMP Movers        (HTTP Request: Financial Modeling Prep /stable/biggest-gainers)
  → Extract Candidates     (Code: parse tickers, no network)
  → Get Quote               (HTTP Request: Finnhub /quote, runs once per candidate)
  → Filter Gappers           (Code: gap ≥5%, $2–$20, top 10, no network)
  → Has Gappers?               (IF: routes on whether any gappers survived)
      true  → Get News           (HTTP Request: Finnhub /company-news, once per survivor)
              → Build Watchlist Email (Code: HTML table, no network)
      false → Build Stay Flat Email  (Code: HTML "stay flat" message, no network)
  → Send Email (Gmail, both branches converge here)
```

HTTP Request nodes connected after a Code node that emits N items
automatically run once per item in n8n — that's how the per-symbol quote
and news lookups are done without any network code in the Code node.
Symbol pairing across hops uses n8n's built-in `itemMatching()` /
`pairedItem` item-linking rather than re-fetching or guessing by array
index. The `Has Gappers?` IF node, combined with `alwaysOutputData: true`
on `Filter Gappers`, guarantees the email always sends — either a real
watchlist or a friendly "stay flat" message — never a blank/broken run.

## 1. API keys

- **Finnhub**: https://finnhub.io → Sign Up (free tier) → your key is shown
  on the dashboard immediately. Used for `/quote` and `/company-news`.
  Query param name: `token`.
- **Financial Modeling Prep (FMP)**: https://site.financialmodelingprep.com
  → sign up → generate an API key. Used for `/stable/biggest-gainers`.
  Query param name: `apikey`. Note: FMP retired its legacy `/api/v3/...`
  endpoints for accounts created after Aug 31, 2025 — always use the
  `/stable/` path.

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
2. **FMP API** — type **Query Auth**. Name field: `apikey`. Value field:
   your FMP key.
3. **Gmail account** — type **Gmail OAuth2 API**. Click the link in n8n's
   credential form to create a Google Cloud OAuth client (or use n8n's
   built-in OAuth helper if your plan includes it), then complete the
   Google consent screen to authorize n8n to send mail as you.

## 3. Import the workflows

For each file in `workflows/`:

1. n8n Cloud → **Workflows → Add Workflow → Import from File**.
2. Open the imported workflow. On **Get FMP Movers**, **Get Quote**, and
   **Get News**, set the credential dropdown to the matching Query Auth
   credential created above. On **Send Email**, set the credential
   dropdown to your Gmail OAuth2 credential.
3. On **Send Email**, replace `YOU@EXAMPLE.COM` in the **To** field with
   your real address.
4. Leave the workflow **inactive** until it's been tested (see below).

## 4. Test before activating

Test one workflow first (`premarket-pretrade.json` is a good starting
point — it runs during genuine premarket hours):

1. Open it in the n8n editor.
2. Click **Execute Workflow** (manual run) — this runs the full chain
   immediately regardless of the schedule.
3. Check each node's output panel in order: FMP movers returns a gainers
   array → quotes come back with `c`/`pc` fields → Filter Gappers produces
   0–10 rows → the IF node routes correctly → news returns headlines (or
   the stay-flat branch fires) → the email-build node produces `subject` +
   `html`.
4. Confirm the email actually arrives in your inbox and the HTML table
   renders correctly (not as a giant string).
5. Only after that passes, activate the workflow (toggle **Active**).

## Tunable filters

Inside the **Filter Gappers** Code node of each workflow:

```js
const MIN_GAP     = 5;    // minimum gap % vs previous close
const PRICE_MIN   = 2;
const PRICE_MAX   = 20;
const MAX_RESULTS = 10;
```

## Pending work (not yet in this repo)

- Rebuild the 09:00 workflow into an "overnight recap": read yesterday's
  after-hours picks from a Data Table, fetch current Finnhub quotes, and
  report hit/miss instead of running a live scan.
- Create the `afterhours_predictions` Data Table (`date`, `ticker`,
  `ref_price`, `predicted_level`, `gap_at_pick`) and wire a write-back step
  into the 21:00 workflow.
- Standardize footer text across the 14:15 and 21:00 workflows to match
  the 13:00 workflow's footer:
  > "Focus window 13:00–16:00 BST (flex ±30 min on volume) · catalyst
  > required · mental stop before entry · 1% risk · 2:1 R/R min · -3R
  > daily max."
