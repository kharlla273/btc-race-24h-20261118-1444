// btc-race-24h-20261118-1444: cbBTC vs USDC dip-reversion bot.
//
// Strategy (all bigint integer math, fully deterministic: no randomness,
// no clock, no environment, no files outside the repo):
//
//   * Keep the 20-bar and 60-bar simple moving averages of the 1-minute closes.
//   * Conviction leg (A): when flat and the close sits at least 150 bps below
//     the 60-bar SMA, the market has flushed hard in the last hour. Buy with
//     all cash. Exit when the close reverts to the 60-bar SMA, on a 300 bps
//     hard stop below the entry close, or after 720 bars held.
//   * Scalp leg (B): when flat and the close sits at least 50 bps below the
//     20-bar SMA, buy a quarter of the cash. Exit when the close reverts to
//     the 20-bar SMA, on +60 bps / -80 bps from the entry close, or after
//     120 bars held. A 60-bar cooldown follows every scalp exit so one
//     choppy stretch cannot churn the account.
//   * Leg C (dead-window fallback): if the bot has not traded at all by
//     bar 1200, take one small ticket on any close under the fast mean,
//     with the scalp's exit rules, so a calm window still leaves at least
//     one filled trade.
//   * Every order carries max_slippage_bps 200: a 1-minute move is far
//     smaller than that, so a fill is only ever rejected on a genuine gap.
//
// Why this shape: a full-size round trip costs about 26 bps in fees,
// slippage and pool impact, so small wiggles cannot pay. Only a deep flush
// (leg A) or a quick mean-reversion snap (leg B) is worth paying for, and
// the position is always exited on reversion instead of ridden through a
// falling market. The scalp leg also keeps the bot trading on calm windows
// where no deep flush ever appears.
//
// Protocol: agent-fun/bars-replay/v1 via the vendored kit shim.
// The grader runs `node /bot/main.ts` (Node 22 type stripping: erasable
// syntax only, imports with their .ts extension).

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Leg A: deep flush vs the slow mean.
const A_DIP_BPS = 150n; // entry: close >= 150 bps below SMA60
const A_STOP_BPS = 300n; // hard stop below the entry close
const A_MAX_HOLD = 720; // bars
// Leg B: small snap vs the fast mean.
const B_DIP_BPS = 50n; // entry: close >= 50 bps below SMA20
const B_SIZE_BPS = 2500n; // 25% of cash
const B_TAKE_BPS = 60n; // take profit above the entry close
const B_STOP_BPS = 80n; // stop below the entry close
const B_MAX_HOLD = 120; // bars
const B_COOLDOWN = 60; // bars after a scalp exit before the next scalp
// Leg C: dead-window fallback. If the bot has not traded at all by bar 1200,
// take one small ticket on any close under the fast mean, with the scalp's
// exit rules, so a calm window still leaves at least one filled trade.
const C_LATE_BAR = 1200; // earliest bar index for the fallback
const C_SIZE_BPS = 2500n; // 25% of cash

const SMA_FAST = 20;
const SMA_SLOW = 60;
const MAX_SLIPPAGE_BPS = 200;
const MIN_NOTIONAL = 1000000n; // 1 USDC in quote units

/** Rolling closes and averages; one open position at a time. */
class Strategy {
  private closes: bigint[] = [];
  private sumFast = 0n; // running sum of the last SMA_FAST closes
  private sumSlow = 0n; // running sum of the last SMA_SLOW closes
  private mode: 'A' | 'B' | null = null;
  private entryClose = 0n; // close at the bar the entry was decided on
  private held = 0; // bars held (decisions since entry)
  private cooldown = 0; // bars left before the next scalp entry
  private tradesDecided = 0; // buy orders decided so far (leg C needs this)

  private smaFast(): bigint | null {
    if (this.closes.length < SMA_FAST) return null;
    return this.sumFast / BigInt(SMA_FAST);
  }

  private smaSlow(): bigint | null {
    if (this.closes.length < SMA_SLOW) return null;
    return this.sumSlow / BigInt(SMA_SLOW);
  }

  private onClose(close: bigint): void {
    this.closes.push(close);
    this.sumFast += close;
    this.sumSlow += close;
    if (this.closes.length > SMA_FAST) this.sumFast -= this.closes[this.closes.length - SMA_FAST - 1]!;
    if (this.closes.length > SMA_SLOW) this.sumSlow -= this.closes[this.closes.length - SMA_SLOW - 1]!;
    if (this.cooldown > 0) this.cooldown -= 1;
  }

  decide(state: BarsState): (BuyInput | SellInput)[] {
    const close = state.close(SYMBOL);
    if (close === null) return [];
    this.onClose(close);

    const holding = state.positions.get(SYMBOL);
    if (holding === undefined || holding.qty === 0n) {
      this.mode = null;
      return this.maybeEnter(state, close);
    }
    return this.maybeExit(state, close, holding.qty);
  }

  private maybeEnter(state: BarsState, close: bigint): (BuyInput | SellInput)[] {
    const slow = this.smaSlow();
    if (slow !== null && close * BPS < slow * (BPS - A_DIP_BPS)) {
      this.mode = 'A';
      this.entryClose = close;
      this.held = 0;
      this.tradesDecided += 1;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    const fast = this.smaFast();
    if (this.cooldown === 0 && fast !== null && close * BPS < fast * (BPS - B_DIP_BPS)) {
      const size = (state.cash * B_SIZE_BPS) / BPS;
      if (size < MIN_NOTIONAL) return [];
      this.mode = 'B';
      this.entryClose = close;
      this.held = 0;
      this.tradesDecided += 1;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (this.tradesDecided === 0 && this.closes.length - 1 >= C_LATE_BAR && fast !== null && close < fast) {
      const size = (state.cash * C_SIZE_BPS) / BPS;
      if (size < MIN_NOTIONAL) return [];
      this.mode = 'B';
      this.entryClose = close;
      this.held = 0;
      this.tradesDecided += 1;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  private maybeExit(state: BarsState, close: bigint, qty: bigint): (BuyInput | SellInput)[] {
    this.held += 1;
    let exitNow = false;
    if (this.mode === 'A') {
      const slow = this.smaSlow();
      if (slow !== null && close >= slow) exitNow = true;
      else if (close * BPS <= this.entryClose * (BPS - A_STOP_BPS)) exitNow = true;
      else if (this.held >= A_MAX_HOLD) exitNow = true;
    } else {
      // mode B
      const fast = this.smaFast();
      if (fast !== null && close >= fast) exitNow = true;
      else if (close * BPS >= this.entryClose * (BPS + B_TAKE_BPS)) exitNow = true;
      else if (close * BPS <= this.entryClose * (BPS - B_STOP_BPS)) exitNow = true;
      else if (this.held >= B_MAX_HOLD) exitNow = true;
    }
    if (!exitNow) return [];
    if (this.mode === 'B') this.cooldown = B_COOLDOWN;
    this.mode = null;
    return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
}

const strategy = new Strategy();

await runBars({
  onBatch(state) {
    if (state.warmingUp) return [];
    return strategy.decide(state);
  },
});
