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

- `npm test` — 225 tests over the journal, parsers, derived views, ranges, receipts, tools and the panel
- `npm run verify` — loads the plugin the way Cordis does and records one real sentence
- Chinese usage, install and smoke-test guide: [README.zh.md](./README.zh.md)

## 家庭权限（0.5）

默认每人只看自己记的账。接入 [dsh-family-auth](https://github.com/zuyangyang/dsh-family-auth) 后：

- 记录自动记在说话的人名下；没识别出身份就落进"共享桶"，全家可见
- 别人想看你的账，必须由你授权；户主可以看全部
- 历史记录用 `ledger_claim` 认领："以前记在 yang 名下的都是我"
- 账本面板在启用权限后关闭（它没有会话身份）；夜间小结已移除

没装 dsh-family-auth 时行为不变：单用户，全部可见。
