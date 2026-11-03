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
| 每日摘要 | **已移除（0.5）**：定时把全家的账汇总推给一个会话，多人共用时等于公开每个人的流水。要看数就问，工具按权限返回 |
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

- 来源优先级（v0.5）：`dsh-family-auth` 的会话身份 > 工具参数 `entered_by` > `<dsh_im_source>` 的 `senderName` > `senderId` > `"未识别"`。配置 `defaultActor` 已删除：它让模型可以自称任何人，和权限模型直接冲突。
  - dsh-im 只在通道能给昵称时才写 `senderName`；**没有昵称就退回 `senderId`**——难看但有身份，比"不知道谁记的"有用。
  - 模型常见的"不知道"写法（`unknown`、`未知`、`匿名`、`-` 等）一律当没传，不许它否决我们看得见的 senderId。
  - 记账时把实际用了哪一级写进 `actor_source`（`param` / `im_source_name` / `im_source_id` / `default`），`ledger_doctor` 按这个分组计数——这是验证"微信那条路真的通了"的唯一办法。
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
---

## 8. 设置面板（客户端半，v0.5 落地）

### 8.1 为什么必须有客户端半

### 8.8 文件是唯一的真相（v0.5.1 修）

### 8.9 不往别人的仓库里提交（v0.5.1 修）

实机里出现过一个更隐蔽的坑：Yang 把账本指到 `/Volumes/Zuyang/dsh/IM_content/ledger`，而这个目录本身在一个已有的 git 仓库里。原来的 `git init` 只检查 `rev-parse --is-inside-work-tree`——嵌套时它**返回成功**，于是插件以为"仓库已就绪"，之后的每次自动提交都写进了别人的历史（`git status` 里赫然出现 `M entries.ndjson`）。

规则改成：只有当 `git rev-parse --show-toplevel` 等于账本目录本身时才算"我们自己的仓库"；否则

- 不 init、不 commit，`enabled = false`，只 warn 一次；
- `git.nestedRepo` 记下拦到谁的仓库，`ledger_doctor` 与面板底部都会明说；
- 账目照常落盘，只是没有历史；想要历史就把账本挪到独立目录再 `git init`。

这条和 §8.8 是同一条原则的两面：**只对自己的文件负责**——读别人的写入，但不写别人的历史。

## 家庭权限（v0.5）

账本不再假设"只有一个人用"。接入 `dsh-family-auth` 之后，每条记录有主人，每次读取有范围。

### 唯一的读接缝

所有读取都走 `runtime.view(exec)`（`lib/view.js`），它回答两个问题：这次执行能看哪些记录、新记录记在谁名下。

````js
const view = runtime.view(exec)
view.all()        // 只含权限内的记录
view.byId(id)     // 越权返回 null，不抛错
view.stamp()      // { ownerId, ownerName, anonymous }
view.isOwner()    // 是否户主
````

`test/scope-guard.test.js` 会扫描 `lib/tools/*.js`：**任何一行 `store.all()` 都会让测试失败**。
靠人记住"别忘了过滤"守不住，得让忘记变成构建失败。

### 归属的三种来源

1. `ownership.ndjson` 侧表（认领与迁移，`ledger_claim`）——**优先级最高**：那是户主后做的明确决定
2. 记录内联的 `ownerId`（写入时的判断；匿名写入会内联成 default）
3. `default` 共享桶（谁也没认领）

侧表必须在最前面。否则匿名写入的记录内联了 default，户主再怎么认领都盖不掉它，共享桶就成了陷阱。

历史记录不重写 journal，只在侧表追加一行；认领错了可以再认领一次，账本本身不动。

### 没接 auth 时

`runtime.auth` 为 null，视图不受限——就是 0.4 的单用户行为，插件在别的 profile 里照样能用。

### 一并移除的

- **夜间小结**（`nightly.js`）：聚合全量再推给一个会话，多人共用时等于公开流水。
- **`defaultActor`**：模型可以自称任何人。
- **账本面板的权限豁免**：面板没有会话身份，启用 auth 后整个面板返回 403，看数改用对话里的工具。
