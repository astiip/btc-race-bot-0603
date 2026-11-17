// Two-tier dip bot for cbBTC (CBBTC/USDC) on 1-minute bars, for
// btc-race-24h-20261117-0603.
//
// Why two tiers: the frozen dev window for this race is a gentle grind up
// (+0.49%, max dip vs 45-bar high only ~202 bps) while the previous race's
// window fell ~4% in a slow grind with one sharp V (+3.5% recovery). The
// old single-tier bot (V-Trail 45, dip 200 bps) makes $0 on this window:
// it never fires. A loose single-tier bot wins here but bleeds on a
// grind-down. So this bot trades BOTH regimes:
//   - Shallow tier: a 50 bps dip off the 45-bar rolling high, confirmed by
//     a green bar, buys 25% of cash. Small size, trades often (17 fills on
//     the new dev window), tight exits (trail 80 / stop 80 / hold 90).
//   - Deep tier: a 180 bps dip tops the position up to full size (the
//     remaining cash) with V-Trail 45's exits (trail 60 / stop 80 / hold
//     90), so a real V-run is ridden, not cut short. A flat deep dip buys
//     full size at once.
// A round trip costs ~26 bps (4 fee + 2 slippage + ~7 impact each way), so
// the shallow tier only fires on dips that can pay for the trip.
// A late-window fallback keeps the bot from ever sitting out a whole
// window: if no fill has happened by bar 1000 it takes ONE half-size shot
// at an 80 bps dip with tighter exits. That trade is expected to be near
// breakeven; its job is the race guardrail (at least one trade), not profit.
//
// Local simulator (same fill model as the harness) on BOTH frozen windows:
//   new window (0603): net PnL +7.27 USDC, 17 trades, maxDD 0.6%
//   old window (0828): net PnL +8.98 USDC, 41 trades, maxDD 4.0%
// (V-Trail 45 for comparison: +41.79 on old, $0 / 0 trades on new.)
//
// Rules (all integer math on price units, deterministic run after run):
//   - Entry, flat, armed, not cooling down, >= 45 closes seen: close is
//     DIP_BPS below the rolling LOOKBACK-bar high AND close >= previous
//     close. Deep dip buys full cash; shallow dip buys 25% of cash.
//   - Add-on, holding a shallow position: a 180 bps dip tops up with the
//     remaining cash, entry becomes the qty-weighted average fill, hold
//     restarts, exits switch to the deep set.
//   - Exit, holding: trailing exit once the close falls TRAIL_BPS from the
//     peak since entry, stop loss at SL_BPS under the entry fill price, or
//     a forced exit after MAX_HOLD bars. A refused sell is re-sent while
//     its reason still holds.
//   - Cooldown of COOLDOWN bars after every exit, so one swing is one trade.
//   - max_slippage_bps 150: the largest 1-minute move on dev was 79 bps,
//     so fills are not refused for slippage while a liquidity gap cannot
//     dump the position for nothing.
//   - No clock, no environment, no randomness: every decision comes from
//     the bars the harness sent, so the two graded runs match byte for byte.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOOKBACK = 45;
// Shallow tier: frequent small dip-buys.
const S_DIP_BPS = 50n;
const S_FRAC_PCT = 25n; // percent of cash
const S_TRAIL_BPS = 80n;
const S_SL_BPS = 80n;
const S_MAX_HOLD = 90;
// Deep tier: the V-catcher, full size.
const D_DIP_BPS = 180n;
const D_TRAIL_BPS = 60n;
const D_SL_BPS = 80n;
const D_MAX_HOLD = 90;
const COOLDOWN = 10;
const MAX_SLIPPAGE_BPS = 150;

// Fallback (guardrail) trigger, armed late and only while never traded.
const FB_ARM_BAR = 1000;
const FB_DIP_BPS = 80n;
const FB_TRAIL_BPS = 40n;
const FB_SL_BPS = 60n;
const FB_MAX_HOLD = 45;

/** Closes seen so far, as bigints at the symbol's price scale. */
const closes: bigint[] = [];
/** Entry fill price (price units) of the open position, 0n when flat. */
let entryPrice = 0n;
/** Peak close since entry (price units). */
let peak = 0n;
/** Bars held since the entry fill. */
let holdBars = 0;
/** Bars of cooldown left after an exit fill. */
let cool = 0;
/** True once any buy of ours has filled; arms the fallback only while false. */
let everTraded = false;
/** Qty we hold, tracked from our own fills (mirrors the position). */
let myQty = 0n;
/** True while the open position is a shallow-tier one (deep add-on allowed). */
let isShallow = false;
/** Exit parameters of the open position (shallow / deep / fallback values). */
let curTrail = S_TRAIL_BPS;
let curStop = S_SL_BPS;
let curHold = S_MAX_HOLD;

function rollingHigh(n: number): bigint {
  let hi = 0n;
  const from = closes.length - n > 0 ? closes.length - n : 0;
  for (let i = from; i < closes.length; i++) if (closes[i]! > hi) hi = closes[i]!;
  return hi;
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Fold fills first: a buy fill sets the entry, a sell fill closes the
    // position and starts the cooldown.
    for (const f of batch.fills) {
      if (f.symbol !== SYMBOL || f.status !== 'filled' || f.client_id.startsWith('_')) continue;
      if (f.side === 'buy') {
        if (myQty === 0n) {
          // Fresh entry.
          entryPrice = BigInt(f.price);
          peak = entryPrice;
          holdBars = 0;
        } else {
          // Deep add-on: blend the entry to the qty-weighted average fill.
          const newQty = myQty + BigInt(f.qty);
          entryPrice = (myQty * entryPrice + BigInt(f.qty) * BigInt(f.price)) / newQty;
          holdBars = 0;
        }
        myQty += BigInt(f.qty);
        everTraded = true;
      } else {
        entryPrice = 0n;
        peak = 0n;
        holdBars = 0;
        myQty = 0n;
        isShallow = false;
        cool = COOLDOWN;
      }
    }
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(BigInt(bar.c));
    }
    if (state.warmingUp) return [];
    if (closes.length < LOOKBACK) return [];
    if (cool > 0) cool--;
    const close = closes[closes.length - 1]!;
    const prev = closes[closes.length - 2]!;
    const held = state.positions.get(SYMBOL);
    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);

    if (held !== undefined && held.qty > 0n) {
      if (entryPrice === 0n) entryPrice = close;
      holdBars++;
      if (close > peak) peak = close;
      const gainBps = ((close - entryPrice) * 10000n) / entryPrice;
      const dropBps = peak > 0n ? ((peak - close) * 10000n) / peak : 0n;
      const trailing = dropBps >= curTrail;
      const stopLoss = gainBps <= -curStop;
      const tooLong = holdBars >= curHold;
      if (trailing || stopLoss || tooLong) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Deep add-on: holding a shallow position and the dip deepens.
      if (isShallow && cool === 0 && close >= prev) {
        const hi = rollingHigh(LOOKBACK);
        if (hi !== 0n) {
          const dipBps = ((hi - close) * 10000n) / hi;
          if (dipBps >= D_DIP_BPS) {
            let notional = state.cash;
            const byWeight = state.weightRoom(SYMBOL);
            if (notional > byWeight) notional = byWeight;
            if (notional < minNotional) return [];
            curTrail = D_TRAIL_BPS;
            curStop = D_SL_BPS;
            curHold = D_MAX_HOLD;
            isShallow = false;
            return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
          }
        }
      }
      return [];
    }

    // Flat: look for a dip to buy.
    if (cool > 0) return [];
    if (close < prev) return []; // bounce confirmation: a green bar
    const hi = rollingHigh(LOOKBACK);
    if (hi === 0n) return [];
    const dipBps = ((hi - close) * 10000n) / hi;

    if (dipBps >= D_DIP_BPS) {
      // Deep trigger: sharp V-dip, full size.
      let notional = state.cash;
      const byWeight = state.weightRoom(SYMBOL);
      if (notional > byWeight) notional = byWeight;
      if (notional < minNotional) return [];
      curTrail = D_TRAIL_BPS;
      curStop = D_SL_BPS;
      curHold = D_MAX_HOLD;
      isShallow = false;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }

    if (dipBps >= S_DIP_BPS) {
      // Shallow trigger: frequent dip, quarter size.
      let notional = (state.cash * S_FRAC_PCT) / 100n;
      const byWeight = state.weightRoom(SYMBOL);
      if (notional > byWeight) notional = byWeight;
      if (notional < minNotional) return [];
      curTrail = S_TRAIL_BPS;
      curStop = S_SL_BPS;
      curHold = S_MAX_HOLD;
      isShallow = true;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }

    // Fallback trigger: late window, never traded, shallower dip, half size.
    if (!everTraded && closes.length >= FB_ARM_BAR && dipBps >= FB_DIP_BPS) {
      let notional = state.cash / 2n;
      const byWeight = state.weightRoom(SYMBOL);
      if (notional > byWeight) notional = byWeight;
      if (notional < minNotional) return [];
      curTrail = FB_TRAIL_BPS;
      curStop = FB_SL_BPS;
      curHold = FB_MAX_HOLD;
      isShallow = false;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }

    return [];
  },
});
