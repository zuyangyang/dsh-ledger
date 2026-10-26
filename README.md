# dsh-ledger

Chat-first bookkeeping for DeepSeek Harness. You say "昨天午饭32，打车18" and the
ledger records two entries; your parents say "老李拿了20双，先欠着" and the shop
book records a receivable with a running balance.

- Two books in one append-only journal: `home` (your household) and `shop` (the family store).
- Three separate readings, never mixed: **cash actually moved**, **who owes whom**, and (later) margin.
- Every entry remembers **who typed it** (`entered_by`), resolved from the IM source block.
- Data is a plain NDJSON file you can grep, diff, and version with git.

Design: [DESIGN.md](./DESIGN.md) · Build plan: [WEEKEND.md](./WEEKEND.md)

## Status

Work in progress. See the commit log for the current step; `npm test` runs the suite.
