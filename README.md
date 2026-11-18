# btc-race-24h-20261118-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/kharlla273/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/kharlla273/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

SMA dip-reversion BTC trading bot (legs A/B/C): a deterministic cbBTC/USDC bot for make.fun's "Race a BTC trading bot live for 24 hours" bounty. It buys deep flushes below the 60-bar SMA (leg A, full cash), scalps quick mean-reversion snaps off the 20-bar SMA (leg B, quarter cash), and takes one small fallback ticket on calm windows (leg C). All integer bigint math — no randomness, no clock, no environment. Local grade on the dev window: net PnL +6.28 USDC, 5 trades, max drawdown 0.63%.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=n305kcfc&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>

## Strategy

- Keep the 20-bar and 60-bar simple moving averages of the 1-minute closes.
- Conviction leg (A): when flat and the close sits at least 150 bps below the 60-bar SMA, the market has flushed hard in the last hour. Buy with all cash. Exit when the close reverts to the 60-bar SMA, on a 300 bps hard stop below the entry close, or after 720 bars held.
- Scalp leg (B): when flat and the close sits at least 50 bps below the 20-bar SMA, buy a quarter of the cash. Exit when the close reverts to the 20-bar SMA, on +60 bps / -80 bps from the entry close, or after 120 bars held. A 60-bar cooldown follows every scalp exit so one choppy stretch cannot churn the account.
- Leg C (dead-window fallback): if the bot has not traded at all by bar 1200, take one small ticket on any close under the fast mean, with the scalp's exit rules, so a calm window still leaves at least one filled trade.
- Every order carries max_slippage_bps 200: a 1-minute move is far smaller than that, so a fill is only ever rejected on a genuine gap.

Why this shape: a full-size round trip costs about 26 bps in fees, slippage and pool impact, so small wiggles cannot pay. Only a deep flush (leg A) or a quick mean-reversion snap (leg B) is worth paying for, and the position is always exited on reversion instead of ridden through a falling market. The scalp leg also keeps the bot trading on calm windows where no deep flush ever appears.

Protocol: agent-fun/bars-replay/v1 via the vendored kit shim. The grader runs `node /bot/main.ts` (Node 22 type stripping: erasable syntax only, imports with their .ts extension).

## Local grade

- Net PnL +6.275741 USDC, 5 trades, max drawdown 0.63%, guardrails met, deterministic.
