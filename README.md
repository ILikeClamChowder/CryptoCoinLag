# Slipstream — Crypto Lag Radar

A static web app that finds crypto coins **trailing the market leaders** (BTC / ETH / SOL) and
ranks them by how confident the lag is. Everything runs in the visitor's browser — no server,
no API key, no database.

## What it does

For each coin it pulls recent candles from Coinbase's public API, converts them to per-candle
returns, and slides the coin against each leader to find the time-offset where their moves line
up best. That offset is the **lag**; the sharpness of the match is the **confidence**.

- **Confidence is not raw correlation.** In crypto almost everything co-moves, so a plain
  correlation would rank the whole market at ~90%. Instead, confidence rewards a *sharp peak at a
  specific, non-zero lag* and discounts coins that just move with everything (a flat curve, or a
  peak at lag 0 = "coincident", not "lagging").
- **Modes:** *Leaders* (rank every coin by its best-fitting leader) or *All-pairs discovery*
  (test every coin against every other coin).
- **Timeframes:** 5-min, 15-min, 1-hour, 6-hour — each with its own lookback and lag range.

## Deploy to Cloudflare Pages (via GitHub)

1. Create a new GitHub repo and push these files (`index.html`, `style.css`, `app.js`).
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick the repo.
3. Build settings: **Framework preset: None**, **Build command: (leave blank)**,
   **Build output directory: `/`**. It's a plain static site — nothing to build.
4. Save & Deploy. Done.

## Customizing

Everything tunable lives in the `CONFIG` object at the top of `app.js`:

- `leaders` — the coins treated as market leaders.
- `candidates` — the coin universe. Add any Coinbase-listed symbol; anything not live is skipped
  automatically, so it's safe to paste in more.
- `timeframes` — granularity + lag range per option.
- `concurrency` / `pacingMs` — how hard it hits the API. Lower = gentler (Coinbase caps ~10 req/s).

## Reality check

This is a **pattern-research tool, not financial advice.** Lead-lag relationships in crypto are
real but unstable — one that shows up today often vanishes tomorrow, and the whole market is
tightly coupled. Treat the output as a starting point for investigation, never as a trade signal.

## Local preview

```bash
python -m http.server 8788
```

Then open http://localhost:8788 and click **Scan now**.
