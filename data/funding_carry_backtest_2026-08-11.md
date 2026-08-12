# Funding-Rate Carry (delta-neutral) — 2026-08-11

**Strategy:** hold spot + short the perp = delta-neutral (price cancels), collect the funding fee
each hour (positive funding = longs pay you; negative = you pay). Data: Hyperliquid hourly funding,
104 days, 7 markets.

## Always-on carry (hold continuously), annualized net of one-time fees

| Market | Ann. net | % hours funding + | Max drawdown |
|---|---|---|---|
| HYPE | **+6.3%** | 83% | 0.08% |
| DOGE | +3.8% | 73% | 0.34% |
| ETH | +3.1% | 73% | 0.24% |
| BTC | +0.9% | 62% | 0.15% |
| SUI | −0.6% | 56% | 0.41% |
| SOL | −3.4% | 47% | 1.1% |
| WIF | −5.9% | 78% | 2.52% |
| **Diversified basket** | **+0.6%** | 69% | 0.42% |

## What we learned
- **It's the first genuinely positive-expectancy, delta-neutral, retail-executable strategy** in
  the whole investigation. Drawdowns are tiny (<1% for the good markets) — very low risk.
- **But this was a weak funding regime.** The basket netted only +0.6% (below T-bills), and
  SOL/SUI/WIF funding went *net negative* — funding is regime-dependent (it pays most in greedy
  markets when everyone's leveraged long; it can go negative in fear). Historically majors have
  yielded ~10–30% annualized in bull runs.
- **Timing the funding sign does NOT help.** A trailing-7d-funding filter whipsawed (BTC 19
  switches → −4%, SUI 27 → −6.6%); switch fees + signal lag killed it. The value is in *market
  selection*, not timing.
- **The edge concentrates in structurally-high-funding markets** (HYPE, DOGE, ETH here), not the
  broad basket.

## How to actually make it worthwhile
1. **Select** markets with persistently high positive funding (HYPE-like new/hot tokens), not the
   whole basket. → ~4–6% delta-neutral in this (weak) window.
2. **Accept it as a yield, not a lottery** — it's crypto's version of a bond coupon: modest,
   market-neutral, best in euphoric regimes.
3. **Modest leverage** (2–3x) is defensible given <0.3% drawdown → scales ~5% into ~10–15%, but
   adds perp-leg liquidation risk that must be actively margined.
4. Regime overlay: size up in greedy markets, stand down when funding compresses/inverts.

## Honest bottom line
Funding carry is **real and executable** — but it's a modest market-neutral *yield*, not alpha.
That's itself the answer to "is there easy money here?": no free lunch, but a small, real coupon
for providing liquidity to over-leveraged traders. Everything directional we tested was either
efficiently priced or locked behind a barrier we can't cross.

Caveats: 104-day window / one regime; funding P&L only (basis, exchange, and liquidation risk not
fully modeled); Hyperliquid funding is hourly (other venues 8h and differ).
