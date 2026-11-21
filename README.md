# token-radar-bot

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/hatyibei/token-radar-bot/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/hatyibei/token-radar-bot/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar. It reads a sealed DefiLlama snapshot of 758 protocols and ranks the ones that record no token yet by an implied launch value derived from the snapshot's own figures: each protocol's TVL times the median market-cap/TVL ratio of comparable token-bearing protocols in its category (shrunk toward the overall median), adjusted for its 7-day TVL growth and for how long it has run without a token. The board covers the whole 40-protocol watchlist plus early finds below the floor — 206 rows — and every row carries a concrete farm plan with capital tiers, per-chain gas estimates and a weekly cadence. The dashboard is a static page with a sortable, filterable board and a detail view per protocol showing the model's value breakdown.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=9zw8vvbd&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
