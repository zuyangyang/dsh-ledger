# dsh-ledger 设计文档

> 状态：**v0.3 设计草案**（家庭账为主 + 皮鞋店现金/欠款）· 目标 DSH 版本 0.2.1-rc.2 · 作者：小Yo（Yang 的 DSH 会话）
> 本文是"能不能落、怎么落"的完整设计；实现按 §17 的周末计划起步。所有 API 断言见附录 A 的出处；未验证项集中在 §19。

> **v0.3 增量（Yang 第二轮拍板，2026-10-26 晚）**：库存/毛利整体推到 M2（父母不记货号）→ 工具 7→6；新增 `entered_by` 与按人路由账本（手机多用户，§4.8）；进货没说付款默认记"付清"（没有标准账期，不凭空造应付）；家庭开销追踪升为第一目标 G0。详见 §19.2 的第二轮表格。

## v0.2 相对 v0.1 变了什么（只列会影响实现的）

| # | 变更 | 为什么 | 落在哪节 |
|---|---|---|---|
| 1 | 一条事件流 + `book` 字段（home / shop），**不建第二个账本目录** | 双目录 = 双写 = 双份幂等，必然漂移；跨账本转移要一条事件两侧投影 | §4.6、§20 |
| 2 | 新增生意事件：进货/销售/还款/付供应商/退货/盘点/老板取现 | 父母开皮鞋店，有进货、零售、批发、赊账 | §4.6 |
| 3 | 引入**三个口径**：现金 / 权责（收入−成本）/ 欠款，报表分开且不许互相替代 | 父母问"手里多少钱"和"赚了多少"是两个问题；赊销记成收入会让人多花 | §4.7、§8.7 |
| 4 | 成本用**移动加权平均 + 每次重放**（不冻结快照） | 补记进货是常态，冻结会把历史毛利钉在错值且不能自愈 | §4.7 |
| 5 | 库存是**可选副产物**；允许只记总额，不记货号 | 父母不会录货号；录不全的库存系统比没有更危险 | §4.6、§8.9 |
| 6 | 去掉预算、外币；加 git 自动提交与 Obsidian 输出 | Yang 拍板：只记人民币、不用预算、账本要 git、要 Obsidian 能看 | §14、§15.6 |
| 7 | 工具从 8 个收敛到 **6 个**（单一写入口） | 工具每多一个都进常驻 prompt，且"选错工具"比"填错参数"更贵 | §7、§7.1 |

---

## 0. 一页速览（TL;DR）

**做什么**：一个 DSH 插件，让 Yang 用聊天里最随意的话记账——"午饭32"、"昨天打车18.5"、"9月3日房租4500"、"工资到账18000"——插件负责整理归类、去重、补记到过去的日期，并按天/按月出汇总。同时给一块 Web 看板，让人能一眼看到本月花在哪。

**关键形态**

| 项 | 选择 |
|---|---|
| 形态 | 聊天优先（模型调工具）+ 一个 Web 看板（只读为主，轻纠错）；**父母用聊天，Yang 用看板** |
| 使用者 | ① Yang（个人日常）② 父母（皮鞋店：进货、零售、批发、赊账、收款）——同一插件、两本账、两套类目 |
| 账本 | `book` 字段：`home`（家里）/ `shop`（店里）；**一份事件流**，不建两个目录 |
| 数据落点 | 本机纯文件：`~/.dsh/ledger/entries.ndjson`（append-only，含全部账本）+ `meta.json`（类目/别名/欠款人）；目录 git init 自动提交 |
| 钱怎么存 | 整数"分"，永不 float；只记人民币；入参是**十进制字符串或原始中文短语**，由插件归一化 |
| 记账日 | 只存 `occurred_on`（本地日期，Asia/Shanghai）；**未来日期一律拒绝**；补记记 `date_source=backfill` |
| 生意记录 | 事件类型：进货 / 销售（零售·批发）/ 客户还款 / 付供应商 / 退货 / 盘点 / 老板取现 / 账本间转移；**结算与交易同事件**（`paid_minor`） |
| 三个口径 | **现金**（实收实付，和抽屉对得上）、**权责**（收入 − 已售成本 − 开支 = 毛利/利润）、**欠款**（应收/应付 + 账龄）。三张报表分开，绝不互相替代 |
| 库存 | **可选副产物**：只记总额时库存不动；只有给了货号数量才增减；成本用 per-sku 移动加权平均，按全序重放 |
| 纠错与撤销 | `draft/confirmed/void` 三态 + 版本号；删除就是 `void`；父母只会说"最后那笔"，所以 `ledger_fix` 必须支持 `match:"last"` |
| 分类 | 家庭：12 支出 + 6 收入 L1；店铺：营业收入 / 营业外 / 8 个期间费用 + `biz_cashflow` 流转组（不计收支）。**类目前缀即账本归属** |
| 模型 vs 插件 | 模型只做"把一句话切成几笔、给类目候选、判断现金还是赊账"；**日期、金额、幂等、欠款核销、库存、成本、报表由插件确定性完成** |
| 常驻成本 | 工具 schema 常驻（**6 个**，见 §7）+ 一条 ≤240 字账本摘要（可关）；记账协议放 **skill**，不占常驻 token |
| 每日摘要 | 插件内定时器（默认 21:30，按 `nightlyTime`）+ `agent.followup()` 推给空闲会话；**店里/家里两段分别发**，店里每天、家里一周一次 |
| 依赖 | 零新增运行时依赖（宿主提供一切）；客户端零图表库，手绘 div/svg |

**为什么值得做**：现在记账的摩擦点在"打开 App → 选类目 → 填金额"，而 Yang 每天本来就在跟 DSH 说话；父母那侧更狠——他们连 App 都不想装。把"说一句"变成账目，是这件事唯一成立的理由。其余设计都围绕三件事：**别把账记错**（双口径 + 事件流）、**别让账丢了**（append-only + git）、**别让长辈不信**（每条回执喊出欠款余额）。

---

## 1. 目标与非目标

### 1.1 目标（v1 必须成立）

| # | 目标 | 验收方式 |
|---|---|---|
| G0 | **Yang 的家庭开销能连续追踪**（这是这个插件的首要目的；店里的账是第二目的） | 连续记 14 天不漏；月报类目占比能回答"钱花哪了" |
| G1 | 一句话 → 一笔或多笔账，且**金额/日期/方向正确** | §18 测试矩阵 1–10 |
| G2 | 能补记任意过去日期（含上月），并立刻反映在月报里 | 矩阵 3、7、9、22 |
| G3 | 按日、按月、按区间出汇总，Markdown 直接可读、JSON 可喂 UI | §8.3 模板逐字比对 |
| G4 | 重复投递/重试**不产生重复账**；重复可被发现、可被撤销 | 矩阵 17 |
| G5 | 数据可读、可 git、可备份、可导出；损坏可隔离而不会静默改账 | §4.3、§16 |
| G6 | 常驻开销可控：日常对话不因账本插件额外烧 token | §9、§14 |
| G7 | **父母能用**：一句话记账，回执 ≤4 行、无英文/编号/"分"，跟人有关的账必须喊出余额 | §18.5 的长辈验收 12 条 |
| G8 | **店里三个问题能答**：今天卖多少、这个月赚多少、谁还欠我钱（含欠了多久） | §8.7–§8.8、§18.4 |

### 1.2 非目标（明确不做，避免设计漂移）

- **不做复式记账**（借贷平衡、科目表、试算平衡）。个人账本要的是"这杯咖啡算哪类"，不是会计恒等式。→ 但保留 `kind` 语义区分（支出/收入/退款/转账/调整），见 §4.1。
- **不做银行/微信/支付宝自动同步**。没有任何账单抓取、截图 OCR、IM 渠道监听、CSV 批量导入（v1 只接受"说出来"的数据，导出单行）。
- **不做多用户、不做云端同步**。单机、单进程（DSH 宿主进程）；账本是两本（家里/店里），但在同一份事件流里。
- **不做进销存 / ERP**：不做多仓库、条码、尺码颜色矩阵、采购单/销售单审批、员工与提成、会员、发票、税务、多币种、跨设备同步。
- **v1 不做库存与毛利**（父母不记货号 → 数字不可信）：只给"进货花了多少、卖了多少、谁还欠我"，库存/成本推到 M2 且只走盘点（§8.9）。
- **不做图表库/仪表盘产品化**。看板够用即止。
- **不做"智能投顾"式建议**。报表只陈述事实（销售额、成本、欠款、现金），不做经营建议、不预测、不催收语气升级。

### 1.3 成功标准（三个月后回看）

1. Yang 连续两周用它记账，且**不需要打开别的 App**；
2. 入库后**未人工改过类目**的比例 > 85%（说明分类器真的在工作）；且"other + draft"占比 < 5%；
3. 任意一天问"上个月花在哪"，一次 tool call + 一条消息答完。

---

## 2. 用户故事与典型会话

### S1 一条消息三笔账（最常见）

> **Yang**：昨天午饭32，打车18，晚上咖啡25

插件行为：模型切 3 笔 → 3 次 `ledger_add`（各自带 `date_expr:"昨天"`、`source_text` 原文、`item_index`）→ 插件把"昨天"解成 `2026-10-25`、金额转分、类目命中 `food_lunch / transport_taxi / food_coffee` → 回一条紧凑确认：

~~~markdown
已记 3 笔（2026-10-25，共 ¥75.00）
- 午饭 ¥32.00 · 餐饮/午餐
- 打车 ¥18.00 · 交通/打车
- 咖啡 ¥25.00 · 餐饮/咖啡饮品
本月支出 ¥3,240.50 · 外面还欠我 ¥2,800.00
~~~

### S2 补记一个月前的房租

> **Yang**：9月3日房租4500

插件行为：`date_expr:"9月3日"` → 无年份时按当前年、若解在未来则回退上一年并要求确认 → 记 `2026-09-03`，`date_source:"backfill"`；回复里**同时**回显"计入日期"和"今天才录入"两件事，因为这是后面"我是不是加过"能被回答的前提。若该月已有报表，明确一句"9 月月报已重算，支出 +¥4,500.00"。

### S3 "这笔算交通"（纠错教学）

> **Yang**：这笔算交通

插件行为：`ledger_query` 找到最近一笔 → `ledger_fix` 改 `category`，版本 +1；同一候选词被纠正第 2 次时才写入别名表（防一次性误教），并明示"已记住：钉钉 → 交通/打车"。

### S4 "我上周三是不是加过一笔房租？"

插件行为：`ledger_query({from,to,category_l1:"housing",q:"房租",include_void:true})` → 命中则区分 `occurred_on=10-15` 与 `created_at=10-16`："你在 10 月 16 日录了一笔记到 10 月 15 日的房租"；未命中就明说"没有"，并问要不要补——**不自动补**。

### S5 晚上 21:30 的日结

插件主动推一条（不打扰、只在本机开着时）：店里一段（今日销售/现金/欠款）+ 家里一段；若当天一笔没记，只问一句"今天没记账，是没花钱还是忘了？"。

### S6 看板（非聊天路径）

侧栏点"账本"→ 整页看板：月份切换、三数卡（支出/收入/结余）、类目占比横条、30 天日柱、按日分组的流水（行内改类目/作废）。

---

## 3. 总体架构

### 3.1 组成

~~~text
┌─────────────────────────── DSH Host 进程 ───────────────────────────┐
│  模型（LLM）                                                         │
│    │  tool calls: ledger_add / query / report / fix / budget / …     │
│    ▼                                                                 │
│  ctx.tools  ┌───────────────────────────────────────────────────┐    │
│  （6 个）   │  dsh-ledger host half (lib/index.js)              │    │
│             │  ├ tools/      工具面 + 参数校验 + 渲染             │    │
│             │  ├ ledger/     store(append-only) + index(内存)     │    │
│             │  ├ parse/      金额·日期·方向 归一化                 │    │
│             │  ├ classify/   别名表 + 内置词典                     │    │
│             │  ├ report/     日/月/区间 计算与 Markdown 渲染        │    │
│             │  ├ brief/      systemPrompt 摘要（缓存，无 IO）      │    │
│             │  └ nightly/    followup 推送 + lastRunDate           │    │
│             └───────┬──────────────────────────┬──────────────────┘    │
│                     │ 读写                     │ typert.register      │
│             ~/.dsh/ledger/                     ▼                      │
│             ├ entries.ndjson (append-only)   Remote namespace        │
│             ├ meta.json                      “ledger”  (/api/ledger/*)│
│             ├ reports/ (可选派生)                                   │
│             └ exports/                                             │
│                                    ▲ ctx.remote.$mount + slots       │
│  浏览器 shell ──────────────────────┴──────────  settings.section     │
│                                                 sidebar.panellist+main│
└──────────────────────────────────────────────────────────────────────┘
~~~

### 3.2 分层职责（谁都不许越界）

| 层 | 职责 | 明确不做 |
|---|---|---|
| 模型 | 把自然语言切成 N 笔、给 `kind`/类目**候选**、复述原文片段做 `evidence` | 不写 id、时间戳、去重键、版本；不算钱 |
| 工具层 | 参数校验、权限、渲染 Markdown、把领域错误翻译成模型能懂的话 | 不直接读写文件（走 store） |
| 领域层 | 归一化、分类、去重、幂等、版本、状态机、报表计算 | 不碰 HTTP、不碰 UI |
| 存储层 | append-only 写 + 启动加载 + 校验 + 隔离坏行 + 压缩 | 不做业务判断 |
| 客户端 | 展示、轻量纠错、开单录入、客户与别名编辑 | 不做汇总口径（数字一律来自 host） |

**一条硬规则**：报表的每一个数字都由 host 计算；客户端与模型都不允许自己加总。否则"两个地方显示不一致"必然发生。

### 3.3 关键数据流（写入）

~~~text
user msg ──► model 切分/候选 ──► ledger_add(amount, kind?, date_expr?, cat?)
                                    │
                                    ▼
                         normalize(amount→minor, date→occurred_on)
                                    │
                         classify(alias 表可覆盖模型候选)
                                    │
                    dedupe/idempotency(request_id, dedupe_key)
                                    │
                        append(entries.ndjson) ──► fsync
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
        内存索引更新          brief 快照刷新        欠款/库存缓存失效
              │                                           │
              └──────────► 返回 {created, warnings} ◄──────┘
~~~

### 3.4 与既有插件的边界（为什么不复用 memory/diary）

| 插件 | 可复用 | 不可复用 |
|---|---|---|
| `dsh-plugin-memory` | 插件骨架、config-store 模式、followup 推送范式、skill 注册 | 它的数据是自由文本 wiki；账本要 schema 与聚合 |
| `dsh-diary` | 工具族定义范式、typert Remote + 客户端 bundle 范式、Settings 区注册 | 日记是"一天一个 md"，本质是文本；账本要幂等与去重 |
| `@xmanrui/dsh-im` | 客户端 esbuild 打包与 slot 注册的完整工程写法 | 与记账无关 |

**结论**：新写一个独立插件，照抄 skeleton、不共享代码（插件间不该有运行时耦合；唯一例外是可选地调用宿主 `schedule`）。

---

## 4. 数据模型

### 4.1 记录（transaction）规范形态

~~~json
{
  "id": "tx_01J9Z3K7QF5R8M2N",
  "schema": 1,
  "version": 3,
  "kind": "expense",
  "status": "confirmed",
  "amount_minor": 3200,
  "currency": "CNY",
  "scale": 2,
  "occurred_on": "2026-10-25",
  "occurred_at": null,
  "date_source": "explicit_relative",
  "book": "home",
  "paid_minor": null,
  "items": [],
  "customer": null,
  "cost_source": null,
  "category": { "l1": "food", "l2": "food_lunch", "source": "alias", "confidence": 0.95 },
  "merchant": null,
  "account": null,
  "payment_method": null,
  "note": "午饭",
  "tags": [],
  "original_tx_id": null,
  "dedupe_key": "9f2c1ab34e7d0c88",
  "request_id": "req_a1b2c3d4e5f6",
  "provenance": {
    "session_id": "sess_…", "message_id": "msg_…", "item_index": 0,
    "source_text": "昨天午饭32，打车18，晚上咖啡25", "parser": "llm"
  },
  "created_at": "2026-10-26T10:54:01+08:00",
  "updated_at": "2026-10-26T10:54:01+08:00",
  "voided_at": null,
  "void_reason": null
}
~~~

### 4.2 字段表（谁供给、约束、为什么）

| 字段 | 类型 | 约束 | 可空 | 供给方 | 决策理由 |
|---|---|---|---|---|---|
| `id` | string | `tx_` + ULID，全局唯一 | 否 | 插件 | 稳定 id 是"改过/撤销/回溯"的唯一锚点 |
| `schema` | int | 当前 1 | 否 | 插件 | 单文件日志里的记录级迁移依据 |
| `version` | int | 每次变更 +1 | 否 | 插件 | 乐观锁；append-only 下靠它选"最新快照" |
| `kind` | enum | expense / income / refund / transfer / adjustment | 否 | 模型提，插件校验 | 五个值覆盖"花/赚/退/搬/平"五种语义；**不用正负号表达方向** |
| `status` | enum | draft / confirmed / void | 否 | 插件（模型只能请求 draft） | 报表只统计 confirmed；void 而非物理删 |
| `amount_minor` | int | `>0`（adjustment 可负且 ≠0） | 否 | 插件（从字符串入参换算） | 整数分：float 的 0.01 级误差会在月报与毛利里累积 |
| `currency` / `scale` | string / int | ISO-4217；v1 只接受 `CNY`/2 | 否 | 插件默认 | v1 不做外币：非 CNY 条目被拒（`E_CURRENCY_UNSUPPORTED`）；字段留着是为了 v2 不改 schema |
| `occurred_on` | date | `YYYY-MM-DD`，`≥2000-01-01`，`≤today+1` | 否 | 模型（`date_expr` 或 ISO）→ 插件裁决 | 记账日；与"录入时刻"分离，是补记与"上周三"查询的基础 |
| `occurred_at` | datetime | ISO8601 带 +08:00 | 是 | 模型（仅当用户给了钟点） | 只用于同日排序，**不参与日界判断** |
| `date_source` | enum | explicit_abs / explicit_relative / weekday / inferred_today / backfill / rule | 否 | 插件 | 审计"这个日期是用户说的还是猜的" |
| `category.l1/.l2` | slug | l2 属于 l1；必须在合并后的类目表内 | l2 可空 | 插件（模型候选可被别名覆盖） | 存 slug 不存中文；改文案不动历史 |
| `category.source/.confidence` | enum / float | builtin / custom / alias / fallback；0–1 | 否 | 插件 | 低置信 → 强制 draft + 追问 |
| `merchant` | string | ≤60 | 是 | 模型（取自原文） | 商户 Top N 的唯一来源 |
| `account` / `payment_method` | string / slug | 自由文本 / wechat·alipay·cash·credit_card·other | 是 | 模型弱提示 | 账户体系留到 v2，先留字段 |
| `note` | string | ≤200，入库前脱敏 | 是 | 模型（取 `source_text` 子串） | 保留可回溯语境 |
| `tags` | string[] | ≤8 个，单个 ≤16，小写 | 否 | 模型 | aa / advance / installment / recurring 等横切标记 |
| `original_tx_id` | string | `kind=refund` 时指向原支出 | 是 | 插件匹配 | 退款抵冲**原类目**的前提 |
| `dedupe_key` | string | 16 hex | 否 | 插件 | 同消息/近时去重的判据 |
| `request_id` | string | 派生，12 hex | 否 | 插件 | 幂等键；模型重试不该产生第二笔账 |
| `provenance` | object | session/message/item_index/source_text | 否 | **插件独占** | 模型给的 session 不可信 |
| `book` | string | `home` / `shop` | 是 | 模型（说"店里/家里"）或插件（沿用上一笔，§12.22） | 两本账同一份事件流；老记录缺省 home |
| `paid_minor` | int | `0 ≤ paid ≤ amount` | 否 | 模型（`paid` 原文）+插件归一 | 只对 sale/purchase/return 有意义；`open = amount − paid − 已核销` 是应收应付的唯一来源 |
| `items` | array | `[{sku, qty, unit_price_minor\|unit_cost_minor}]` | 否 | 模型 | 空数组 = 只记总额（库存不动、毛利 unknown）；库存主键永远是 `(sku, qty)` |
| `customer` / `supplier` | string | ≤32 字，脱敏 | 否 | 模型 | 赊账必填客户；散客写 `散客` 占位，不置 null（否则账龄分组会炸） |
| `channel` | string | `retail`/`wholesale`/`internal` | 否 | 模型或插件推断 | 批发与零售价差只靠它区分，不拆 sku |
| `cost_source` | string | `exact`/`estimated`/`unknown` | 否 | 插件 | 决定该笔毛利可信度；报表必须打印明细覆盖率 |
| `entered_by` | string | `actor_id`（≤64，脱敏后） | 否 | 通道/模型传入，插件归一 | **谁记的这笔**（Yang：手机端父母也会记）。不参与金额与报表口径，只用于溯源与「同一笔被两个人各记一次」的发现（§4.8） |
| `created_at` / `updated_at` | datetime | 服务端时钟 | 否 | 插件 | `created_at` 才是"是否加过"的真值 |
| `voided_at` / `void_reason` | datetime / string | 仅 `status=void` | 是 | 插件 | 软删除证据 |

**三条铁律**

1. 模型**不能**写 `id` / 时间戳 / `provenance` / `dedupe_key` / `request_id` / `version`；即使传了也被丢弃（不报错，避免模型浪费一轮）。
2. 已 `void` 的记录不可再改，只能"恢复"成 confirmed（新版本）。
3. `amount_minor` 永远是"金额的绝对值"；方向由 `kind` 决定。**永不出现负的 expense。**

### 4.3 存储：append-only 事件日志（不是"一个文件一张表"）

#### 文件布局

~~~text
~/.dsh/ledger/                     (DSH_HOME/ledger，config.dataDir 可改)
├── entries.ndjson                 账本日志：一行一个"记录快照"，只追加
├── meta.json                      自定义类目/别名表/客户与供应商/夜间状态；事件日志之外的配置态
├── reports/2026-10.md             可选：派生报表（给人看/Obsidian），永不作为真值
├── exports/ledger-2026-10.csv     导出产物
├── quarantine/bad-2026-10-26.ndjson 坏行隔离（原样保留，不修）
└── .lock                          单写者锁（见 §4.5）
~~~

#### 为什么是"追加日志 + 版本"而不是"改一行"

| 需求 | 就地改写 | 追加快照（选它） |
|---|---|---|
| 崩溃安全 | 写一半文件就废了 | 单行 append + fsync，最坏丢最后一笔 |
| 审计"这笔改过吗" | 无痕 | 全历史可回放：`version 1→2→3` 都在 |
| git diff 友好 | 整文件重写 | 纯追加，diff 就是新增行 |
| 并发/重入 | 需要复杂锁 | 单写者队列 + O_APPEND 原子写 |
| 代价 | — | 文件缓慢变大 → 需要压缩（见下） |

**读取规则**：启动时顺序扫描 `entries.ndjson`，按 `id` 取 `version` 最大的那条作为当前态；同一 `id` 的旧版本留在内存里作为历史（只在 `ledger_query --history` 用）。扫描是纯 CPU 操作，1 万笔约 50ms 量级（每笔 ~350B，文件 ~3.5MB）。

**压缩策略（M3 可选，不是 v1 必需）**：当 `行数 > 活跃记录数 × 3` 或文件 > 8MB 时，写临时文件（每个 id 只留最新版本 + 最近 30 天内的历史），`fsync` 后 `rename` 原子替换，旧文件按 `entries.ndjson.bak-<date>` 留一份。失败不影响主文件。v1 只做 append + 加载 + 坏行隔离。

**meta.json 的写**：与 entries 共用同一条写入队列，写临时文件 + `fsync` + `rename` 原子替换（它是配置态，不参与版本回放）。

#### 与 `ctx.storageDomain` 的取舍（ADR-001）

| 维度 | 纯文件（选择） | `ctx.storageDomain`（备选） |
|---|---|---|
| 用户可读/可 git/可 Obsidian | ✅ 直接就是文本 | ⚠️ 落在宿主 `storages/` 下的 JSON，可读但不是"我的文件" |
| schema 校验 | 自己做（zod，加载时校验） | ✅ `domainTable(zodSchema)` 自带 |
| 原子持久化 | 自己做（tmp+rename / append+fsync） | ✅ 后端保证 |
| 组合依赖 | 零 | 需要 `storage`+`storage-json`+`storage-domain` 三行都在（本机已挂载，但不是所有 profile 都挂） |
| schema 演进 | 记录里带 `schema`，逐条迁移 | `version-mismatch` 直接拒开，要手工迁移 |
| 查询/聚合 | 内存索引，自己写 | 同样要自己写（KV 无索引、无跨表事务） |
| 事件回放/审计 | ✅ 日志天然支持 | ❌ 只留最终值 |

**结论**：账本是"用户自己的东西"，不是宿主内部状态。选文件；若将来要接宿主级工作区/多端，再迁 `storageDomain`（映射关系清楚：`entries` → `domainTable(recordSchema)`，`per-record` 布局）。这条决定写进 `docs/DECISIONS.md`。

### 4.4 `meta.json` 形态

~~~json
{
  "schema": 1,
  "currency": "CNY",
  "timezone": "Asia/Shanghai",
  "day_cutoff_hour": 4,
  "builtin_version": "1.0.0",
  "custom_categories": [
    { "slug": "pet", "label": "宠物", "parent": null, "retired": false },
    { "slug": "pet_food", "label": "宠物食品", "parent": "pet", "retired": false }
  ],
  "aliases": [
    { "pattern": "猫粮", "match": "contains", "l1": "pet", "l2": "pet_food",
      "source": "user", "weight": 5, "hits": 4, "last_hit_at": "2026-10-20T19:00:00+08:00" }
  ],
  "budgets": {
    "version": 2, "period": "month",
    "total_cap_minor": 700000, "warn_bp": 8000, "critical_bp": 10000,
    "categories": [ { "l1": "food", "cap_minor": 120000 } ],
    "overrides": [ { "month": "2026-12", "total_cap_minor": 900000 } ],
    "updated_at": "2026-10-01T09:00:00+08:00"
  }
}
~~~

### 4.5 并发与写安全

- **单写者**：所有写入进一条内存队列（`Promise` 链），串行执行；DSH 一个宿主进程只有一个插件实例，天然单写者。
- **原子追加**：`fs.appendFile(fd, line + "\n")` 后 `fs.fsync(fd)`；单行 < 4KB，POSIX 下 O_APPEND 写是原子的（无需整文件锁）。写完更新内存索引、刷新 brief 快照、再返回。
- **多进程**：不支持（也不该有）。启动时若发现另有一个 `.lock` 且 pid 活着，降级为**只读模式**并明确告诉用户，而不是两边乱写。
- **加载时校验**：逐行 `JSON.parse` + zod；失败行 → 原样追加到 `quarantine/bad-<date>.ndjson` 并在日志里警告，跳过它继续加载。**绝不"猜测性修复"金额或日期**——宁可少一笔可查的账，不可多一笔编造的账。

### 4.6 生意事件（v0.2 新增，book=shop）

一条交易一条事件，**交易与结算写在同一个事件里**（`paid_minor`）——否则"老李拿了两双，六百八，先欠着"要分两句说，父母不会配合。

> **v1 实现范围**：现金与欠款相关的字段/事件（`amount/paid/customer/supplier/channel/payment_method/entered_by`）。`items`、`stocktake` 与成本重放属 M2（父母不记货号，§8.9），数据模型先留着，工具不实现。

- `open_minor = amount_minor − paid_minor − Σ已核销`，是应收/应付的**唯一来源**（不另立欠款表）。
- `status`：`draft` 不进任何派生视图；`confirmed` 全计入；`void` 派生层跳过、合序保留。
- **缺货号、赊/现不明不影响入库**：用 `cost_source` 标 `estimated`/`unknown`，不降 draft——父母不会为了报表回去补货号。

| kind | 必填 | 可选 | 现金 | 库存 | 应收/应付 |
|---|---|---|---|---|---|
| `purchase` 进货 | `amount_minor`, `occurred_on`, `supplier` | `items[{sku,qty,unit_cost_minor}]`, `paid_minor`, `note` | `−paid` | 有 items：+qty 并重算均价；无 items：不动 | 应付 `+amount−paid` |
| `sale` 销售 | `amount_minor`, `occurred_on`, `channel(retail/wholesale/internal)` | `customer`, `items[{sku,qty,unit_price_minor}]`, `paid_minor` | `+paid` | 有 items：−qty | 应收 `+amount−paid`；`customer=散客` 不进账龄 |
| `payment_in` 客户还款 | `amount_minor`, `occurred_on`, `customer` | `applied_to[]`, `payment_method` | `+amount` | 无 | 应收 `−amount`，默认 FIFO 核销 |
| `payment_out` 付供应商 | `amount_minor`, `occurred_on`, `supplier` | `applied_to[]` | `−amount` | 无 | 应付 `−amount` |
| `return` 退货 | `amount_minor`, `occurred_on`, `side(customer/supplier)`, `settle_mode(refund_cash/offset)` | `origin_tx_id`, `items`, `restock`, `refund_minor` | 客户退现：`−refund`；供应商退钱：`+refund` | `restock` 客户退：+qty；退供应商：−qty | 客户：先冲未清应收，余数才退现；供应商：冲应付 |
| `stocktake` 盘点 | `occurred_on`, `lines[{sku,counted_qty}]` | `by`, `note` | 不动 | 设为 counted_qty，成为新基线 | 不动 |
| `draw` 老板取现 | `amount_minor`, `occurred_on` | `in_kind(cash/goods)`, `items`, `to_book(home/external)` | shop `−`；`to_book=home` 时家侧投影 `+` | `in_kind=goods`：−qty，金额取当时均价 | 不动 |
| `transfer` 账本间转移 | `amount_minor`, `from_book`, `to_book` | `note` | from `−` / to `+`（**一条事件，不双写**） | 不动 | 不动 |

**缺省判定（不写死就一定猜错）**

| 情况 | 默认 | 回执要求 |
|---|---|---|
| 销售没说收钱，但有客户名或"赊/欠/过几天/月底结" | `paid_minor=0` → 记应收 | 必须喊出"XX 欠 ¥N" |
| 销售没说收钱，也没客户名 | 视为现金（`paid=amount`） | 回显"按现金记的" |
| 进货没说付钱 | **记已付清**（`paid=amount`），标 `settlement_source:"inferred_default"` | "按付清了记的；要是还欠厂家，说一声我改成赊账"（Yang：进货没有标准结算时间，所以默认不凭空造应付；确实常赊就改 `purchaseSettlementDefault: credit`） |
| 赊账但没客户名 | `customer:"散客"` + `draft` + 一问 | "这是谁拿的？" |
| `channel` 未说 | qty≥3 或金额≥零售均价×3 → wholesale，否则 retail | 回显判成了哪种 |
| 只报总额（"今天卖了480"） | `items=[]`，库存不动，`cost_source=unknown` | 不回显货号（本来就没有） |

~~~json
{"id":"tx_01JB4M2ZQ7","schema":2,"version":1,"kind":"sale","status":"confirmed","book":"shop",
 "amount_minor":50000,"currency":"CNY","occurred_on":"2026-10-26","date_source":"inferred_today",
 "channel":"wholesale","customer":"老陈","paid_minor":0,"settlement_source":"explicit_credit",
 "items":[{"sku":"A1023","qty":5,"unit_price_minor":10000}],
 "category":{"l1":"biz_revenue","l2":"biz_revenue_wholesale","source":"alias","confidence":0.95},
 "cost_source":"exact","note":"老陈拿5双，月底结","tags":["credit"],
 "provenance":{"session_id":"sess_x","message_id":"msg_y","item_index":0,"source_text":"老陈拿5双A1023，一双100，月底结","parser":"llm"},
 "created_at":"2026-10-26T12:01:00+08:00","updated_at":"2026-10-26T12:01:00+08:00","voided_at":null}
~~~

~~~json
{"id":"tx_01JB5A1K3M","schema":2,"version":1,"kind":"payment_in","status":"confirmed","book":"shop",
 "amount_minor":20000,"currency":"CNY","occurred_on":"2026-10-30","date_source":"explicit_relative",
 "customer":"老陈","applied_to":[],"payment_method":"wechat",
 "category":{"l1":"biz_cashflow","l2":"biz_cashflow_receipt","source":"builtin","confidence":1},
 "note":"老陈先还2000",
 "provenance":{"session_id":"sess_x","message_id":"msg_z","item_index":0,"source_text":"老陈还了500","parser":"llm"},
 "created_at":"2026-10-30T19:20:00+08:00","updated_at":"2026-10-30T19:20:00+08:00","voided_at":null}
~~~

### 4.7 派生视图与成本口径（全部是纯函数：入参 = 已排序事件 + asOf）

**全序键写死** `(occurred_on, created_at, id)` 升序，一切重放按它，**禁止依赖 Map / 对象遍历顺序**（否则同一份数据两次报表给出不同账龄，用户发现一次就再不信任）。

~~~text
stock(sku,t)   = 基线 + Σ qty_delta；基线 = 最近一条 <=t 的 stocktake 计数，无则 0
avg_cost(sku,t)= 全序重放 (qty,cost)：进货加 n×unit；销售减 round_half_up(cost×n/qty)
                 舍入差额进 sku.rounding_pool，下次进货并入成本
cogs(sale)     = Σ round_half_up(卖出前 cost × n / 卖出前 qty)
open(tx)       = amount − paid − Σ allocated(tx)
receivable(c)  = Σ open(sale of c)          payable(s) = Σ open(purchase of s)
核销           = applied_to 优先，未指定则 FIFO 摊到最早未清单
aging(c,t)     = 每笔 open 按 t − occurred_on 分桶 (0,30] (31,60] (61,90] (>90]
revenue_net    = Σ sale.amount − Σ return(customer).amount
gross_profit   = revenue_net − (Σ cogs(sale) − Σ cogs(客户退货))
cash(t0,t1)    = Σ sale.paid + Σ payment_in − Σ purchase.paid − Σ payment_out − Σ refund_cash − Σ draw − Σ transfer(out)
~~~

**成本口径：per-sku 移动加权平均，不冻结快照、每次重放。**

| 备选 | 为什么不选 |
|---|---|
| 最近进价 | 同款多批次进价不同（换季/换厂），相邻两双毛利会从赚 80 跳到赚 40，父母不信 |
| 写入时冻结快照 | 补记进货是常态（父母隔几天才报账），冻结会把历史毛利钉死在错值且不能自愈 |
| 重放（采用） | 传入事件数组即可复现、可单测；代价是补记会改变历史毛利 → **必须在报表首行播报 Δ**（沿用 §10.3） |

- **恒等式（单测断言）**：`期末库存成本 + Σ cogs = Σ 进货成本 − Σ 退货冲减`。这条一旦破，说明金额法与数量法串了。
- `cost_source`：`exact`（items 齐全）/ `estimated`（无货号销售按最近 90 天 exact 销售的加权毛利率反推）/ `unknown`（无样本 → 毛利输出 null，报表显示"—"，**不猜**）。
- 报表必须打印**明细覆盖率**（"本月 86% 的销售有货号明细"）：让人知道这个毛利有多可信。

### 4.8 谁记的：`entered_by` 与按人路由（手机端多用户）

Yang 会在公网机器上搭一个手机入口，父母用手机跟 DSH 说话；交互通道不归插件管，但**每笔账必须知道是谁填的**。

- 来源优先级：工具参数 `entered_by`（通道把用户标识/昵称传进来）> 配置 `defaultActor` > `"unknown"`。
- 存盘：事件带 `entered_by`（≤64 字，脱敏后），另在 `meta.json` 的 `actors` 里维护 `{actor_id: 显示名}`，显示名只在给人看的地方出现。
- **按人路由账本**：`meta.json` 记 `lastBookByActor`。妈妈说"卖了480"默认记 `shop`，你说"买菜60"默认记 `home`——否则每句话都要先说"店里/家里"，父母一定会记错。
- 记错账本怎么办：回执永远带 `[店里]`/`[家里]`；说"那是家里的"就 `ledger_fix{action:"move_book"}`（改 book 不是改金额，不动逻辑）。
- 幂等与查重按人算："同一人 + 同金额 + 10 分钟内"才算疑似重复——两个人各记一笔同样的 500 是正常的。
- **权限不在插件里**：插件不做 ACL，也不判断谁能看哪本账。公网入口必须由你的网关按人限制（例：父母的账号只给 `shop`），否则父母能查到你的个人账。这条写进 §16 的风险表。
- 报表默认不显示 `entered_by`：长辈只看数字；只有 `ledger_query` 结果行尾带"· 记的人"，以及查重回执里出现。

---

## 5. 录入：自然语言 → 结构化

### 5.1 分工（这是全篇最重要的一张表）

| 环节 | 模型 | 插件 |
|---|---|---|
| 一句话切成 N 笔 | ✅ 输出 `item_index`（从 0 起）与 `item_total`，`source_text` 一律传**整条消息原文**（不是子串） | 校验 `item_total` 与实际入库笔数是否对得上 |
| 金额 | ✅ **原样抄**用户片段（`"32"` / `"三十二块"` / `"1万2"`） | ✅ 解析为整数分（十进制字符串→分，中文数字→阿拉伯） |
| 日期 | ✅ 可给 `date_expr`（原样："昨天"、"上周三"、"9月3日"）或 `occurred_on` | ✅ **以插件自己的时钟为准**解析 `date_expr`；拦未来；定 `date_source`；日界裁决 |
| 方向（收/支/退） | ✅ 给 `kind` + `evidence` 原文片段 | ✅ 无 evidence 的 income/refund 降级 draft；refund 尝试匹配原单 |
| 类目 | ✅ 给 `category_l1/l2` **候选** | ✅ 别名表优先级更高时可覆盖；算 confidence |
| 商户 | ✅ 从原文抽 | 归一化、去噪 |
| 幂等/去重/落库/追问/报表 | ❌ | ✅ 全部 |

**为什么让插件解析日期**：模型对"上周三"这类相对日期做算术后出错率高，而且它的"今天"取决于上下文快照。插件跑在宿主机上，`now` 唯一、时区固定，解析结果可复现、可测试。所以 `ledger_add` 的契约是：**用户怎么说的，就怎么传（`date_expr`）；插件负责算**。

### 5.2 金额解析（插件侧，确定性）

| 输入 | 规则 | 结果 |
|---|---|---|
| `32` / `32.5` / `¥32` / `￥32.5` / `32元` / `32块` | 去符号，十进制 → 分 | 3200 / 3250 分 |
| `￥1,280.00` | 允许千分位 | 128000 |
| `三十二块` / `两百` / `一百零八` | 中文数字转换（十/百/千/万） | 3200 / 20000 / 10800 |
| `1.2k` / `1.5w` / `1万2` | k=×1000，w/万=×10000；`1万2`=12000 元（不是 1.2 万） | 120000 / 1500000 / 1200000 分 |
| `大概三十几` / `差不多50` | 模糊词 → **拒绝该条**（`E_AMOUNT_AMBIGUOUS`） | — |
| `0` / `-5`（expense） / `>1e9` | 拒绝（`E_AMOUNT_INVALID`） | — |

精度处理：解析为"分"时只在最后一步做四舍五入（`round(dec * 100)` 用整数运算：`parseInt(intPart)*100 + parseInt(fracPart.padEnd(2,'0').slice(0,2))`，多出的小数位丢弃并回显提示）。阈值：金额上限 1e9 分（1000 万元），超出视为误输入。

### 5.3 日期解析（插件侧，固定时区 + 日界）

| 输入 | 解析 | `date_source` |
|---|---|---|
| 无 | 今天；若 `localHour < day_cutoff_hour(4)` 且上下文是"刚才/今天"→ 归前一天（夜宵场景） | `inferred_today` |
| `今天/刚才` | 今天 | `explicit_relative` |
| `昨天/前天/大前天` | today−1/−2/−3 | `explicit_relative` |
| `上周三` | 上一个完整自然周（周一为始）的周三 | `weekday` |
| `这周三/周三` | 本自然周的周三；若已过则本周那天，**若落在未来 → draft + 一问** | `weekday` |
| `9月3日 / 9.3 / 9/3` | 当年；若解在未来 → 回退上一年 + 确认 | `explicit_abs` |
| `上个月12号 / 本月5号` | 明确月偏移 | `explicit_abs` |
| `2026-09-03` | 直接用 | `explicit_abs` |
| `明天 / 下周 / 明年1月` | **拒绝**（`E_FUTURE_DATE`） | — |
| `9月3日` 且 `>today` | 回退上一年；若回退后 > 2 年 → 拒绝并要求带年份 | `explicit_abs` |

区间约束：`2000-01-01 ≤ occurred_on ≤ today + 1`（允许 +1 以容忍跨时区边界，但不接受"明天"这种明确未来语义）。

### 5.4 方向判定（收/支/退/转）

| 线索 | 判定 | 例外 |
|---|---|---|
| 到账 / 收入 / 工资 / 发薪 / 报销到账 / 报下来 | `income` | "信用卡到账" → `transfer` |
| 退款 / 退我 / 退回来 / 还回来 | `refund` + 匹配原单 | 无原单 → draft + 一问 + 附 30 天内候选 |
| 还了 / 还款 | 还**朋友**（有具体人）→ `expense(social)`；还**信用卡**（明确是卡）→ `transfer`（不计收支，记 `tags:["card_payment"]`） | 只有"还了3000"没有对象 → 必问一次 |
| 转账 / 充值 / 提现 / 还信用卡 | `transfer`（不计收支） | 模糊 → `expense` + draft |
| 我付了 / 垫付 / 先付 | `expense` + `tags:["advance"]` | 报销见 §12.2 |
| AA / 分摊 / 各付各 | 只记**自己应付份额** + `tags:["aa"]`，原文金额进 `note` | 余数归自己并回显 |

**为什么退款是独立 `kind` 而不是负支出**：负支出会污染"支出合计/占比/毛利"三处口径（要不要把负数算进去？占比的分母变谁？）。独立 `kind` + `original_tx_id` 让净额 = `expense − refund` 由报表层显式计算，口径唯一且可解释。

### 5.5 歧义策略（硬阈值，不许"猜得有道理"）

| 触发条件 | 动作 |
|---|---|
| 日期缺失 | 用今天（`inferred_today`）+ confirmed；回复**回显日期** |
| 裸星期且解在未来 | 不猜：draft + 一问（"周五是指 10-23 还是 10-30？"） |
| 绝对日期跨年 | draft + 一问 |
| 金额无法解析 / ≤0 / >1e9 | 拒绝该条，其余照常入库；回复列出被拒原文 |
| `item_total` 与实际到达的 `ledger_add` 笔数不等，或金额条数 ≠ 条目数 | 已入库的改 draft + 一问，并给两种切分可能 |
| `kind` 无 `evidence` 且置信 < 0.8 | draft + 一问 |
| `refund` 无原单 | draft + 一问 + 候选列表 |
| 类目置信 < 0.5 | `other` + draft + 一问 |
| 疑似重复（§5.6） | 照写 + 警告 + 给既有 id，由用户决定删哪笔 |
| 一次回复中的提问数 | **最多 1 个**；多笔待定合并成清单式提问 |

统一句式（插件产出，模型照抄即可）：`已记 2 笔，1 笔待确认：咖啡那笔是 25 还是 25.5？`

### 5.6 幂等与去重

**幂等（同一笔被重复提交）**

- `request_id = "req_" + sha256(session_id | message_id | tool_name | item_index | payload_hash)[0:12]`。
- 相同 `request_id` 二次进入 → **不写库**，返回首次结果 + `replayed: true`。
- **模型不能传 `request_id`**：幂等键只由插件派生（模型编的 id 会让幂等失效）。同 `request_id` 不同 payload → `E_IDEMPOTENCY_CONFLICT`（不改已有记录，返回首次结果 + `replayed: true`）。
- `message_id` 在工具的 `exec` 上下文里是否可得 **UNVERIFIED**（附录 A.2）；退化方案：`session_id | turn_index | item_index`。
- 幂等只在"同一请求重放"时拦；不同请求的疑似重复走 §5.6 表的时间窗规则，返回 `duplicate_warning`，交给用户决定。

**去重（不同请求但可能是同一笔）**

| 场景 | 判据 | 动作 |
|---|---|---|
| 同消息内重复（同 `item_index`、同 payload） | `request_id` 相同 | 幂等拦截，静默 |
| 已有记录的 `created_at` 与本次 `now` 相差 <10 分钟，且同 `occurred_on` + 同 `amount_minor` + 同 `l2`、`note` 相似度 ≥0.8 | 时间窗比较（`dedupe_key` 只做**内容归组**，不编码时间） | **照写不拦截**，结果里带 `duplicate_warning` + 既有 id："⚠️ 疑似重复（已有一笔 10-25 午饭 32），要删掉新的吗？" |
| 用户明说"记两杯" | `allow_duplicate: true` | 直接写 |
| 同日同额同类别、间隔 >10 分钟 | 仅提示不判定 | 一天两杯 25 元咖啡是合法的 |

**不做**全局唯一约束：同额同类别同日多笔是真实生活。

### 5.7 生意侧的语言线索（book=shop）

| 用户说的话 | 判定 | 关键参数 |
|---|---|---|
| 卖了 / 卖出 / 零售 / 收了多少 | `kind=sale`，`channel=retail` | `paid` 省略=全款现金 |
| 批 / 批发 / 给同行 / 拿货 / 出货 N 双 | `kind=sale`，`channel=wholesale` | 有客户名 + "赊/欠/月底结/过几天" → `paid="0"` |
| 进 / 进货 / 上了 / 厂家发了 / 老王那儿的 | `kind=purchase` | `supplier`；付了多少写 `paid`，没说付 → 待 Yang 定默认 |
| 还了 / 给了 / 打过来了（指向客户） | `kind=payment_in` | `customer`；金额是该次还的钱，不是欠款总额 |
| 我付了 / 结账了（指向供应商） | `kind=payment_out` | `supplier` |
| 退了 / 退回来 / 说不合适 / 换了一双 | `kind=return`，`side=customer` | 换货按 §12.15 拆两笔 |
| 退给厂里 / 退回厂家 | `kind=return`，`side=supplier` | 退的现金记 `refund_minor`，不是 income |
| 盘点 / 数了一下 / 实际还有 | `kind=stocktake` | 只给数量，不给金额 |
| 从店里拿了 X 回家 / 自己穿了 / 送人了 | `kind=draw` | `to_book=home` 或 `in_kind=goods` |
| 留两双 / 给我留着 / 订了还没给钱 | **不落库**（`dry_run` 或只回一句"记着了"） | 见 §12.20 与 §18.5 #3 |

**三条铁律**：

1. **赊账绝不记成收入**：`paid="0"` 的 sale 只增应收，不增现金；回执必须喊"XX 欠 ¥N"（这是长辈唯一真看的一行）。
2. **"还了"不是收入**：`payment_in` 只冲应收、只增现金，收入为 0（§18.4 断言）。
3. **只报总额就只报总额**：不许从金额反推数量、不许猜货号；缺货号就让 `cost_source=unknown`，报表打覆盖率。

**回执规范**（长辈视角，完整版见 §18.5 与 `.agents/notes/shop-ux-v2.md`）：≤4 行；必须回显日期（写"今天/昨天/10 月 24 号"）、金额（¥680）、对象（人/货号/事由）、**与人有关就带余额**；不出现英文字母、编号、"分"、"草稿/已确认"；两本账都带 `[店里]`/`[家里]`。

---

## 6. 分类体系

### 6.1 内置两级类目（12 支出 + 6 收入）

| 组 | L1 slug | 中文 | L2（slug/中文） | 起始关键词 |
|---|---|---|---|---|
| 支 | `food` | 餐饮 | lunch/午餐 · dinner/晚餐 · breakfast/早餐 · coffee/咖啡饮品 · delivery/外卖 · gathering/聚餐 · snack/零食夜宵 · alcohol/酒水 | 午饭 晚饭 早饭 外卖 咖啡 奶茶 瑞幸 星巴克 麦当劳 肯德基 海底捞 烧烤 夜宵 |
| 支 | `transport` | 交通 | taxi/打车 · metro/公交地铁 · train/火车高铁 · flight/机票 · fuel/加油 · parking/停车过路 · bike/共享单车 | 打车 滴滴 高德 地铁 公交 高铁 12306 机票 加油 停车 共享单车 |
| 支 | `shopping` | 购物 | daily/日用 · clothes/服饰 · digital/数码 · supermarket/超市生鲜 · beauty/美妆 · home/家居 | 淘宝 京东 拼多多 天猫 优衣库 盒马 山姆 屈臣氏 小米 无印良品 |
| 支 | `housing` | 居住 | rent/房租 · utilities/水电燃气 · property/物业 · repair/维修装修 · mortgage/房贷 | 房租 租金 链家 自如 水费 电费 燃气 物业 维修 房贷 |
| 支 | `communication` | 通讯 | phone/话费 · broadband/宽带 · subscription/会员订阅 · cloud/云服务 | 话费 移动 联通 电信 宽带 会员 腾讯视频 网易云 iCloud |
| 支 | `health` | 医疗 | clinic/门诊 · pharmacy/药店 · hospital/住院 · checkup/体检 · fitness/健身 | 医院 挂号 药 药店 诊所 体检 健身房 牙科 |
| 支 | `education` | 教育 | course/课程 · book/书籍 · exam/考试报名 · training/培训 | 课程 学费 书 网课 考试 培训 得到 极客时间 |
| 支 | `entertainment` | 娱乐 | movie/电影演出 · game/游戏 · travel/旅行 · sports/运动 · leisure/休闲 | 电影 演出 演唱会 游戏 Steam 旅行 酒店 门票 |
| 支 | `social` | 人情 | gift/礼品 · redpacket/红包礼金 · treat/请客 · wedding/婚丧 | 礼物 红包 随礼 份子钱 请客 生日 |
| 支 | `finance_insurance` | 金融保险 | insurance/保险 · fee/手续费 · interest/利息 · investment/投资 | 保险 保费 手续费 利息 基金 股票 |
| 支 | `work` | 工作 | equipment/办公设备 · business_trip/差旅 · meal_work/工作餐 · coworking/工位 | 办公 差旅 打印 工位 团建 |
| 支 | `other` | 其他 | other/未归类 · donation/捐赠 · fine/罚款 | 捐赠 罚款 |
| 收 | `salary` | 工资 | base/基本工资 · overtime/加班费 | 工资 薪水 发薪 到账 |
| 收 | `bonus` | 奖金 | year_end/年终奖 · commission/提成 · allowance/补贴 | 奖金 年终奖 提成 补贴 绩效 |
| 收 | `investment_income` | 理财 | interest/利息 · dividend/分红 · fund/基金收益 | 利息 分红 收益 理财 |
| 收 | `reimbursement` | 报销 | company/公司报销 · travel/差旅报销 | 报销 报下来 |
| 收 | `gift_money` | 礼金 | redpacket/红包 · wedding/礼金 | 红包 礼金 压岁钱 |
| 收 | `other_income` | 其他收入 | refund_other/退款转入 · sale/二手转卖 · side/副业 | 转卖 闲鱼 副业 |

### 6.2 匹配优先级

| 序 | 规则 | 分数 | 示例 |
|---|---|---|---|
| 1 | `exact` 别名/商户名（correction > user > builtin） | 8.0 | 用户别名"公司楼下的咖啡" |
| 2 | `contains` 别名（≥2 字且不是"吃/买/付"这类通用词） | 6.0 + weight×0.1 | "瑞幸" ⊂ "瑞幸咖啡"、"猫粮" ⊂ "买猫粮" |
| 3 | L2 关键词 / 商户词典 | 5.0 | "星巴克"→food_coffee |
| 4 | L1 关键词 | 3.0 | "打车"→transport |
| 5 | 模型语义候选（仅无别名命中时） | confidence × 0.6 | "跨城见客户" |
| 6 | 兜底 `other` | 强制 draft | "买了个东西" |

同分取**最长匹配**，再取 `hits` 高，再取新。示例：`盒马`（shopping/supermarket）对 `盒马外卖`（food/delivery）→ 取后者。

### 6.3 教它分类（纠错学习）

1. 用户说"这笔算交通" → `ledger_fix` 改类目，版本 +1；
2. 插件从该笔 `note + source_text` 抽候选词（去停用词、取 2–6 字的专名，如"钉钉打车"里的"钉钉"）；
3. **同一候选词第 2 次被纠正**或用户明说"以后都算 X"→ 才写入 `meta.json.aliases`（`source:"correction"`）；
4. 回复必须明示："已记住：钉钉 → 交通/打车"（否则用户不知道规则改了）。

**内置版本升级不得覆盖 `source ∈ {user, correction}` 的别名**——只 append 新内置项。类目只能 `retired: true` 软停用，不删（历史记录还指着它）。

### 6.3 生意类目（book=shop）

| 组 | L1 | L2 |
|---|---|---|
| 收 | `biz_revenue` 营业收入 | retail 零售 · wholesale 批发 · internal 内部（仅换货/自用配平） |
| 收 | `biz_other_income` 营业外 | rebate 供应商返点 · shipping_in 买家承担运费 · scrap 废品 |
| 支 | `biz_rent` 房租 · `biz_utilities` 水电燃气 · `biz_packaging` 包装（鞋盒/袋） · `biz_shipping` 运费 · `biz_labor` 雇工 | — |
| 支 | `biz_repair` 装修维修 · `biz_marketing` 招牌广告 · `biz_entertain` 业务招待 · `biz_transport` 拉货油费 · `biz_fee` 市场管理费/手续费 · `biz_loss` 损耗 · `biz_other` 其他 | — |
| 流转 | `biz_cashflow` 资金流转（`payment_in/payment_out/draw/transfer` 专用，**不计收支**） | receipt 收款 · payment 付款 · draw 取现 · transfer 转移 |

### 6.4 账本隔离（这条违反一次，报表就永久算错）

- **类目前缀即账本归属**：`biz_*` 只能出现在 `book=shop`；家庭 12+6 类只能出现在 `book=home`；越界 → `E_CATEGORY_BOOK_MISMATCH`，回一句"这是店里的还是家里的？"。
- 同一个词按 book 路由：说"吃饭"，home → `food_gathering`，shop → `biz_entertain`。别名表的唯一键是 `(book, pattern)`，不是 `pattern`。
- 报表绝不混算：利润表只加 shop，家庭月报只加 home；`draw`/`transfer` 两边都不进收入支出，只进"老板取走 / 老板投入"。
- **一个 `entries.ndjson` + `book` 字段，不建第二个账本目录**：第二个目录就是双写，双写就有两份幂等与两份漂移。

---

## 7. 工具面（模型看见的 6 个）

### 7.1 一览

| 工具 | 用途 | 写库 | 主要入参 | 返回（`render` 出 Markdown） |
|---|---|---|---|---|
| `ledger_add` | **唯一写入口**：家庭收支 + 全部生意事件 | ✅ | `book?`, `kind?`, `amount`, `date_expr?`/`occurred_on?`, `paid?`, `customer?`/`supplier?`, `channel?`, `items?`, `category_l1/l2?`, `merchant?`, `note?`, `tags?`, `source_text?`, `item_index?`, `item_total?`, `allow_duplicate?`, `dry_run?` | 已记/待确认/被拒 + **账本标签** + 与人有关的账必带余额（"老李欠 ¥680"） |
| `ledger_query` | 查流水（"是不是加过"） | ❌ | `book?`, `from`/`to`/`month`, `q?`, `kind?`, `category_l1?`, `min_amount?`, `include_void?`, `limit?` | 命中行（含 `occurred_on` 与 `created_at`）+ 空档日 |
| `ledger_report` | 日/月/区间/年 + **经营月报** | ❌ | `period: day|month|range|year`, `date?`/`month?`/`from`+`to`, `book?`, `view?: cash|accrual|both`, `format?: markdown|json` | 报表（§8 模板）或 JSON payload |
| `ledger_debt` | **谁还欠我 / 我欠谁** + 账龄 | ❌ | `book?`, `side?: receivable|payable`, `customer?`, `as_of?`, `min_amount?` | 按人排序的欠款表 + 账龄桶 + 每人的最近一笔（§8.8） |
| `ledger_fix` | 改一笔 / 作废 / 恢复 / 确认草稿 / 换账本 | ✅ | `target_id` 或 `match:{pick:"last"}`；`patch?`；`action?: void|restore|confirm|unconfirm|move_book`；`expected_version?` | 变更前后快照（"580 → 680"）+ 受影响人的余额 |
| `ledger_export` | 导出 CSV / Markdown / JSON，并刷新 Obsidian 文件 | ❌ | `format`, `book?`, `period?`/`from`+`to`, `refresh_obsidian?` | 文件路径 + 行数（路径限于 `dataDir/exports`） |

设计取舍：
- **`ledger_add` 只收一笔**（不是批量）。批量 schema 更复杂、错误定位更难；PTC 模式下模型循环调用即可。多笔"原子性"其实不需要——一笔成功一笔失败可以分别确认，反而更不容易丢账。
- **只有 1 个写工具**（不给生意另开 `shop_sale`/`shop_purchase`…）。工具每多一个都进常驻 prompt，而且模型"选错工具"比"填错参数"更贵、更难纠：`kind` 写错还能在插件里按线索纠正并回执提示，工具选错就整条语义丢在另一个形状里了。生意语义靠 `kind` 枚举 + 必填校验表达。
- **不给父母创建预算工具**：Yang 拍板不用预算，§8.3 的预算段一并删。
- **欠款必须有独立只读工具**（`ledger_debt`），不能挤进 `ledger_report`：它是高频单问题（"老李欠多少"），走报表会返回一大堆无关数字，又慢又费 token。
- **v1 不做 `ledger_stock`**：Yang 拍板父母不记货号，没有货号就没有可信库存；库存与毛利整体推到 M2，且只走"盘点"这一个数量入口（§8.9）。少一个工具，周末就少一个做不完的理由。
- **`ledger_report` 不缓存**。每次现算（万笔内 <20ms），避免"报表是快照还是真值"的口径问题（见 §10.4）。
- 参数以**扁平**为主（dsh-tools 的 schema DSL：`{ type:'string', required:true }`）。只有 `ledger_fix` 的 `match`/`patch` 用 `object`（DSL 支持 object，见附录 A.2；嵌套写法的确切字段见 §19.3 U3，实现期先做 5 分钟实验）。

### 7.2 一个真实工具定义（照这个写其余 5 个）

~~~js
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'ledger_add',
  description:
    '记一笔收支。amount 原样抄用户说的话（如 "32"、"三十二块"、"1万2"），由插件解析为分；'
    + '日期优先传 date_expr（"昨天"/"上周三"/"9月3日"），插件用本机时钟解析，不要自己算日期；'
    + 'category_l1/l2 只是候选，插件别名表可覆盖。返回已记/待确认/被拒，以及本月累计。',
  parameters: {
    amount: { type: 'string', required: true, description: '金额原文，如 "32.5"、"¥32"、"三十二块"、"1万2"。' },
    book: { type: 'string', description: 'home（家里）| shop（店里）；说了"店里/家里"就按它，没说沿用上一笔的账本。' },
    kind: { type: 'string', description: '家庭：expense|income|refund|transfer|adjustment；店里：sale|purchase|payment_in|payment_out|return|stocktake|draw|transfer；省略时按线索推断。' },
    paid: { type: 'string', description: '这笔实际收到/付了多少钱（原文）。销售/进货用：全款省略，赊账写 "0"，部分付写实际金额。' },
    customer: { type: 'string', description: '客户名（赊账必填；散客写 "散客"）。' },
    supplier: { type: 'string', description: '供应商名（进货用）。' },
    channel: { type: 'string', description: 'retail 零售 | wholesale 批发 | internal 内部；省略时按数量/价格推断。' },
    items: { type: 'array', items: { type: 'object' }, description: '货品明细 [{sku, qty, unit_price} 或 {sku, qty, unit_cost}]；只报总额时省略（库存不动）。' },
    date_expr: { type: 'string', description: '用户说的日期的原始片段，如 "昨天"、"上周三"、"9月3日"；省略=今天。' },
    occurred_on: { type: 'string', description: '已确定的 ISO 日期 YYYY-MM-DD；与 date_expr 冲突时以 date_expr 为准。' },
    category_l1: { type: 'string', description: '一级类目 slug 候选，如 food。' },
    category_l2: { type: 'string', description: '二级类目 slug 候选，如 food_lunch。' },
    merchant: { type: 'string', description: '商户名（从原文抽取），如 瑞幸咖啡。' },
    note: { type: 'string', description: '备注，通常取原文片段，如 "午饭"。' },
    tags: { type: 'array', items: { type: 'string' }, description: '横切标记，如 aa、advance、installment。' },
    evidence: { type: 'string', description: '该笔在原文中的片段（用于审计收入/退款判定）。' },
    source_text: { type: 'string', description: '整条用户消息原文，用于去重与溯源。' },
    item_index: { type: 'integer', description: '该笔在同一条消息中的序号（从 0 起），用于幂等键。' },
    item_total: { type: 'integer', description: '这条消息一共切出几笔（用于校验有没有漏/多切）。' },
    allow_duplicate: { type: 'boolean', description: '用户明确说记了两笔同样金额时传 true。' },
    dry_run: { type: 'boolean', description: '只解析不落库，用户还在确认时用。' }
  },
  output: {
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        created: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true },
          occurred_on: { type: 'string', required: true },
          amount_minor: { type: 'integer', required: true },
          kind: { type: 'string', required: true },
          status: { type: 'string', required: true },
          category_l1: { type: 'string', required: true },
          category_l2: { type: 'string', required: true },
          merchant: { type: 'string', required: true },
          note: { type: 'string', required: true }
        } } },
        rejected: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          code: { type: 'string', required: true }, message: { type: 'string', required: true }
        } } },
        duplicates: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true }, occurred_on: { type: 'string', required: true },
          amount_minor: { type: 'integer', required: true }, note: { type: 'string', required: true }
        } } },
        questions: { type: 'array', required: true, items: { type: 'string' } },
        replayed: { type: 'boolean', required: true },
        month_to_date: { type: 'object', required: true, additionalProperties: false, properties: {
          month: { type: 'string', required: true },
          expense_minor: { type: 'integer', required: true },
          income_minor: { type: 'integer', required: true },
          budget_cap_minor: { type: 'integer', required: true },
          used_bp: { type: 'integer', required: true }
        } }
      }
    },
    render: (_args, v) => [{ type: 'text', text: renderAddResult(v) }]
  },
  async execute(args, exec) {
    return ledger.add(args, { signal: exec.signal, agentId: exec.agent?.id })
  }
}))
~~~

要点：`output.schema` 写死返回形状（`additionalProperties:false`）；错误靠 `throw new Error(...)`（模型会看到 `Error: <msg>`），因此**错误文案要写成模型能转述给用户的人话**；较长的人类可读格式放在 `render` 里，不塞进 schema。

### 7.3 工具错误 → 用户人话（映射表）

| 代码 | 触发 | 模型看到的 `Error:` 文案 |
|---|---|---|
| `E_AMOUNT_INVALID` | 金额 ≤0 / 超上限 / 非数字 | 金额没看懂（原文："…"），请确认这笔记多少 |
| `E_AMOUNT_AMBIGUOUS` | "大概三十几" | 金额是估的，先不记账；确认具体金额再记 |
| `E_FUTURE_DATE` | "明天" | 不能记未来的账；这笔想记到哪天？ |
| `E_DATE_AMBIGUOUS` | 裸星期落在未来 | "周五"是指 10-23 还是 10-30？ |
| `E_VERSION_CONFLICT` | 并发改同一笔 | 这笔记被别人改过（当前 ¥35），要按旧值覆盖吗？ |
| `E_NOT_FOUND` | id 不存在 / 已 void 且要改 | 没找到这笔（可能已作废）；要不要先查最近的？ |
| `E_IDEMPOTENCY_CONFLICT` | 同 request_id 不同内容 | 这次提交与上一次同请求内容不一致，已忽略 |

**原则**：错误是给"用户"看的，不是给开发者看的。堆栈留在 `ctx.logger`，别进模型。

---

## 8. 报表规格

报表是插件对外的"产品界面"：它必须**在聊天里直接好看**（Markdown，无 HTML），且数字与 JSON payload 一一对应（看板/导出复用同一份计算）。

### 8.1 数字格式约定

| 项 | 规则 |
|---|---|
| 金额展示 | **一律两位小数 + 千分位**：`¥1,286.50`、`¥32.00`（代码里 `money(minor)` 只有一个实现，别在别处手拼） |
| 百分比 | 一位小数（`45.6%`）；内部计算用**万分比整数** `share_bp`，四舍五入只在展示层做 |
| 趋势条 | `█` 重复 `max(1, round(v / max_v * 12))` 次（`v>0` 才画） |
| 环比 | `支出 +¥718.00 (+13.2%)`；分母为 0 时写 `上月无数据` |
| 空数据 | 明确写"这一天没有记录"，不输出空表 |

### 8.2 日报

~~~markdown
## 2026-09-02 周三 · 支出 ¥2,800.00 · 收入 ¥0.00 · 净 −¥2,800.00

| 类目 | 金额 | 占比 | 笔数 |
|---|---|---:|---:|
| 居住/房租 | ¥2,800.00 | 100.0% | 1 |
| **合计** | **¥2,800.00** | **100.0%** | **1** |

- 大额提醒：居住 ¥2,800.00 占本月支出的 45.6%（本月最大单笔）
- 较昨日：+¥2,800.00（昨日无记录）
~~~

### 8.3 月报（字面示例，实现按此逐字比对）

~~~markdown
## 2026-09 月报 · 支出 ¥6,138.00 · 收入 ¥18,446.40 · 净 +¥12,308.40
环比 8 月：支出 +¥718.00 (+13.2%) · 收入 −¥126.40 (−0.7%) · 净 −¥844.40 (−6.4%)

### 支出结构（9 类 / 58 笔）
| # | 类目 | 金额 | 占比 | 笔数 |
|---:|---|---:|---:|---:|
| 1 | 居住 housing | ¥2,800.00 | 45.6% | 1 |
| 2 | 餐饮 food | ¥1,286.50 | 21.0% | 28 |
| 3 | 购物 shopping | ¥864.00 | 14.1% | 6 |
| 4 | 交通 transport | ¥412.30 | 6.7% | 14 |
| 5 | 娱乐 entertainment | ¥289.00 | 4.7% | 3 |
| 6 | 人情 social | ¥200.00 | 3.3% | 2 |
| 7 | 通讯 communication | ¥129.00 | 2.1% | 2 |
| 8 | 医疗 health | ¥96.00 | 1.6% | 1 |
| 9 | 其他 other | ¥61.20 | 1.0% | 1 |
| — | **合计** | **¥6,138.00** | **100.0%** | **58** |

### 收入（3 类 / 5 笔）
工资 ¥18,000.00 · 报销 ¥320.00 · 理财 ¥126.40

### 商户 Top 5
1. 链家房租 ¥2,800.00（1 笔）
2. 盒马鲜生 ¥476.20（6 笔）
3. 美团外卖 ¥342.50（16 笔）
4. 滴滴出行 ¥218.30（14 笔）
5. 星巴克 ¥186.00（10 笔）

### 周趋势（支出）
W1 09-01~09-07  ████████      ¥1,240.00
W2 09-08~09-14  ██████████    ¥1,586.30
W3 09-15~09-21  ████████████  ¥1,968.00
W4 09-22~09-28  ██████        ¥1,002.70
W5 09-29~09-30  ██              ¥341.00

另有 2 笔待确认（不计入以上合计）；说"看看待确认"可查看。

> 各项占比按万分比独立取整，逐项相加可能不是 100.0%（这里合计 100.1%）——这是展示层的舍入，不是数据不一致。
~~~

### 8.4 区间报表

~~~markdown
## 2026-09-01 ~ 2026-09-15 · 15 天 · 支出 ¥3,479.30 · 日均 ¥231.95
收入 ¥18,000.00 · 净 +¥14,520.70
最大单笔：房租 ¥2,800.00（09-02，占 80.5%）
~~~

趋势分桶：区间 ≤7 天按日；>7 天按 `ceil(天数/7)` 周桶。年报表（`period: year`）复用月报结构，趋势换成 12 个月桶。

### 8.5 机器可读 payload（与 8.3 数字一一对应）

~~~json
{
  "period": { "kind": "month", "key": "2026-09", "start": "2026-09-01", "end": "2026-09-30", "tz": "Asia/Shanghai" },
  "currency": "CNY",
  "expense_minor": 613800, "income_minor": 1844640, "net_minor": 1230840,
  "refund_minor": 0, "record_count": 58,
  "excluded": { "draft": 2, "void": 1, "transfer": 3 },
  "by_category": [
    { "l1": "housing", "label": "居住", "expense_minor": 280000, "refund_minor": 0, "share_bp": 4562, "count": 1 }
  ],
  "by_income_category": [ { "l1": "salary", "income_minor": 1800000, "share_bp": 9758 } ],
  "top_merchants": [ { "name": "链家房租", "amount_minor": 280000, "count": 1 } ],
  "buckets": [ { "label": "W1", "start": "2026-09-01", "end": "2026-09-07", "expense_minor": 124000 } ],
  "comparison": { "prev_key": "2026-08", "expense_delta_minor": 71800, "expense_delta_bp": 1325,
                  "income_delta_minor": -12640, "net_delta_minor": -84440 }
}
~~~

**口径定义（写进代码注释，别再讨论）**

- `expense_minor` = Σ kind=expense 且 status=confirmed − Σ kind=refund（按类目分别扣，合计同理）
- `income_minor` = Σ kind=income；`net_minor = income − expense`
- `transfer` 与 `adjustment` 不进收支，只在 payload 的 `excluded` 里计数（adjustment 只修正余额类场景，v1 只用于导入对账）
- `draft` 不进任何合计；报表尾部单独一行 `另有 2 笔待确认`（可点开/查询）

### 8.6 报表缓存？不缓存（§10.4）

`ledger_report` 每次现算。写 `reports/*.md` 只是"给人看/放 Obsidian 的派生物"，带 `> 生成于 2026-10-26 11:20，数字以聊天里为准` 抬头，被补记影响时**直接重写**（因为它是派生品，不是账）。

### 8.7 经营月报（book=shop，字面示例）

~~~markdown
## 2026-09 经营月报 · 销售额 ¥20,700.00 · 毛利 ¥6,500.00 · 利润 ¥1,840.00
零售 ¥12,400.00（42 笔）· 批发 ¥8,600.00（7 笔）· 退货 −¥300.00
已售成本 ¥14,200.00（31.4% 毛利率）· 店铺开支 ¥4,660.00

### 钱（现金口径，和抽屉对得上）
收 ¥19,700.00（现卖 ¥17,600 + 收欠款 ¥2,400 − 退货退现 ¥300）
付 ¥15,660.00（进货 ¥9,800 + 开支 ¥4,660 + 付供应商 ¥1,200）
**现金净 +¥4,040.00**

### 外面
还欠我 ¥2,800.00（3 人，最长 44 天）· 我欠人 ¥800.00
赊出去 ¥3,400.00 · 收回来 ¥2,400.00

### 明细覆盖率
本月 86% 的销售记了货号；未记货号的按同类毛利率估算（estimated）——毛利仅供参考。
~~~

三条线必须同时出现，且标题里写清口径：**销售额/毛利是权责口径（含赊销），现金净是实收实付**。

> **v1 只出前两段（"钱"与"外面"）**："已售成本/毛利/覆盖率"整段是 M2（没有货号就没有可信成本，§8.9）。v1 的经营月报标题改成 `2026-09 店里 · 卖 ¥20,700.00 · 现金净 +¥4,040.00 · 还欠我 ¥2,800.00`，不给毛利数字。

### 8.8 欠款表（`ledger_debt`）

~~~markdown
## 还欠我（shop）· 合计 ¥2,800.00 · 3 人
| 客户 | 欠款 | 最早欠 | 账龄 | 最近一笔 |
|---|---:|---|---|---:|
| 老陈 | ¥1,600.00 | 08-14 | 44 天 ⚠️ | 09-28 还 ¥400 |
| 王姐 | ¥800.00 | 09-10 | 17 天 | 09-10 批发 12 双 |
| 老李 | ¥400.00 | 09-22 | 5 天 | 09-22 零售 1 双 |
~~~

规则：按账龄降序；>30 天打 ⚠️；每人必须给"最近一笔"，否则父母不知道这是哪次欠的；散客赊账单独归到"散客"，不进人账龄。

### 8.9 库存与成本（**v1 不做，推 M2**）

**为什么不在这版做**：Yang 拍板父母**不愿意记货号**，而没有货号就没有可信库存——按金额反推数量只会让数字看起来准、其实是错的。宁可先不给这个数，也不要给一个会被用来下决策的假数。

M2 的做法（先记着，别实现）：

- **数量唯一入口是盘点**（`stocktake`）：父母隔一段时间数一下"某货号还有几双"，其余时间不维护。
- 库存 = 最近一次盘点基线 + 之后带 `items` 的进货/销售增减；没有盘点就显示"未盘点"，不显示估值。
- 毛利：只在"有货号且覆盖率 ≥ 60%"时才输出，否则一律显示"未核算"；成本按 per-sku 移动加权平均（§4.7 的算法保留，用来保证将来接上时口径一致）。
- 负库存只告警、不自动抹平（自动修会把账变成猜的）。

### 8.10 「谁记的」（entered_by）

父母在手机上记、你在电脑上记，同一个账本会有多个录入者。每条事件带 `entered_by`，规则见 §4.8；报表**默认不显示它**（长辈看数字，不看人），只有两种场景出现：

- `ledger_query` 的结果行尾带 `· 记的人`（排查"这笔是谁记的/是不是记重了"时最有用）；
- 同一人同一金额 10 分钟内出现两次 → 回执加一句"10 分钟前刚记过一笔一样的，是不是重了？"（§5.5）。

---

## 9. 常驻上下文：brief 与 skill

### 9.1 brief（可选注入，默认开）

在每次会话装配时注入一条极短摘要，让模型不必先查就能说"本月已花 X"：

~~~text
账本 2026-10：支出 ¥3,240.50；今日 ¥86.00（3 笔）；最后记账日 10-25。
记账就用 ledger_add；要明细用 ledger_report。
~~~

| 项 | 决定 |
|---|---|
| 注入方式 | `ctx.systemPrompt.context({ name:'ledger-brief', order: 120, text })` |
| 长度上限 | ≤ `briefMaxChars`（默认 240）；超了先砍"今日"，再砍"最后记账日" |
| 数据来源 | **内存缓存快照**：任何 entries/meta 写入（含 Remote 改类目/客户）后立即重建，`text()` 里不做任何 IO（宿主明确要求 prompt 构建同步无副作用） |
| 门控 | `config.brief` 且有缓存才注入；缓存为空时注入一句空态。返回 `''` 即不注入 |
| 隐私开关 | 这段会发给远端模型（只有数字，无商户/无流水/无 id）；不想要就 `brief: false` |
| 失败态 | 文件被外部删了 → 继续用缓存，不阻塞会话；缓存从未建立 → 空态一句话，失败静默 |

### 9.2 ledger skill（记账协议，常驻 0 token）

用 `ctx.skills.register()` 注册一个内置 skill `ledger`：正文只在模型调用 `skill` 工具时才载入（官方明确：skill 正文不进 system prompt，只有一条目录消息），所以**规则写多细都不烧日常 token**。

~~~js
const dispose = ctx.skills.register({
  name: 'ledger',
  description: '个人账本：把聊天里的收支整理归类、补记到过去日期、出日/月汇总。',
  whenToUse: '用户提到花钱、收入、报销、退款、房租、"这个月花了多少"、"记一笔"等记账相关话题时。',
  content: readFileSync(new URL('../skills/ledger.md', import.meta.url), 'utf8'),
  source: 'dsh-plugin-ledger',
  resourceBase: { kind: 'directory', path: dataDir }
})
~~~

`skills/ledger.md` 目录（这是"人的经验"沉淀处，随迭代变厚）：

1. 触发词与不做的事（不主动记账；不猜日期；不改历史不问）；
2. 切分规则：一条消息多笔 → 每笔一次 `ledger_add`，`source_text` 传整条原文、`item_index` 递增；
3. `date_expr` 原样传，禁止自己算"上周三"；
4. 金额原样传，禁止自己换算万元/k；
5. 类目只给候选，插件优先；
6. 什么时候必须问（金额模糊、裸星期、退款无原单、疑似重复）；
7. 回复模板（3 行内；只回显关键字段；不问"还要记吗"）；
8. 报表怎么读给用户听（先结论、再 Top3、再一句异常）；
9. 隐私红线（不把历史流水整段贴进回答；不推断用户身份）。

---

## 10. 更正、作废与补记

### 10.1 `ledger_fix` 的三种形态

| 形态 | 入参 | 语义 |
|---|---|---|
| 改字段 | `{ target_id, patch, expected_version? }` | 改金额/日期/类目/备注/标签；版本 +1，**不生成新记录** |
| 按条件定位 | `{ match:{ occurred_on, amount_minor, l1 }, pick:"last" }` | 用户说"刚才那笔"时的兜底；命中多笔 → 返回候选让模型问 |
| 作废/恢复 | `{ target_id, action:"void"|"restore", reason? }` | void 保留行、报表排除；restore 回到 confirmed（版本 +1） |
| 确认草稿 | `{ target_id, action:"confirm"|"unconfirm", expected_version? }` | draft→confirmed（进报表）；unconfirm 退回 draft。**draft 的唯一出口就是这里** |

- `patch` 只允许改 `amount_minor / occurred_on / occurred_at / category / merchant / account / note / tags`；**`kind` 与 `status` 不可 patch**：改 kind = void 后重新记一笔，改 status 走 §10.1 的 confirm 动作。
- `expected_version` 不匹配 → `E_VERSION_CONFLICT` + 返回当前快照（模型据此问"要覆盖吗"）。
- 改金额/日期 → **同一 id 版本 +1**，绝不产生新 id（否则"这笔改过吗"永远查不清）。
- `void` 的记录默认不出现在 `ledger_query`，除非 `include_void: true`。

### 10.2 "我上周三是不是加过一笔房租？"

~~~json
{ "matches": [ { "id": "tx_…", "occurred_on": "2026-10-15", "amount_minor": 450000,
                 "category_l1": "housing", "merchant": "链家", "created_at": "2026-10-16T09:12:00+08:00",
                 "status": "confirmed", "is_backfill": true } ],
  "days_without_entries": [ "2026-10-14", "2026-10-20" ] }
~~~

> `category_l1`、`is_backfill`、`days_without_entries` 都是 **query 的投影字段**，不是记录里的字段（记录里 `category` 是对象，补记靠 `date_source==="backfill"` 判断）。

回答必须区分两件事：**计入日期**（`occurred_on=10-15`）与**录入时间**（`created_at=10-16`）——"你在 10 月 16 日录了一笔记到 10 月 15 日的房租"。查无则明说"没有"，并问要不要补（不自动补）。

### 10.3 补记规则

- `occurred_on < today` 一律允许，记 `date_source:"backfill"`；`created_at` 保持真实录入时刻。
- 补记距今 > 90 天 → 回复里回显一次"确认补到 7 月？"（draft，不阻塞其它条目已入库的部分）。
- 补记落在**已有报表输出过的月份** → 下次报表重算并在首行加一行：
  `> ⚠ 本月因补记 1 笔重算：支出 +¥4,500.00`。
- **绝不重发/改写历史消息**：旧消息里的数字就是当时的真值；只保证"从现在起算的数字是对的"。

### 10.4 报表口径：按需重算，不缓存结论

这是为了消灭一类经典 bug：报表快照没刷新 → 聊天里说 3,240、看板说 3,258。

规则：
1. 任何"数字"都从 `entries.ndjson` 现算（内存索引，天然一致）；
2. 持久化的 `reports/*.md` 是派生物，带生成时间戳，允许过期，被重写时静默；
3. 客户端面板的每次请求都重新计算（≤50ms，可接受）；
4. 只有在"补记改变了已发出的结论"时才主动说明 Δ（§10.3）。

---

## 11. 每日摘要（定时投递）

### 11.1 两级方案

| 级别 | 机制 | 优点 | 缺点 |
|---|---|---|---|
| **v1 主方案** | 插件内 `ctx.interval` 到点 + `agent.followup()` | 零配置、装了就有、插件自己算好数字 | 只在宿主运行时有效；只能推给**活着的** agent；关机日补推要在登录后补 |
| v2 可选 | 宿主 `schedule`（`schedule_create` 的 `daily`，`time_zone:Asia/Shanghai`） | 跨重启、冷会话可唤回 | 要依赖 Web Session controller + 持久化；是宿主的调度，不写插件状态 |

**v1 只做一套**：插件定时器。`schedule` 配方（"每天 21:30 出账本日结"）写进 skill 文档，用户明确想要跨重启唤醒时再让他手动开——**两套不默认同时开**（同时开会重复推送，且去重状态在两条路径上不一致）。

### 11.2 兜底定时器的实现要点

~~~js
// 每 60s 检查一次，成本可忽略；只在宿主进程活着时存在
const [hh, mm] = config.nightlyTime.split(':').map(Number)   // 默认 21:30
const check = async () => {
  const now = clock.now()                                // Asia/Shanghai
  if (!config.nightlyEnabled) return
  const dueMs = startOfDay(now).getTime() + (hh * 60 + mm) * 60_000
  if (now.getTime() < dueMs) return                     // 还没到点
  for (const agent of ctx.agents.roots()) {
    if (agent.status !== 'idle') continue               // 忙就不打扰，下一 tick 再看
    const key = `${now.date}:${agent.sessionId}`
    if (store.nightlySent(key)) continue                // 每个会话每天一次（含重启后补推）
    const body = nightlyBody(report.day(now.date))      // 插件算好，不让模型再算
    agent.followup({ id: `ledger-nightly-${key}`, role: 'user',
      content: [{ type: 'text', text: body }],
      source: { kind: 'plugin:ledger' } })              // 必须是 producer-owned kind
    store.markNightlySent(key)
  }
}
ctx.effect(() => ctx.interval(check, 60_000), 'dsh-ledger: nightly timer')
~~~

投递正文（插件已把数字算好，模型只需润色或直接转述）：

~~~text
【账本日结 · 2026-10-26】
今日支出 ¥86.00（3 笔）：餐饮 ¥57.00 · 交通 ¥18.00 · 其他 ¥11.00
本月支出 ¥3,326.50 · 外面还欠我 ¥2,800.00
你没有记账也可以忽略这条；如果需要日结明细，直接说"今天的账"。
~~~

当天一笔没记时：只发一句"今天还没记账——是没花钱，还是忘了？"（不追问、不催第二遍）。

### 11.3 静默与礼貌

- 只在 `idle` 推；**每个会话**每天最多 1 条，键 `(date, session_id, book)` 存 `meta.json`；当天新开的会话不补发旧日结。
- **分段投递**：店里每天一段（今日销售/现金/欠款 Top1），家里每周一次（`nightlyHomeWeekly`，默认周一）；两段标题字大、分开显示，绝不合并成一条。
- 店里那段的固定四行：今日销售 ¥N（M 笔）· 现金 ¥N · 赊出去 ¥N · **还欠我 ¥N**；家里那段：本周支出 ¥N · 类目 Top2 · 外面还欠我 ¥N。
- 过了 21:30 且宿主当时没开 → 下次宿主起来后第一次 tick 补推当天的一条（同一个键，所以不会重复）。
- 用户说"别每天推了"→ 写 `meta.json.nightly_enabled = false`（明确告诉他这是插件配置、影响所有会话）。
- 不推给子 agent（`ctx.agents.roots()` 过滤）。

---

## 12. 边界场景与策略

| # | 场景 | 策略 |
|---|---|---|
| 12.1 | 退款 vs 负支出 | `kind=refund`，`amount_minor` 仍为正，`original_tx_id` 指原单，抵冲**原类目**；绝不产生负 expense。**原单已 void 或超过 90 天** → 退款记 `draft` + 一问（"这笔退的是哪笔？"），不自动找替身 |
| 12.2 | 报销 | 默认 `income / reimbursement`；若用户说"抵掉那笔差旅"→ `refund + original_tx_id + tags:["offset"]`；两种口径报表分列 |
| 12.3 | AA / 拼单 | 只记自己应付份额 + `tags:["aa"]`，原文总额与人数进 `note`；整数分余数归自己并回显 |
| 12.4 | 分期 / 信用卡 | **两笔**：消费日 `expense`（`account:"招商信用卡"`）+ 还款日 `transfer`（不进收支）。分期默认按消费日全额 + `tags:["installment"]` + `note` 记期数；按月摊到 N 条留 v2 |
| 12.5 | 外币 | **v1 不收外币**：`currency != CNY` → `E_CURRENCY_UNSUPPORTED`，回复"v1 只记人民币，这笔先记 `note` 里？"。schema 留 `currency`/`scale` 字段是为了 v2 不改结构，不实现换汇（插件不联网、模型估汇率不可信） |
| 12.6 | 时区 / 日界 | 一律 `Asia/Shanghai`（忽略宿主机器时区）；`day_cutoff_hour = 4`：04:00 前录入且说"今天/刚才"→ 归前一天（夜宵、凌晨打车） |
| 12.7 | 周期账单（房租/工资） | v2 做"模板"：到期提示"本月房租 4500 还没记，要记吗？"，确认后才落库（**绝不自动记账**）。v1 只靠 nightly 摘要提示 |
| 12.8 | 隐私 | 账本**文件**只在本机；模型能看到的只有它调工具后返回的字段（查明细就必然含商户/备注，见 §16.1）；brief 只给聚合数字。入库前对卡号/身份证/手机号正则脱敏为 `***`（`note` 与 `source_text` 都过） |
| 12.9 | 备份 / 导出 | `ledger_export`：CSV（UTF-8 BOM、RFC4180、固定列序）/ Markdown（§8 布局）/ JSON（全量含 provenance）。`dataDir` 可整体 git init，插件不替你 commit |
| 12.10 | 数据损坏 | append-only + 坏行隔离到 `quarantine/` + 启动 `integrity_check`（l2∈l1、original_tx_id 存在、amount_minor>0、日期区间）；**禁止自动"修复"金额** |
| 12.11 | 多账本（公司/个人） | v2：`dataDir` 下 `books/<slug>/`，工具加 `book?` 参数，默认 default |
| 12.12 | 同一笔跨月调整 | 只改 `occurred_on`（同一 id 版本+1）；月报各自重算，旧月"退回"该笔 |

| 12.13 | 赊账部分还款 | 按 FIFO 冲最早未清的那笔销货，不平均摊、不分本息（本来就没利息）；`applied_to` 可指定单笔 |
| 12.14 | 客户退货且已收款 | 先冲该客户未清应收，剩余部分才退现金；只有明说"钱退他"才全额退现 |
| 12.15 | 换货（补差价） | 两笔：`return(offset)` + `sale(paid=实收差价)`；差价 0 也记两笔，收入净额自动归零 |
| 12.16 | 退给供应商 | `return(side=supplier)` 减库存、冲应付；供应商退回的现金记 `refund_minor`，**不记 income**（不是收入） |
| 12.17 | 盘点差异 | 只写 `counted_qty`，不写金额；盘亏金额由派生层按当时均价算，进 `biz_loss`，不产生第二条事件 |
| 12.18 | 散客赊账 | `customer:"散客"` 占位（不能 null，否则账龄分组会炸）；不赊账的散客不记名、不进账龄 |
| 12.19 | 批发价与零售价并存 | 同一 sku 两个价，只用 `channel` 区分，**不拆 sku**；毛利报表分零售/批发两列 |
| 12.20 | 赠品 / 样品 / 自用 | `amount=0` 的 sale 不允许；搭赠写 `note+tags:["gift"]` 不摊价；送人/自穿/丢失记 `draw(in_kind=goods)` 按当时均价 |
| 12.21 | 运费谁出 | 买家付 → `income/biz_other_income`（不是销售加价）；我们付 → `expense/biz_shipping`；两种都不动库存 |
| 12.22 | 老板取现 / 家店互转 | `draw(to_book=home)` 是所有者提取，既不是店支出也不是家收入；`transfer` 单条事件两侧投影，**绝不双写** |
| 12.23 | 只记总额的一笔销售 | `items=[]`、库存不动、`cost_source=unknown`，报表显示覆盖率；**不允许**用金额反推数量 |
| 12.24 | 成本估算 | `estimated` = 按最近 90 天有明细销售的加权毛利率反推；无样本 → 毛利输出 null，报表写"—" |

## 13. Web UI

### 13.1 两个面（不造第三种）

| 面 | slot 注册 | 内容 |
|---|---|---|
| **设置 → 账本** | `settings.section`（`id:'dsh-ledger'`，`order:65`） | 数据目录（只读展示+复制路径）、时区/日界、默认账本、夜间日结开关与时间、类目与别名、客户与供应商、导出与 Obsidian 刷新 |
| **账单看板** | `sidebar.panellist`（图标）+ `main`（同 id `ledger`） | 月份切换、三数卡、类目占比横条、30 天日柱、按日分组流水（行内改类目/作废） |

**不做的**：浮动按钮/浮窗（diary 的 📓 是裸 `createRoot` 塞 `document.body`，脱离布局与主题，不抄）；右侧栏 tab（v2 再议）；对话内卡片（v2）。

### 13.2 数据通路：Typert Remote（不是自建 HTTP）

~~~js
// host：注册 Remote 面（与工具共享同一份领域实现）
ctx.effect(() => {
  const dispose = ctx.typert.register(LEDGER_MANIFEST)   // { package:'dsh-ledger', face:'host', model:{ services:[{ key:'ledger', members:[…] }] }, invocations: LEDGER_INVOCATIONS }
  return () => { void dispose() }
}, 'dsh-ledger: typert manifest')

// client：挂载并取命名空间
ctx.effect(async () => {
  const dispose = await ctx.remote.$mount({ package: 'dsh-ledger', descriptors: LEDGER_INVOCATIONS })
  ledger = ctx.reflect.get('remote.ledger')
  return () => { ledger = void 0; void dispose() }
}, 'dsh-ledger: remote')
~~~

契约（zod，双端共享，strict codec 自带校验）：

| 方法 | 用途 |
|---|---|
| `getOverview({ month, book })` | 看板一次取全：现金/收入/欠款三数、类目、日桶、按日分组流水 |
| `getDay({ date })` | 单日明细（弹层/展开用） |
| `patchTx({ id, expectedVersion, patch })` | 行内改类目/备注（`patch` 字段同 §10.1，不含 `kind`/`status`） |
| `voidTx({ id, reason? })` | 行内作废 |
| `getDebt({ side? })` / `getStock({ lowOnly? })` | 欠款表与库存表（与 §8.8/§8.9 同一计算源） |
| `listCategories()` / `addAlias({ pattern, l1, l2 })` | 类目与别名 |
| `exportRange({ format, period?, from?, to? })` | 导出（返回相对路径，下载走 host 静态文件或 button→复制路径；同时给 `from`+`to` 才按区间，只给 `period` 按月/年） |

**为什么不用 `ctx.settings` 走配置**：settings wire 只服务硬编码 namespace allowlist，插件命名空间会被 `settings-not-exposed` 拒绝——配置请走插件自己的 `meta.json` + 自己的 Remote/路由（memory 插件踩过这个坑）。

### 13.3 图表：零依赖手绘

| 图 | 做法 | 规模 |
|---|---|---|
| 30 天日柱 | `div` 列表：`height: v/max*100%` + `title` + `aria-label`（hover 显示金额） | ~40 行 |
| 类目占比 | 横向 bar（名称 + 底色条 `width:pct%` + 金额），**不画饼图** | ~30 行 |
| 月度趋势折线（可选） | 单个 `<svg viewBox="0 0 300 80">` + `<polyline points>` | ~25 行 |

不引图表库：基线只外置 `react/react-dom`，其余依赖全打进 bundle（diary 打进 zod → 582KB）。账本的图用一个库换几百 KB 不值得。

### 13.4 主题与本地化

- 只用 `--dsw-alias-*` token（`--dsw-alias-bg-layer-1`、`--dsw-alias-label-primary`、`--dsw-alias-border-l2`、`--dsw-alias-brand-primary`、`--dsw-alias-label-danger`…），**不硬编码颜色、不判断 `prefers-color-scheme`**；深浅色由宿主 theme 插件换 token 完成。
- `ctx.locale.register('dsh-ledger', { zh, en })`，`settings.section` 注册时带 `locale` 自动注入 `t`；`locale/*.json` 只放包展示文案（`{meta:{title,description}}`）。
- 文案语气与聊天一致：简短、名词为主、不卖萌。

### 13.5 状态与失败

- 面板 `useEffect` 挂载时取一次；月份切换/改账后重新 `getOverview`（不轮询）。
- 错误：面板内 inline 提示 + `shell.overlay` Toast（不用 `window.confirm`，diary 那是欠债）。
- 空态：新用户看到"这个月还没有记录 + 一句话示例"，不是空白页。

### 13.6 开单面板（下个迭代做，v0.2 先只定需求）

父母不会为了记账去读说明，面板必须"一屏按到底"。字段与默认值（从上往下，一列）：

| 字段 | 默认 | 交互 |
|---|---|---|
| 记什么 | 上一次用的（首次=零售） | 5 个大按钮：零售 / 批发 / 进货 / 赊账 / 收款 |
| 货号 | 空 | 键盘上方横排最近 5 个货号，点一下就填 |
| 尺码 | 空 | 36–44 大按钮（可跳过） |
| 数量 | 1 | ± 大按钮 |
| 单价 | 空 | 数字键 |
| **总额** | 空 | **主输入框，字最大**；带 `+10 +50 +100` 与 `100/200/500/1000` 快捷 |
| 客户 | 散客 | 最近 3 个客户横排 + 搜一个 |
| 收钱方式 | 微信 | 三个大按钮：微信 / 现金 / 欠着 |
| 日期 | 今天 | 今天 / 昨天 / 前天 / 改日期 |
| 备注 | 空 | 可跳过 |

- 触屏：可点区域 ≥56×56 点、间距 ≥12 点；金额 ≥40 点加粗，正文 ≥18 点；不用下拉框、不横滑、不折叠、不长按、不滑动删除；点数字键 0.2 秒内必须变色。
- **模式开关**：顶部一个"只记总额 / 记明细"，**默认只记总额**（整页只剩金额、收钱方式、保存三样）；切到明细时钱不丢，货号与单价才出现；每人记住上次的模式。
- 提交后：底部绿条停 2 秒"已记 · 零售 ¥180（A32 两双）· 今天第 3 笔"+ 常驻"再记一单"；不弹窗、不跳页。
- 面板写库走同一条事件/幂等通道（§13.2 Remote），不另写一套。

---

## 14. 配置（schemastery）

~~~js
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  enabled:       z.boolean().default(true),
  dataDir:       z.string().default('~/.dsh/ledger'),
  timezone:      z.string().default('Asia/Shanghai'),   // 只允许在这里改（§14 优先级）
  dayCutoffHour: z.number().default(4),

  // 账本与录入者
  defaultBook:   z.string().default('home'),            // 未知录入者的默认账本
  shopBook:      z.string().default('shop'),
  shopName:      z.string().default('店里'),             // 回执里的方括号标签
  defaultActor:  z.string().default('yang'),            // 通道没传 entered_by 时记谁
  actorBookRouting: z.boolean().default(true),         // 按人记"上次用的账本"（§4.8）
  purchaseSettlementDefault: z.string().default('cash'), // cash|credit：进货没说付款时怎么记（§4.6）

  // 常驻上下文
  brief:         z.boolean().default(true),
  briefMaxChars: z.number().default(240),

  // skill
  skill:         z.boolean().default(true),

  // 夜间日结
  nightlyEnabled: z.boolean().default(true),
  nightlyTime:    z.string().default('21:30'),
  nightlyShopDaily:  z.boolean().default(true),         // 店里每天
  nightlyHomeWeekly: z.number().default(1),             // 家里每周几（1=周一，0=不发）

  // 版本化与导出
  autoCommit:    z.boolean().default(true),             // git init + 60s 防抖提交
  commitDebounceSec: z.number().default(60),
  obsidian:      z.object({
    enabled: z.boolean().default(true),
    daily:   z.boolean().default(true),
    monthly: z.boolean().default(true)
  }),

  // 数据治理
  autoCompaction: z.boolean().default(false),
  backupKeep:     z.number().default(7),
  redact:         z.boolean().default(true)
})
~~~

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `~/.dsh/ledger` | 账本目录；`~` 展开；首次写入创建（0700）；含全部账本的事件流 |
| `timezone` / `dayCutoffHour` | Asia/Shanghai / 4 | 日期解析与日界；**不跟随系统时区** |
| `defaultBook` / `shopBook` / `shopName` | home / shop / 店里 | 账本路由；`shopName` 是回执里的方括号标签（父母只认"店里/家里"这两个词） |
| `defaultActor` / `actorBookRouting` | yang / true | 通道没传 `entered_by` 时记谁；是否按人记住"上次用的账本"（§4.8） |
| `purchaseSettlementDefault` | cash | 进货没说付款时记"付清"还是"赊账"；Yang 的进货没有标准账期，默认不凭空造应付 |
| `brief` / `briefMaxChars` | true / 240 | 常驻摘要开关与字数上限（摘要里**只放数字，不放人名与流水**） |
| `skill` | true | 是否注册账本 skill |
| `nightlyEnabled` / `nightlyTime` | true / 21:30 | 插件定时器；店里每天一段、家里每周一次（父母更关心店） |
| `autoCommit` / `commitDebounceSec` | true / 60 | 写后防抖 git 提交（§15.6） |
| `obsidian.*` | 全开 | 月报/日报/欠款/库存的 markdown 派生输出（§15.6） |
| `autoCompaction` | false | 日志压缩（§4.3），M3 才做 |
| `redact` | true | 入库前对卡号/身份证/手机号脱敏 |

**只记人民币**：`currency` 不再作为可配置项（固定 CNY），非 CNY 条目拒收（§12.5）。**无预算功能**：预算相关的配置键、工具与报表段全部删除（Yang 拍板）。

**优先级（唯一真相，别再分叉）**：

1. `cordis.patch.yml` / profile 里的 `config` → 只作**启动默认**；
2. `meta.json` 里的同名运行期键（`nightly_enabled`、`brief`、`categories`、`aliases`、`customers`）→ **覆盖 config**，读取时以 meta 为准；
3. Settings 面板与 Remote 只写 `meta.json`，**不写 config**（config 属于部署，属主是 profile）。

`timezone` / `currency` / `day_cutoff_hour` 这三个**只允许在 config 层设置**（改了会影响历史日期解释），不进 meta，避免"改一次时区把老账拆到别的月份"。与 memory 插件同一套模式。

---

## 15. 打包、构建与安装

### 15.1 仓库结构

~~~text
dsh-ledger/
├── package.json
├── dsh.plugin.json
├── cordis.patch.yml
├── skills/ledger.md              # 记账协议（§9.2 目录）
├── locale/{zh,en}.json           # 包展示文案 {meta:{title,description}}
├── src/
│   ├── host/
│   │   ├── index.ts              # apply：注册工具/skill/ Remote/brief/nightly
│   │   ├── config.ts             # schemastery Config
│   │   ├── store.ts              # append-only 日志、索引、压缩、隔离
│   │   ├── parse/{amount,date,kind}.ts
│   │   ├── classify/{taxonomy,alias}.ts
│   │   ├── report/{day,month,range,format}.ts
│   │   ├── brief.ts
│   │   ├── nightly.ts
│   │   └── tools/*.ts            # 6 个 defineTool
│   └── client/
│       ├── index.js              # apply：locale → $mount → slots
│       ├── board-panel.js
│       ├── settings-section.js
│       ├── charts.js
│       ├── styles.js             # 幂等 adoptStyles()
│       └── i18n.js
├── test/*.test.mjs               # node --test
├── build.mjs                     # 两趟 esbuild（host + client）
└── lib/{index.js,client.js,types/*.d.ts}
~~~

### 15.2 package.json 关键字段

~~~json
{
  "name": "dsh-ledger",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "engines": { "dsh": "^0.2.1-rc.2" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-slots",
                 "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale"]
    },
    "compatibility": { "dsh": "0.2.1-rc.2", "dshReleases": { "0.2.1-rc.2": "compatible" }, "profiles": ["web"] }
  },
  "files": ["lib", "skills", "locale", "cordis.patch.yml", "dsh.plugin.json", "README.md"]
}
~~~

- `engines.dsh` 优先于 `peerDependencies`（唯一裁决 DSH 版本的字段）。
- `skills/` 必须进 `files`，否则 skill 正文读不到。
- 依赖：**runtime 零 dependencies**；宿主包写进 `peerDependencies` + `peerDependenciesMeta: { optional: true }`（`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools` 等），这样 pnpm 不会重复装宿主、打包也不会把宿主模块塞进产物。devDeps 只 esbuild/typescript/@types。

### 15.3 cordis.patch.yml

~~~yaml
- insert:
    - id: dsh-ledger
      name: dsh-ledger
      config:
        dataDir: ~/.dsh/ledger
        brief: true
~~~

模块导出：`export const name = 'ledger'`、`export const inject = ['tools','skills','systemPrompt','typert','agents']`（这五个在 apply 里都是直接调用，必须是**必需依赖**；`webServer` 才是可选的，用 `ctx.inject(['webServer'], cb)` 包住）。`source.kind` 是插件自己填的字符串常量 `'plugin:ledger'`，不由模块名推导。注意：若用 `export default apply`，必须 `Object.defineProperties(apply, { name, inject, Config })` 回挂元数据，否则 loader 解包时 inject/Config 静默丢失（memory 插件踩过）；用命名导出 `export const inject` + `export function apply` 更稳。

### 15.4 构建

~~~js
// 两趟：host 走 node/cjs，client 走 browser/cjs + __ModuleLoader__ 包装
await build({ entryPoints:['src/host/index.ts'], bundle:true, format:'esm', platform:'node',
              packages:'external', outfile:'lib/index.js', target:'node22' })

const clientBuild = await build({ entryPoints:['src/client/index.js'], bundle:true, format:'cjs',
  platform:'browser', target:['chrome100'], external:['react','react-dom'], write:false, minify:true })
const wrapped = `window.__ModuleLoader__.load({ id: 'dsh-ledger', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
${clientBuild.outputFiles[0].text}
  return module.exports; } });`
await writeFile('lib/client.js', wrapped)
~~~

### 15.5 安装与生效

| 步骤 | 命令/动作 | 备注 |
|---|---|---|
| 开发 | `dsh plugin --profile desktop add link:/Volumes/Zuyang/deepseek_harness_plugin/dsh-ledger` | 需先 `pnpm install && pnpm build` |
| 正式 | `dsh plugin --profile desktop add dsh-ledger` | 注册表安装，默认选中 bundle |
| 生效 | HMR 开启即时 recompose；否则重启 DSH | 无 HMR 时 `restart-required` |
| 验证 | Desktop 壳里新开会话问"今天花了多少"；看板看侧栏是否出现"账本" | 本机 profile 名 `desktop` 是 Electron 保留名，CLI 不能 `boot`/`--dump-config`，验证要走 Desktop 壳或另建 profile |

### 15.6 版本化（git）与 Obsidian 输出

**git（Yang 拍板要）**

- 首次写入时对 `dataDir` 执行 `git init`（已存在就跳过），写 `.gitignore`：`exports/`、`*.tmp`、`.lock`、`quarantine/`。
- 提交策略：写入后 **60 秒防抖** 自动 `git add -A && git commit -m "ledger: <date> +N 笔"`；另在夜间日结后补一次（防止防抖期崩溃丢提交）。
- 提交失败（没装 git / 权限）**不阻塞记账**：只在日志里警告一次，并在报表尾部提示"上次提交失败"。
- 不替你 push：远端仓库、私密性、要不要同步到手机都由你自己决定（§16）。
- 压缩/重写操作前先 `git commit` 一次，再留 `.bak`——git 是账本的第二道保险。

**Obsidian（Yang 拍板要）**

- 目录与文件名固定（可被 Obsidian vault 直接索引）：

~~~text
~/.dsh/ledger/
├── entries.ndjson
├── meta.json
├── reports/
│   ├── home/2026-10.md          # 家庭月报（§8.3）
│   └── shop/2026-10.md          # 经营月报（§8.7）
├── daily/2026-10-26.md          # 当日流水（两本账各一段）
├── 欠款.md                       # 当前应收/应付（每次刷新覆盖）
├── 库存.md                       # 当前库存（可选）
└── index.md                     # 月份索引，双向链接到月报与日报
~~~

- frontmatter 固定：`title / date / type: ledger-report|ledger-daily / book / period / generated_at / tags: [ledger, shop|home]`。
- 链接：月报里每个日期链到 `daily/…`；日报里链回月报与欠款页；`index.md` 链到所有月报。这样 Obsidian 的图谱天然好看。
- **报表是派生物**：每次 `ledger_report` 或 `ledger_export refresh_obsidian:true` 覆盖重写，文件头写 `> 生成于 …，数字以聊天里为准`；不参与任何计算，删了也能重建。

---

## 16. 安全、隐私与数据治理

1. **本地优先，但要诚实**：账本**文件**不出本机。会离开本机的是：① 用户自己那条消息；② 插件工具调用**返回给模型**的字段（查明细时必然包含商户/备注/逐笔流水——模型不看到就没法答）；③ 可选 brief 里的**纯数字聚合**（无商户、无流水、无 id）。因此：`brief:false` 可关摘要；查询类工具默认 `limit:20` 且字段投影（明细要显式 `fields`），避免一次把整月流水塞进上下文；任何"全量导出/整月明细"只在本地生成文件、不回灌上下文。
2. **脱敏**：入库前对 `note`/`source_text` 中的银行卡号、身份证、手机号做正则替换 `***`（`redact:true` 默认开）；导出同样脱敏。
3. **工具权限**：6 个工具都是"读/写自己的账本"，不申请 `danger-full-access`。`ledger_export` 只允许写到 `dataDir/exports`（拒绝任意路径）。**v1 不提供 import**（读任意 CSV = 读文件后门 + 列映射/冲突/幂等是独立工程），需要导入时用 `ledger_add` 一条条说，或 v2 再做受限导入。
4. **无网络**：插件不发起任何外部请求（无遥测、无汇率拉取；外币汇率靠模型估计并标 draft）。
5. **可撤销**：一切修改可回放（append-only + 版本）；`ledger_export json` 可搬家；`dataDir` 已 git init（§15.6）。
6. **git 的三个提醒**：① 只本地提交、插件**从不 push**；② 客户姓名/欠款会进 git 历史（你删得掉文件，删不掉历史），所以仓库别放公开远端；③ `exports/`、`quarantine/`、`.lock` 永不提交。
7. **父母的账 = 真实生意数据**：导出给别人、发给模型前会经过脱敏与字段投影（§16.1）；不做任何遥测或上传。
8. **谁能看哪本账由入口决定**：插件只记 `entered_by`，不做权限判断；公网机器上的网关必须把人映射到允许的 `book`（§4.8）。
6. **不被静默改写**：坏行隔离而非修复；压缩留 `.bak`；补记只影响未来计算且显式告知 Δ。

---

## 17. 实施路线（每阶段可独立验收）

**v0.2 的路线改成"周末可交付"的切法**：先让 Yang 和父母在真实生意上跑起来，再补看板与生态。详细时间表见 `dsh-ledger/WEEKEND.md`（周末作战计划），这里只写阶段与验收。

### W0 · 这个周末（周六 + 周日，见 WEEKEND.md）

- 周六：管线跑通 → store（含 git）→ 解析器 → 家庭闭环（`ledger_add/query/fix`）→ 日报 + brief。
- 周日：生意现金流入口（`kind=sale/purchase/payment_in/payment_out/draw/transfer`）→ `ledger_debt` 欠款账龄 → 经营现金流月报 + Obsidian + 导出 → 父母真机演练。库存/毛利进 M2。
- **验收**：WEEKEND.md §1 的四问四答 + §4 的 12 句真实话全部正确落库。

### M1 · 欠款与账龄做扎实（周末后第 1 周）

- 核销策略（FIFO / `applied_to`）、账龄桶、催收话术（"老陈欠 44 天了"）、退货冲减、换货两笔。
- **验收**：生成 200 笔赊账 + 120 笔还款的固定 fixture，账龄与余额逐笔断言（§18.4 #4/#5/#15）。

### M2 · 看板与开单面板（第 2–3 周）

- Typert Remote（`getOverview/getDebt/getStock/patchTx/voidTx`）+ 看板 + **开单面板**（§13.6）+ 设置页。
- **验收**：父母在面板上 20 秒记完一单；面板数字与聊天数字一致（单一计算源）。

### M3 · 主动与生态（第 4 周）

- 夜间日结（店里每天/家里每周）、`ledger_export`、压缩、脱敏、发布与安装文档、备份说明。
- **验收**：21:30 收到两段式日结；导出 CSV 能被 Numbers 打开；干净 profile 可装。

### 明确延后（v2+）

盘点工具、语音输入、小票 OCR、微信账单导入、多仓库/多店、员工与提成、会员、分期、外币、右侧栏 tab、SQLite 后端、跨设备同步。

---

## 18. 测试计划

### 18.1 单元（宿主侧，`node --test`）

| 模块 | 用例要点 |
|---|---|
| `parse/amount` | 32 / 32.5 / ¥1,280.00 / 三十二块 / 两百 / 1.2k / 1万2 / 0 / -5 / 大概三十几 / 2亿 |
| `parse/date` | 今天/昨天/前天/大前天/上周三/周三（未来）/9月3日（跨年）/上个月12号/明天（拒）/2000-01-01 边界 |
| `parse/kind` | 到账/工资/退款/还信用卡/AA/我付了/转帐 |
| `classify` | 最长匹配、exact 优先、用户别名不被内置覆盖、低置信→other+draft、内置版本升级不动用户别名 |
| `store` | 追加后 fsync、坏行隔离、版本选最新、压缩后行数/内容不变、只读降级 |
| `report` | 净额口径（expense−refund）、transfer 排除、draft 排除、share_bp 加总 10000、空月、环比分母 0 |
| `budget` | 80% 预警只报一次、跨 100%、单月 override |

### 18.2 集成（工具层，仿 diary 的 `smoke.mjs`）

用假的 `ctx`（`tools.register` 收集定义 + 直接调 `execute`）跑"落库→查询→报表→更正→再报表"闭环，断言 JSON payload 与 Markdown 里的数字一致。

### 18.3 端到端（Desktop 壳里人工/脚本）

| # | 输入（今天=2026-10-26） | 期望 |
|---|---|---|
| 1 | 午饭32 | 1 笔 ¥32.00 / food_lunch / 10-26 / confirmed |
| 2 | 昨天打车18.5 | 1 笔 ¥18.50 / transport_taxi / 10-25 |
| 3 | 9月3日房租4500 | 1 笔 ¥4,500.00 / housing_rent / 09-03（backfill），月报出现 9 月 |
| 4 | 工资到账18000 | income / salary / confirmed |
| 5 | 午饭32 打车18 咖啡25 | 3 笔，全 confirmed，回复一条 |
| 6 | 昨天午饭32，打车18，晚上咖啡25 | 3 笔，日期一致 10-25 |
| 7 | 上周三 房租4500 | occurred_on=10-21，回复回显日期 |
| 8 | 周五聚餐200（今天周日 11-01） | 两个候选都在过去 → draft + 一问（本周五 10-30 / 上周五 10-23） |
| 9 | 1万2 房租 | ¥12,000.00 |
| 10 | 三十二块 午饭 | ¥32.00 / food_lunch |
| 11 | 退款 32 午饭（30 天内同额） | refund + original_tx_id，餐饮净额下降 |
| 12 | 退款 500（无原单） | draft + 候选列表 |
| 13 | 退我32 | 同 11（同义词覆盖） |
| 14 | 保险3000 记到明年1月 | 拒绝（E_FUTURE_DATE），不入库 |
| 15 | 午饭 大概三十几块 | 拒绝该条，回复"金额没看懂" |
| 16 | 昨天那笔 | 不写库；一问 + 昨日候选 |
| 17 | 同一 tool call 重试两次 | 第二次 replayed:true，只有 1 笔 |
| 18 | 还了信用卡3000 | 记 `transfer`（不进收支，`tags:["card_payment"]`），报表 `excluded.transfer` +1 |
| 19 | AA 火锅480 4人 | 1 笔 ¥120.00，tags:["aa"]，note 记 480/4 |
| 20 | 星巴克35（已有 "公司楼下咖啡" 别名） | food_coffee，不覆盖用户别名 |
| 21 | 这笔算交通 | fix 改类目，version+1，不新建 |
| 22 | 我上周三是不是加过一笔房租 | query 命中并区分 occurred_on/created_at；查无则明说没有 |

### 18.4 生意用例（M2 目标态；v1 只跑现金/欠款相关）

> 下表是"有货号 + 会盘点"后的完整目标态（库存、成本、换货都在内）。**v1 只跑 #4 #5 #7 #11 #12 与三条断言**；其余等 M2 有 `items` 录入能力后再开。

基线：A1023 进货 10 双 @¥40、现金付清 → 库存 10 双 / 成本 ¥400 / 均价 ¥40。

| # | 输入 | 期望事件 | 期望派生 |
|---|---|---|---|
| 1 | 进了10双A1023，一双40，钱付了 | `purchase{40000, items[A1023×10@4000], paid 40000}` | 库存 10 / 成本 ¥400 / 均价 ¥40；现金 −¥400；应付 0 |
| 2 | 零售2双，一双120，收了 | `sale{24000, retail, items[2×12000], paid 24000}` | 库存 8；现金 +¥240；收入 ¥240；COGS ¥80；毛利 ¥160 |
| 3 | 又进12双，50一双，欠着 | `purchase{60000, items[12×5000], paid 0}` | 库存 20 / 成本 ¥920 / 均价 ¥46；应付 ¥600 |
| 4 | 老陈拿5双，一双100，月底结 | `sale{50000, wholesale, 老陈, paid 0}` | 应收 老陈 ¥500（0–30）；库存 15；COGS ¥230；收入 +¥500；现金 +0 |
| 5 | 老陈还了2000 | `payment_in{20000, 老陈}` | 应收 ¥300；现金 +¥200；**收入 +0** |
| 6 | 老陈退一双（退第 4 笔） | `return{10000, customer, offset, applied_to #4}` | 应收 ¥200；库存 16；收入净 −¥100；COGS 冲减 ¥46 |
| 7 | 老王买一双380，收了300 | `sale{38000, retail, 老王, paid 30000}` | 应收 老王 ¥80；现金 +¥300；收入 +¥380 |
| 8 | 退给厂里2双A1023 | `return{8000, supplier, applied_to #3}` | 库存 14；应付 ¥600→¥520；进货成本冲减 ¥80 |
| 9 | 盘点：A1023 实际13双 | `stocktake{lines[A1023:13], amount 0}` | 库存 13；盘亏 ¥46 进 `biz_loss`；不写金额事件 |
| 10 | 进了5000块鞋，没记货号 | `purchase{500000, items null, paid 500000}` | sku 库存不变；未归集成本池 +¥5000；相关销售毛利标 `estimated` |
| 11 | 老板拿3000回家 | `draw{300000, to_book home, in_kind cash}` | 店现金 −¥3000；家侧投影 +¥3000；收入/支出不变 |
| 12 | 家里给店里投5000 | `transfer{500000, home→shop}` | 店现金 +¥5000；"老板投入"+¥5000；不计收入 |
| 13 | 一双A1023自己穿了 | `draw{4600, in_kind goods, items[A1023×1]}` | 库存 12；老板取走 ¥46；收入 0；毛利 0 |
| 14 | 老陈换一双，380换420，补40 | `return{38000, offset, applied_to 原单}` + `sale{42000, paid 4000}` | 现金 +¥40；收入净 +¥40；库存净 0 |
| 15 | 老陈有 10-05 的500、10-20 的300，还了200 | `payment_in{20000, applied_to []}` | FIFO 冲 10-05 → 10-05 余 ¥300（31–60）、10-20 余 ¥300（0–30），合计 ¥600 |

**三条断言式单测**（比用例更重要，跑在每次提交前）：

1. 只有 `payment_in` 的月份：`revenue = 0` 且 `cash > 0`（防"还款当收入"）。
2. 恒等式：`期末库存成本 + Σcogs = Σ进货成本 − Σ退货冲减`（差 1 分都算 bug，舍入池必须吸收）。
3. 同一份 fixture 跑两遍，逐笔 `open_minor` 与账龄桶完全一致（防非确定性排序）。

### 18.5 长辈验收（12 条，跟代码无关，让父母自己打勾）

- [ ] 1. 说完一句话 10 秒内看到回执，不用问"记上了吗"。
- [ ] 2. 回执里没有一个英文字母、编号、"分"字、状态词（"草稿/已确认"）。
- [ ] 3. 说"先欠着"的回执里一定出现"老李欠 ¥680"。
- [ ] 4. 说"还了五百"的回执里一定出现"老李还欠 ¥180"，不是只写"收入 500"。
- [ ] 5. 一条消息说两笔，回执两笔金额都对，不合并。
- [ ] 6. 金额说错，一句话改完，回执写出"580 → 680"。
- [ ] 7. 说"记重了"，一分钟内能删掉一笔，当天笔数总额跟着变。
- [ ] 8. 面板按钮一根手指按得中，老花镜也认得出字（≥18 点）。
- [ ] 9. 面板不滚动就能看到金额框和保存键。
- [ ] 10. 说"店里"之后回执带 [店里]，晚上日结也出现在店里那一段。
- [ ] 11. "从店里拿两千回家"一句话，两本账同时对上。
- [ ] 12. 最坏只是"作废"：任何操作都不会让昨天的账消失，都能恢复。

---

## 19. 风险、未决问题与 UNVERIFIED

### 19.1 最大风险（附缓解）

| 风险 | 影响 | 缓解 |
|---|---|---|
| 模型把金额/日期"顺手算错" | 账目错，信任崩塌 | `date_expr`/`amount` 一律传原文由插件解析；歧义即 draft，永不静默猜 |
| 工具重试产生重复账 | 最常见且最伤信任 | 插件派生 `request_id` + 幂等重放 + 10 分钟疑似重复提示 |
| 单文件日志膨胀 | 加载变慢 | 压缩（3× 活跃行数或 8MB）留 `.bak`；万笔 < 4MB 实测可控 |
| 日志被外部误改/半行 | 丢账或脏账 | 坏行隔离 + 启动完整性检查 + 不自动改金额 |
| 常驻上下文变 token 负担 | 每轮多花钱 | brief ≤240 字可关；记账协议放 skill（正文不常驻） |
| 看板与聊天数字不一致 | 用户不再信任何数字 | 单一计算源（host），客户端零计算，不缓存结论 |
| 发版后内置类目改动破坏历史 | 老账目丢类目 | slug 稳定 + 软停用（`retired`）+ 别名版本化 |
| **现金与收入混算**（把赊销、还款当收入） | 月收入虚增一倍，三个月后无法还原 | `payment_in/out/draw/transfer` 强制 `biz_cashflow`；报表标题写死"现金（实收）/ 收入（权责）"；断言"只有还款时 revenue=0" |
| **用金额维护库存** | 库存金额虚高、盘点永远对不上 | 库存主键永远是 `(sku, qty)`，金额只能派生；无 items 只进未归集池；盘点是数量唯一真值入口 |
| **双口径让父母看错数** | 按虚高利润进货/交租 → 现金流断裂 | 父母默认看现金线；收入行永远括号标注"含赊账 ¥N"；赊账回执必须喊出欠款余额 |
| **库存负数是没录进货，不是账错** | 一修就把真账改假 | 只告警不阻塞、不自动抹平；补记后自愈 |
| **父母第一次用就出错** | 信任只有一次，错了就再也不用了 | 每条回执 ≤4 行 + 余额；"最后那笔"安全阀；12 条话术与 12 条长辈验收（§18.5）先过再上线 |
| **git 把不该提交的东西提交了** | 隐私或仓库膨胀 | `.gitignore` 先写死（exports/tmp/lock/quarantine）；只本地不 push |
| **公网入口让父母看到你的个人账** | 隐私事故 | 插件不做 ACL：**网关按人限制可见账本**（父母只给 shop）；`entered_by` 只用于溯源，不是权限 |
| **手机端长回执、桌面式措辞** | 长辈不愿用 | 回执 ≤4 行、无英文/编号、`[店里]` 方括号标签；面板不是必需（手机入口只走聊天） |

### 19.2 已拍板（Yang，2026-10-26，两轮）

**第一轮（产品形态）**

1. 只记人民币（外币拒收，v2 再说）
2. 不做预算（预算工具与报表段已删）
3. 夜间日结默认 21:30（店里每天、家里每周一次）
4. 账本目录 `git init` + 自动提交（§15.6）
5. 生成 Obsidian 可读的 Markdown（§15.6）
6. 区分收款方式（微信/现金/支付宝/欠着，存 `payment_method`；信用卡账户 v2）

**第二轮（生意默认值与多用户，全部已定）**

| # | 问题 | Yang 的回答 | 设计后果 |
|---|---|---|---|
| 1 | 父母进货有固定账期吗 | **没有标准结算时间** | `purchaseSettlementDefault='cash'`：没说付款就按付清记，回执提示"要是还欠厂家说一声"；绝不凭空造应付（§4.6） |
| 2 | 父母愿意记货号吗 | **不愿意** | **v1 砍掉库存与毛利**，工具减到 6 个；库存只在 M2 靠盘点近似（§8.9） |
| 3 | 父母用什么设备/账号 | **手机**；Yang 自己搭公网机器做手机入口，通道不归插件管 | 每条事件带 `entered_by`、`meta.actors` 映射、**按人记住上次用的账本**（§4.8）；权限由网关控制，插件不做 ACL |
| 4 | "这个月赚多少"信哪个口径 | **随意**；**主要目的是追踪家庭开销** | 家庭月报/类目占比升为第一优先（G0）；生意侧只保现金与欠款，利润口径降级为"参考" |
| 5 | 赊账要记电话/身份证吗 | **不需要** | `customers` 只存名字 + 备注；重名靠"最近一笔"和账龄区分 |
| 6 | 店里谁记账 | **父母记店里**，Yang 记家里 | `defaultActor` + `actorBookRouting`；两本账都要能独立跑通 |

**唯一还算"待定"的**：Yang 的公网手机入口怎么把 `entered_by` 传进来（参数名与取值）。插件侧已定：`entered_by` 可选字符串，缺省用 `defaultActor`，未知值归 `"unknown"` 并照常记账。通道那边传什么、传不传，都不阻塞实现。

### 19.3 未验证项（实现期先做 15 分钟实验）

| # | 项 | 影响 | 验证方式 |
|---|---|---|---|
| U1 | 工具的 `exec` 上下文是否给到 `message_id` / `turn_index` | 幂等键的精度（退化方案已备） | 写个 echo 工具打印 `exec` 键 |
| U2 | 插件能否注入宿主 `schedule` 服务键 | 夜间摘要走"主方案"还是只走兜底 | `ctx.dshScope?` / 打印 `ctx` 服务表 |
| U3 | `parameters` 嵌套 object 的确切 DSL 写法 | 是否可能做批量入参（当前设计不需要） | 读 dsh-tools 源码或用 `oneOf` 试 |
| U4 | `dsh.plugin.json` 的 `entry.inject` 是否起作用 | 打包元数据要不要带它 | 对比模块导出 `inject` 生效情况 |
| U5 | `--dsw-alias-*` 完整 token 清单 | 客户端配色完整性 | 抓 diary/memory 实际引用集合 |
| U6 | `node:sqlite` 是否允许插件 import | 与 v1 无关；只影响未来后端 | 小插件试 import |
| U7 | 本机 profile 名 `desktop` 的 CLI 限制 | 开发验证路径 | 走 Desktop 壳即可绕过 |

---

## 附录 A · API 速查（每条都带出处）

> `SDK:<pkg>` = `/tmp/dsh-sdk/dsh/node_modules/@deepseek-ai/<pkg>/README.md`（从 app.asar 解包的官方文档，DSH 0.2.1-rc.2）；
> `memory:` = `~/.dsh/profiles/desktop/node_modules/dsh-plugin-memory/lib/`；`diary:` = `…/dsh-diary/`。

### A.1 插件模块形状

| 事实 | 出处 |
|---|---|
| `export const name / inject / Config` + `apply(ctx, config) → disposer` | memory:index.js:111,122,125-162,182,537-543 |
| 默认导出会被 loader 解包 → 需 `Object.defineProperties(apply,{name,inject,Config})` | memory:index.js:545-555 |
| 可选服务用 `ctx.inject(['webServer'], cb)` | memory:index.js:446 |
| Config 用 `@deepseek-ai/schemastery` 的 `z.object({...})`，字段级 `.default()`；Config 本体不需要再 `.default()` | memory:index.js:85,125 |
| 热更新由 `dsh-hmr` 决定；无 HMR 需重启 | SDK:dsh-hmr:26,31；SDK:dsh-app-boot:62 |

### A.2 工具

| 事实 | 出处 |
|---|---|
| `ctx.tools.register(defineTool({...}))`，schema 自动进 system prompt | SDK:dsh-tools:29,44 |
| `parameters` 是统一 schema DSL（string/number/integer/boolean/array/object/json/oneOf），**不是** JSON Schema | SDK:dsh-tools:63 |
| `output: { schema, render(args, value) }` | SDK:dsh-tools:52-55；diary:index.js:18162-18175 |
| `execute(args, exec)`，`exec.signal` 必须观察 | SDK:dsh-tools:56-58,125 |
| 定义里没有 approval 字段；权限走 `tools/pre-execute` + `ctx.tools.guard()` | SDK:dsh-tools:84,88 |
| 抛错 → 模型只看到 `Error: <message>` | SDK:dsh-tools:214 |
| 自定义工具结果无统一字节上限（PTC 外层 `run_code` 才有） | SDK:dsh-tools:129,236 |
| 十个工具的完整范式 | diary:README.md；diary:index.js:18150-18620 |

### A.3 持久化

| 事实 | 出处 |
|---|---|
| `defineDomain({name,version,tables:{t:domainTable(zodSchema)}})` + `ctx.storageDomain.open(spec)`；读同步、写 durable、发 `domain/changed` | SDK:dsh-storage-domain:35-57,87-89 |
| 需要 `storage`+`storage-json`(root)+`storage-domain`(backend)` 三行 | SDK:dsh-storage:33-45 |
| JSON 后端 `single`（整单元重写）/ `per-record`（每记录一文档） | SDK:dsh-storage-json:27-35,67-73 |
| 插件命名空间不可写入 settings wire（`settings-not-exposed`） | memory:index.js:24-30；memory:config-store.js:1-13 |
| `DSH_HOME` 默认 `~/.dsh` | memory:config-store.js:22-24 |
| `better-sqlite3` 不可用；`node:sqlite` 宿主自用（插件用 UNVERIFIED） | memory 依赖树；SDK:dsh-session-query-sqlite:66 |

### A.4 主动投递与定时

| 事实 | 出处 |
|---|---|
| `agent.followup(msg)` 排队下一轮；msg 形如 `{id, role:'user', content:[{type:'text',text}], source:{kind:'plugin:<name>'}}` | memory:digest-guard.js:86-107,188 |
| format v4 只接受 producer-owned kind（`plugin:<name>` / `schedule` / `ptc-mode` / `user`） | memory:digest-guard.js:103-106 |
| 触发点：`agent/turn-stopping` + `agent.status==='idle'` + inbox 空 | memory:digest-guard.js:143,172-174 |
| 周期定时器 `ctx.interval(cb, ms)`（cordis-plugin-timer） | SDK:cordis-plugin-timer:26-35 |
| 宿主 `schedule`：daily/weekly/cron/at/every/after，投递回原会话 | SDK:dsh-schedule:27-46,124-135 |
| schedule 依赖 Web Session controller + persistence，跨重启唤回冷会话 | SDK:dsh-schedule:25,64,72 |
| 只能推给活着的 agent（`ctx.agents.roots()`） | memory:index.js:316-326 |

### A.5 上下文与技能

| 事实 | 出处 |
|---|---|
| `ctx.systemPrompt.context({name,order,text(ctx)})` → disposer；返回 `''` 不注入 | memory:index.js:275-286 |
| `text()` 必须同步无副作用（不要在里做 IO） | memory:index.js:330-334 |
| `ctx.skills.register({name,description,whenToUse,content,source,resourceBase})` | memory:index.js:293-300 |
| skill 正文**不进** system prompt，只在 `skill` 工具调用时载入 | SDK:dsh-skill:51,123 |
| skill 名必须 kebab-case | SDK:dsh-skill:65 |

### A.6 事件

| 事实 | 出处 |
|---|---|
| `agent/created`、`agent/disposed`、`agent/status`、`agent/turn-stopping`、`agent/pre-step`、`agent/request-error` | SDK:dsh-agent:66,84；memory:index.js:316 |
| `agent/inbox/inserted|claimed|discarded|spliced` | SDK:dsh-agent:90；SDK:dsh-agent-loop:70 |
| 判定真人消息：`message.source.kind === 'user'` | memory:activity-tracker.js:47-49 |
| 每次注册都放进 `ctx.effect(fn,'label')` 并返回 disposer | memory:index.js:315-326,438-443 |

### A.7 客户端

| 事实 | 出处 |
|---|---|
| `dsh.client={platform:'web',inject:[客户端包名]}` + `exports['./client']` | diary:package.json |
| 服务 URL `/plugins/<pkg>/client.js`（combo + `rev=`） | SDK:dsh-client-modules:37,77 |
| esbuild 产物包 `window.__ModuleLoader__.load({id,factory})`，只外置 react/react-dom | dsh-im:plugin-src/client/build.mjs:12-35 |
| `settings.section`：`ctx.slots.inject('settings.section', () => ctx.slots.register({name,id,order,label,locale,inject}, Comp))` | diary:lib/client.js:15451-15485 |
| 面板 = 同 id 注册 `sidebar.panellist` + `main`（`key`）；`ctx.layout.selectPanel(id)` | dsh-im:plugin-src/client/plugin-page.js:48-73；SDK:dsh-client-ui-layout:56 |
| 无"浮动面板"slot（diary 的 📓 是裸 `createRoot`） | diary:lib/client.js:15493-15499 |
| Typert Remote：host `ctx.typert.register(manifest)` / client `ctx.remote.$mount({package,descriptors})` + `ctx.reflect.get('remote.<key>')` | diary:lib/index.js:18145；diary:lib/client.js:15429-15446 |
| 本地化 `ctx.locale.register(ns,{zh,en})`、`bind(ns)`、slot 的 `locale` 自动注入 `t` | SDK:dsh-client-locale:37；diary:lib/client.js:15472-15477 |
| 主题只用 `--dsw-alias-*` token，不硬编码颜色 | SDK:dsh-client-ui-theme:27,41,63,131 |

### A.8 打包与安装

| 事实 | 出处 |
|---|---|
| `dsh.bundle.patch` → `cordis.patch.yml`（`- insert: [{id,name,config}]`） | memory:package.json:20-23；memory:cordis.patch.yml:9-11 |
| `engines.dsh` 优先于 peerDependencies | SDK:dsh-app-boot:51 |
| `dsh plugin --profile <p> add <pkg>` 转发 pnpm；装完默认选中 bundle | SDK:dsh:18；SDK:dsh-plugin-manager:39 |
| 无 HMR → `restart-required`；有 HMR → 即时 recompose | SDK:dsh-plugin-manager:13,97 |
| 本机 profile 名 `desktop` 是 Electron 保留名，CLI 拒绝 boot/config-dump | SDK:dsh:20 |

---

## 附录 B · 本设计的证据与调研产物

| 产物 | 路径 | 说明 |
|---|---|---|
| SDK 官方文档（307 包） | `/tmp/dsh-sdk/dsh/node_modules/@deepseek-ai/` | 由 `app.asar` 解出的 README/package.json（DSH 0.2.1-rc.2） |
| 宿主 SDK 调研笔记 | `.agents/notes/ledger-sdk.md` | 每条 API 带 path:line，244 行 |
| 客户端/UI 调研笔记 | `.agents/notes/ledger-ui.md` | slot 清单、bundle 契约、图表方案，250 行 |
| 领域模型笔记 | `.agents/notes/ledger-domain.md` | 类目表、解析规则、报表模板、测试矩阵，298 行 |
| 参考插件（已安装） | `~/.dsh/profiles/desktop/node_modules/{dsh-plugin-memory,dsh-diary}` | 宿主侧 + 客户端侧的完整范式 |
| 参考插件（工程写法） | `plugin-src/client/{build.mjs,plugin-page.js,index.js}` | esbuild 打包 + slot 注册 |

---

## 附录 C · 一页纸决策清单（评审时逐条打勾）

- [ ] 记录用整数分、方向由 `kind` 表达、永不出现负 expense
- [ ] 只存 `occurred_on`；时区固定 `Asia/Shanghai`；日界 04:00
- [ ] `draft/confirmed/void` 三态 + 版本号；删除 = void
- [ ] append-only 日志 + 启动加载 + 坏行隔离 + 压缩留 `.bak`
- [ ] 幂等键由插件派生（模型不造 UUID）
- [ ] 退款是独立 `kind` + `original_tx_id`（不是负支出）
- [ ] 类目用 slug 做主键；用户别名永不被内置覆盖
- [ ] 模型只做切分与候选；解析/校验/落库/报表在插件
- [ ] **6 个工具、单一写入口**、参数以扁平为主、错误文案是"人话"
- [ ] 记账协议放 skill（常驻 0 token）；brief ≤240 字可关
- [ ] 报表不缓存结论；客户端零计算
- [ ] **一条事件流 + `book` 字段**，不建第二个账本目录、不双写
- [ ] **三个口径分开**：现金（实收）/ 权责（收入−成本）/ 欠款（应收应付），报表标题写死口径
- [ ] **`payment_in/payment_out/draw/transfer` 不计收支**；断言"只有还款时 revenue=0"
- [ ] 库存主键是 `(sku, qty)`；无 items 不动库存；负库存只告警不修
- [ ] 成本 = per-sku 移动加权平均、按全序重放；补记必须播报 Δ；覆盖率必须打印
- [ ] 核销 FIFO + `applied_to`；全序密钥写死 `(occurred_on, created_at, id)`
- [ ] 父母回执 ≤4 行、无英文/编号/"分"，与人有关必喊余额；`match:"last"` 可改
- [ ] 账本 git init + 防抖提交；Obsidian 月报/日报/欠款页为派生物
- [ ] 夜间日结：插件定时器（`source.kind='plugin:ledger'`）；店里每天、家里每周
- [ ] 看板 = `sidebar.panellist` + `main`；不造浮窗；图表零依赖
- [ ] 数据本地、无网络、导出限 `dataDir/exports`、入库脱敏
- [ ] 周末 W0 四问四答 + 12 句真实话术通过；§18.5 长辈验收 12 条通过

---

## 附录 D · v0.2 决策记录（ADR 摘要）

| ADR | 决策 | 备选与否决理由 |
|---|---|---|
| ADR-001 | 存储用 append-only NDJSON 文件，不用 `ctx.storageDomain` | 账本是用户数据：要可读、可 grep、可 git、可手改；domain 后端是二进制/半结构化，迁移与审计不便 |
| ADR-002 | 一份事件流 + `book` 字段，不建 `books/home/`、`books/shop/` 两个目录 | 双目录 = 双写 = 双份幂等与双份漂移；跨账本转移需要"一条事件两侧投影" |
| ADR-003 | 交易与结算同事件（`paid_minor`），`open_minor` 派生应收应付 | 分成"销售单 + 收款单"两笔说，父母不会配合；另立欠款表会与事件漂移 |
| ADR-004 | 生意语义塞进 `ledger_add` 的 `kind`，不另开 `shop_sale/shop_purchase` 工具 | 工具数进常驻 prompt；"选错工具"比"填错参数"更难纠、更贵 |
| ADR-005 | 成本用 per-sku 移动加权平均、每次重放，不冻结快照 | 最近进价让同款毛利跳动；冻结在"补记是常态"下会把历史毛利钉死在错值 |
| ADR-006 | 库存是可选副产物：允许只记总额（`items=[]`） | 父母不会录货号；录不全的库存系统比没有更危险（会让人信错数） |
| ADR-007 | 三个口径（现金/权责/欠款）分开报表，父母默认看现金 | 赊销记成收入会让"这个月赚多少"虚高，据此进货交租会现金流断裂 |
| ADR-008 | `payment_in/payment_out/draw/transfer` 归 `biz_cashflow`，永不计收入 | 现金与收入混算是本领域第一大 bug，且三个月后无法还原 |
| ADR-009 | 去掉预算与外币；固定 CNY、Asia/Shanghai | Yang 拍板；预算口径与"欠款/毛利"抢注意力，外币在皮鞋店里不存在 |
| ADR-010 | 账本目录 git init + 写后 60s 防抖提交；Obsidian 文件为派生物 | 用户要版本化；但报表必须能被重建，不能变成第二真值源 |
| ADR-011 | 夜间日结只做插件定时器（不默认开宿主 schedule） | 两套调度同开会重复推送，且去重状态在两条路径上不一致 |
| ADR-012 | 窗口期只做聊天 + 报表，面板下一迭代 | 周末目标是"能用"，不是"好看"；面板字段需求已在 §13.6 冻结 |
