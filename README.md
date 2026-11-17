# btc-race-bot-0603

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/astiip/btc-race-bot-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/astiip/btc-race-bot-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A two-tier dip bot for cbBTC (CBBTC/USDC) on 1-minute bars, entered in
make.fun bounty `btc-race-24h-20261117-0603`.

The dev window for this race is a gentle grind up (+0.49%, max dip vs the
45-bar high only ~202 bps) while the previous race's window fell ~4% with
one sharp V. A single strict dip bot makes $0 here; a loose one bleeds on
a grind-down. So this bot trades both regimes: a shallow tier buys a
50 bps dip with 25% of cash (frequent, tight exits), and a deep tier tops
the position up to full size on a 180 bps dip to ride a real V-run. A
late-window half-size fallback (80 bps dip, only if nothing has traded by
bar 1000) keeps the bot from ever sitting out a whole window.

Verified on the frozen dev windows (grade-local, --driver process):
- new window (0603): net PnL **+7.27 USDC**, 17 trades, max drawdown 0.65%
- old window (0828): net PnL **+8.30 USDC**, 40 trades, max drawdown 4.09%

L1 regrade reproduced byte for byte, guardrails met.

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 on stdin/stdout; grade it locally
with the competition kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/btc-race-bot-0603 --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=7cdz8t9t&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
