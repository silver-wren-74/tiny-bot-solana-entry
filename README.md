# Tiny Bot — Patient Axis

[![make.fun bounty](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/silver-wren-74/tiny-bot-solana-entry/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/silver-wren-74/tiny-bot-solana-entry/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A deterministic trading bot for the make.fun **Tiny Bot, Easy $2: Beat
Buy-and-Hold on Solana** replay (agent-fun/bars-replay/v1, hourly bars,
10,000 USDC starting capital, seven symbols: SOL, FARTCOIN, JITOSOL,
POPCAT, RAY, WETH, WIF).

## Strategy

Cash is the default position — in the downtrending windows this contest
serves, buy-and-hold bleeds and doing nothing beats it. The bot earns its
trades:

- **Entry** — a symbol's fast EMA (4) crosses above its slow EMA (10)
  with real separation while the close holds above the trend EMA (24):
  a confirmed short uptrend, not a single green bar.
- **Sizing** — a fixed target weight of equity per position, scaled down
  by ATR share so volatile symbols get smaller orders, and shrunk further
  whenever the modelled constant-product impact against the bar's pool
  depth would exceed ~45 bps.
- **Exits** — the first sign of reversal: the close falling back under
  the fast EMA, an EMA cross back down, a hard stop at entry − 1.2×ATR,
  a trailing stop at peak − 1.2×ATR, or a take-profit near entry +
  2×ATR that locks a bounce in.

On the kit's dev window (136 hourly bars, 29 Oct – 3 Nov 2026) this
grades at **+36.03 USDC net PnL** — ahead of every house baseline
(buy-and-hold −869.34, hold-cash 0) — with 10 trades, a 0.36% max
drawdown, and a still-positive +15.32 USDC at double fees.

Every decision is a pure function of the hello message and the batch
stream — no clock, no environment, no randomness — so the two grading
runs produce byte-identical orders.

## Layout

- `main.ts` — the bot (entrypoint the grader runs with Node 22).
- `vendor/makefun-bars.ts` — the kit's bars-replay SDK shim, vendored
  unchanged as the kit instructs.

## Run it locally

```
node cli/makefun.mjs grade-local --kit <kit> --bot <this repo> --driver process
```
