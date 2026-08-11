# Copy-Trading Consensus Backtest — 2026-08-11

**Question:** Can you profit by copying Solana "smart money" wallets — especially when
*multiple* top wallets buy the same token (consensus)?

**Data (all free/public):** GMGN `smart_degen` leaderboard (top 60 wallets) → each wallet's
parsed buy feed via `/api/v1/wallet_activity/sol` → forward prices via `/api/v1/token_kline/sol`.
530 buys, 202 tokens, ~13 days of history. 11 tokens had ≥3 distinct smart buyers (consensus),
35 had ≥2.

**Method:** For each token, mark the moment the Kth distinct smart wallet bought (consensus =
3rd). Enter at that price (and again 15 min later to model copy latency). Measure forward return
from GMGN 15-min candles.

## Results — forward return after the buy signal

| Group | +1h median | +1h win rate | +1h (15-min-delayed entry) |
|---|---|---|---|
| **Consensus (≥3 buyers)** | **−38.3%** | 17% | −22.3% |
| 2 buyers | −7.9% | 25% | −0.7% |
| Single buyer | −28.2% | 10% | −4.6% |
| 2-buyer / single at +4h | −68% / −37% | 0% / 24% | — |

**Mechanism check:** entering at the **1st** smart buyer (early) → +4h median **−4.2%**, vs
entering at **consensus** → deeply negative. The smart money is early; by the time consensus is
detectable, you're buying the top.

## Verdict
**Copying loses — and consensus makes it worse, not better.** Consensus tokens fell ~38% in the
hour after the 3rd wallet bought (win rate 17%). Every group at every horizon was negative before
fees/slippage. Reason: **latency + adverse selection** — the copier is the exit liquidity. The
only entry that wasn't a disaster was being *first*, which is a latency race for bots, not a
retail copier.

**Caveats:** small samples (n=4–16 per cell), one ~13-day window, one wallet tag, 15-min candle
precision, no slippage modeled (would make it worse). Effect size is large and mechanistically
consistent, so a bigger sample is very unlikely to flip the sign.
