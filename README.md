# dsh-ledger

Chat-first bookkeeping for DeepSeek Harness. You say "昨天午饭32，打车18" and the
ledger records two entries; your parents say "老李拿了20双，先欠着" and the shop
book records a receivable with a running balance.

- Two books in one append-only journal: `home` (your household) and `shop` (the family store).
- Three separate readings, never mixed: **cash actually moved**, **who owes whom**, and (later) margin.
- Every entry remembers **who typed it** (`entered_by`): the name dsh-im gives the receiving
  WeChat account (Yang, Mei), then the sender nickname, then the sender id.
- Data is a plain NDJSON file you can grep, diff, and version with git.
- A round `账` button in the corner opens a dashboard for any date range: charts, per-recorder lens, debt.

Design: [DESIGN.md](./DESIGN.md) · Build plan: [WEEKEND.md](./WEEKEND.md)

## Status

Implemented and linked into the `desktop` profile; restart DSH to load it.

- `npm test` — 196 tests over the journal, parsers, derived views, ranges, receipts, tools and the panel
- `npm run verify` — loads the plugin the way Cordis does and records one real sentence
- Chinese usage, install and smoke-test guide: [README.zh.md](./README.zh.md)