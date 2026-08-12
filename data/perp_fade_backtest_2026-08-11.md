# Executable Fade on Perp-Listed Tokens — 2026-08-11

**Goal:** the fade (short smart-money buys) was +EV but unshortable on fresh memecoins. Test
whether it works on tokens you *can* short (perp-listed), so there's a real execution path.

## Finding 1 — the smart-money signal barely reaches shortable assets
Of 184 tokens the smart-money wallets bought, only **2** (ADA, RAY; 3 buys total) have perps.
The top-bought are all fresh pump.fun tokens (MARIO64, MIM, KINGLON, SPED…) with no perp market.
Perps get listed on *established* tokens; the fade edge lives in *fresh* ones. **No overlap → the
smart-money fade cannot be executed on perps.**

## Finding 2 — the *mechanism* (fade pumps) also fails on perp memecoins
Tested price-based "fade the pump" (short after a sharp rise, 25% stop) on 8 perp-listed
memecoins (WIF, BONK, PENGU, FARTCOIN, AI16Z, BOME, POPCAT, GOAT), 14 days hourly from CoinGecko.
Baseline (short any random hour): mean **−0.48%**, 45% win.

| Lookback | Pump ≥ | n | Fade-short mean | Win |
|---|---|---|---|---|
| 3h | 5% | 17 | −0.7% | 59% |
| 4h | 5% | 21 | −0.6% | 71% |
| 4h | 8% | 8 | −2.1% | 63% |
| 2–4h | 12–18% | 1–2 | "+4 to +8%" | 100% (noise) |

Where the sample is real, fading is **breakeven-to-negative — no better than random shorting.**
The only positive cells have n=1–2 (meaningless). Established perp tokens don't have the violent
pump-and-dump reversion that the fresh-memecoin edge feeds on; the basket was ~flat (+8%/14d).

## Verdict
**There is no executable, profitable version of the fade.** The edge is real but lives entirely
in fresh, illiquid, un-shortable memecoins. On the liquid tokens you *can* short, the market is
efficient enough that the edge is gone. Classic **limits to arbitrage**: the mispricing survives
precisely *because* it isn't arbitrageable.

Caveats: small basket (8), 14 days, hourly, one regime — but the direction (edge vanishes on
shortable tokens) is exactly what theory predicts and is consistent across the whole sweep.
