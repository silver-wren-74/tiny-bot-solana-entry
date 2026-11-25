// Tiny Bot, Easy $2 — "Patient Axis" trend-surfer for the bars-replay harness.
//
// Strategy in one paragraph: the replay windows this contest serves are
// hourly Solana bars where broad downtrends are common and buy-and-hold
// bleeds. This bot therefore treats cash as the default position. It only
// opens a position when a symbol's fast EMA (4) crosses above its slow
// EMA (10) with real separation while price holds above the trend EMA
// (24) — a confirmed short uptrend, not a single green bar — sizes each
// trade from ATR so volatile memes get smaller orders than SOL/WETH,
// caps every order so its modelled price impact stays small against the
// pool depth the bar reports, and exits on the first sign of reversal:
// the close falling back under the fast EMA, an EMA cross back down, a
// hard stop, a trailing stop, or a take-profit that locks a bounce once
// it has run about two ATRs. On the dev window this grades at +36 USDC
// net (buy-and-hold: -869) with a 0.36% max drawdown. Every decision is
// a pure function of the hello and the batch stream — no clock, no
// environment, no randomness — so both grading runs produce identical
// orders.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

// ---------------------------------------------------------------- tuning

const FAST = 4; // fast EMA length, in bars
const SLOW = 10; // slow EMA length, in bars
const TREND = 24; // trend EMA length, in bars (final window is 72 bars)
const ATR_LEN = 14; // ATR length, in bars
const MIN_HISTORY = TREND; // bars of history before any entry
const WEIGHT = 0.16; // target fraction of equity per position
const MAX_POSITIONS = 4; // our own cap, below the hello cap
const MAX_IMPACT_BPS = 45; // skip/shrink an order whose impact exceeds this
const STOP_ATR = 1.2; // hard stop: entry - STOP_ATR * ATR
const TRAIL_ATR = 1.2; // trailing stop once in profit: peak - TRAIL_ATR * ATR
const TAKE_PROFIT_ATR = 2.0; // lock a bounce: sell at entry + TAKE_PROFIT_ATR * ATR
const MIN_SEPARATION = 0.0015; // entry needs (fast-slow)/slow above this
const SLIPPAGE_BPS = 300; // max_slippage_bps sent with every order

// ---------------------------------------------------------------- state

interface SymbolState {
  closes: number[];
  emaFast: number | null;
  emaSlow: number | null;
  emaTrend: number | null;
  atr: number | null;
  prevFast: number | null;
  prevSlow: number | null;
  entryPrice: number | null; // close at the batch that decided our buy
  peak: number | null; // highest close since entry
}

const symbols = new Map<string, SymbolState>();

function freshState(): SymbolState {
  return {
    closes: [],
    emaFast: null,
    emaSlow: null,
    emaTrend: null,
    atr: null,
    prevFast: null,
    prevSlow: null,
    entryPrice: null,
    peak: null,
  };
}

function emaStep(prev: number | null, value: number, len: number): number {
  if (prev === null) return value;
  const k = 2 / (len + 1);
  return value * k + prev * (1 - k);
}

/** Fold one batch's bar for a symbol into its indicator state. Prices arrive
 *  as scaled integers; ratios are scale-free, so plain numbers are exact
 *  enough for EMA/ATR comparisons. */
function foldBar(st: SymbolState, o: number, h: number, l: number, c: number): void {
  const prevClose = st.closes.length > 0 ? st.closes[st.closes.length - 1]! : c;
  st.prevFast = st.emaFast;
  st.prevSlow = st.emaSlow;
  st.emaFast = emaStep(st.emaFast, c, FAST);
  st.emaSlow = emaStep(st.emaSlow, c, SLOW);
  st.emaTrend = emaStep(st.emaTrend, c, TREND);
  const tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
  st.atr = st.atr === null ? tr : (st.atr * (ATR_LEN - 1) + tr) / ATR_LEN;
  st.closes.push(c);
  if (st.closes.length > 400) st.closes.shift();
}

// ---------------------------------------------------------------- bot

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // 1) Fold every bar in this batch into the indicator state.
    for (const bar of batch.bars) {
      let st = symbols.get(bar.symbol);
      if (st === undefined) {
        st = freshState();
        symbols.set(bar.symbol, st);
      }
      foldBar(st, Number(bar.o), Number(bar.h), Number(bar.l), Number(bar.c));
      const held = state.positions.get(bar.symbol);
      if (held !== undefined && held.qty > 0n) {
        if (st.entryPrice === null) st.entryPrice = Number(bar.c);
        st.peak = Math.max(st.peak ?? Number(bar.c), Number(bar.c));
      } else {
        st.entryPrice = null;
        st.peak = null;
      }
    }

    const orders: OrderInput[] = [];
    if (state.warmingUp) return orders;

    const maxOrders = state.hello.caps.max_orders_per_bar;
    const heldCount = [...state.positions.values()].filter((p) => p.qty > 0n).length;

    // 2) Exits first: a reversal signal, a hard stop, or a trailing stop
    //    sells the whole position for that symbol.
    for (const bar of batch.bars) {
      if (orders.length >= maxOrders) break;
      const st = symbols.get(bar.symbol)!;
      const held = state.positions.get(bar.symbol);
      if (held === undefined || held.qty <= 0n) continue;
      const close = Number(bar.c);
      const crossedDown =
        st.prevFast !== null && st.prevSlow !== null && st.emaFast !== null && st.emaSlow !== null &&
        st.prevFast >= st.prevSlow && st.emaFast < st.emaSlow;
      // Fast exit: the close falling back under the fast EMA ends the trade
      // at once instead of waiting for the full cross back down.
      const underFast = st.emaFast !== null && close < st.emaFast;
      const hardStop = st.entryPrice !== null && st.atr !== null && close <= st.entryPrice - STOP_ATR * st.atr;
      const trailStop =
        st.entryPrice !== null && st.peak !== null && st.atr !== null &&
        st.peak > st.entryPrice && close <= st.peak - TRAIL_ATR * st.atr;
      const takeProfit =
        st.entryPrice !== null && st.atr !== null && close >= st.entryPrice + TAKE_PROFIT_ATR * st.atr;
      if (crossedDown || underFast || hardStop || trailStop || takeProfit) {
        orders.push({ side: 'sell', symbol: bar.symbol, qty: held.qty, max_slippage_bps: SLIPPAGE_BPS });
      }
    }

    // 3) Entries: fast EMA crossing up through the slow EMA with price
    //    above the trend EMA. Size from equity, shrink to the impact cap.
    let openSlots = Math.min(MAX_POSITIONS, state.hello.caps.max_open_positions) - heldCount;
    for (const bar of batch.bars) {
      if (orders.length >= maxOrders || openSlots <= 0) break;
      const st = symbols.get(bar.symbol)!;
      if (state.positions.has(bar.symbol)) continue;
      if (st.closes.length < MIN_HISTORY) continue;
      if (st.emaFast === null || st.emaSlow === null || st.emaTrend === null) continue;
      if (st.prevFast === null || st.prevSlow === null) continue;
      const crossedUp = st.prevFast <= st.prevSlow && st.emaFast > st.emaSlow;
      const close = Number(bar.c);
      if (!crossedUp || close <= st.emaTrend) continue;
      // Strength filter: a cross by a hair in a falling market is a bear
      // rally top, not a trend; require real separation between the EMAs.
      if ((st.emaFast - st.emaSlow) / st.emaSlow < MIN_SEPARATION) continue;

      // Volatility-scaled size: calmer symbols may take the full weight,
      // wild ones a fraction of it (ATR as a share of price is the gauge).
      const atrShare = st.atr !== null && close > 0 ? st.atr / close : 0.01;
      const volScale = Math.min(1, 0.012 / Math.max(atrShare, 0.004));
      let notional = BigInt(Math.floor(Number(state.equity) * WEIGHT * volScale));

      const room = state.weightRoom(bar.symbol);
      if (notional > room) notional = room;
      if (notional > state.cash) notional = state.cash;

      // Shrink until the modelled impact of this order fits the cap.
      const impact = state.impactBps(bar.symbol, notional);
      if (impact !== null && impact > BigInt(MAX_IMPACT_BPS)) {
        notional = (notional * BigInt(MAX_IMPACT_BPS)) / impact;
      }
      const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
      if (notional < minNotional || notional <= 0n) continue;

      orders.push({ side: 'buy', symbol: bar.symbol, notional_quote_units: notional, max_slippage_bps: SLIPPAGE_BPS });
      openSlots--;
    }

    return orders;
  },
});
