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

Implemented and linked into the ¤desktop¤ profile; restart DSH to load it.

- ¤npm test¤ — 124 tests over the journal, parsers, derived views, receipts and tools
- ¤npm run verify¤ — loads the plugin the way Cordis does and records one real sentence
- Chinese usage, install and smoke-test guide: [README.zh.md](./README.zh.md)