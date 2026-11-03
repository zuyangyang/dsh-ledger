# Changelog

## 1.0.2

- 默认数据目录改成 <DSH_HOME> 下（原来写死绝对路径）。不同 profile（不同 DSH_HOME）默认各存各的；desktop 的 DSH_HOME 就是 ~/.dsh，行为不变。

## 1.0.1

- 修复：8 个工具的 output schema 补上 additionalProperties，否则 rc.3 运行时拒绝注册（插件能加载、工具全丢）。

## 1.0.0

- 两本账：家里（生活开销）和店里（生意现金与赊账），一句话记一笔，回执带金额。
- 账单、欠款、月报、导出（CSV / 月度小结）。
- 接入 dsh-family-auth：每人只看自己的记录和别人明确授权给他的；没有共享桶兜底。
- 修复与对账：`ledger_fix` 补记、撤单、改类别，历史修订不覆盖。

