# "Do the Opposite" — Fading Smart-Money Buys — 2026-08-11

**Idea:** copying smart-money buys loses (they buy tops that dump), so *short* the token when a
smart wallet buys it. Same data pipeline (GMGN wallet_activity + token_kline). Short at the buy
signal, cover at +4h. Fee 1% round-trip. Also tested with a 30% stop-loss on the short.

## Results — short return, +4h, 112 tokens

| Variant | Median | **Mean** | Win rate | Best | **Worst** |
|---|---|---|---|---|---|
| Short, **naked** | +33.1% | +23.4% | 74% | +99% | **−527%** |
| Short, **30% stop** | +11.2% | +22.8% | 62% | +99% | **−31%** |

- The fade is **positive on the mean, not just the median** — it survives the fat right tail of
  pumps. Smart-money buys mean-revert *down*.
- **Naked shorts have the catastrophic tail** (−527% = a token that ~6x'd). A 30% stop caps the
  worst case at −31% while keeping essentially all the edge (mean +22.8% vs +23.4%). This is the
  headline: the stop tames the disaster without killing the profit.

## The asterisks (why this is NOT a money printer)
1. **You cannot short these tokens.** No borrow market for random Solana memecoins; Jupiter Perps
   only covers majors (SOL/BTC/ETH), which is not where smart-money memecoin buying happens. The
   result is a paper edge with **no real execution path.**
2. **One ~13-day window** in a generally bearish memecoin tape — "short recently-pumped memecoins"
   benefits from the broad memecoin death spiral; could flip in a mania.
3. **Frictions undermodeled** — real short borrow (if it existed) + slippage on illiquid tokens
   would be brutal; 1% round-trip is fantasy for these. Stops can gap through in fast pumps.

## The actually-usable takeaway
The signal is real and it's a **negative** one: **smart money piling into a memecoin is a
SELL / take-profit / avoid signal, not a buy.** If you already hold a token and see smart wallets
buying in, that's your cue to trim — not to add. That's executable; the short itself mostly isn't.
