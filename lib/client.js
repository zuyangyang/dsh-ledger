/**
 * dsh-ledger 客户端半（零构建）：
 * 在设置侧栏注册「Ledger」区块 —— 最近一个月的账目看板 + 配置表单。
 *
 * 数据通道：设置面板读自己插件的 HTTP 路由（/api/ledger/summary 与
 * /api/ledger/config），因为 settings wire 只服务宿主白名单，第三方插件永远
 * 写不进去。账本是 append-only 的本地文件，面板只读 + 只在用户点保存时写配置。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ledger',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const SUMMARY_URL = '/api/ledger/summary'
    const CONFIG_URL = '/api/ledger/config'
    /** While open, the panel re-reads the journal this often. */
    const REFRESH_MS = 30000

    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      dim: 'var(--dsw-alias-label-secondary, #8a8f98)',
      border: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.22))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
      layer: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06))',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12))',
      accent: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      error: 'var(--dsw-alias-state-error-primary, #e5484d)',
      ok: 'var(--dsw-alias-state-success-primary, #2f9e44)',
    }

    const wrapStyle = {
      padding: '20px 24px 40px',
      display: 'flex',
      flexDirection: 'column',
      gap: '20px',
      color: C.text,
      fontSize: '14px',
      lineHeight: '22px',
      maxWidth: '980px',
    }
    const cardStyle = {
      border: '1px solid ' + C.border,
      borderRadius: '12px',
      padding: '16px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      background: C.layer,
    }
    const h2Style = { margin: 0, fontSize: '15px', fontWeight: 600, lineHeight: '22px' }
    const dimStyle = { fontSize: '12px', lineHeight: '18px', color: C.dim }
    const buttonStyle = {
      padding: '6px 12px',
      fontSize: '13px',
      borderRadius: '8px',
      border: '1px solid ' + C.borderStrong,
      background: 'transparent',
      color: C.text,
      cursor: 'pointer',
    }
    // Accent as border + text, never as a filled background: the host theme may
    // resolve its brand colour to white, and white-on-white hides the button.
    const primaryButtonStyle = { ...buttonStyle, borderColor: C.accent, color: C.accent, fontWeight: 600 }
    const inputStyle = {
      width: '260px',
      padding: '6px 8px',
      fontSize: '13px',
      borderRadius: '8px',
      border: '1px solid ' + C.borderStrong,
      background: 'var(--dsw-alias-bg-layer-2, transparent)',
      color: C.text,
    }

    // ---------------- 格式化 ----------------

    /** 分 -> ¥1,234.56（负数带 -）。面板上永远两位小数，和回执一致。 */
    function formatMoney(minor) {
      const value = Number(minor)
      if (!Number.isFinite(value)) return '¥0.00'
      const negative = value < 0
      const abs = Math.abs(Math.round(value))
      const yuan = Math.floor(abs / 100)
      const cents = String(abs % 100).padStart(2, '0')
      const grouped = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      return (negative ? '-¥' : '¥') + grouped + '.' + cents
    }

    /** 万分比 -> 12.3%（一位小数，10000=100%）。 */
    function formatShare(shareBp) {
      const value = Number(shareBp)
      if (!Number.isFinite(value)) return '0.0%'
      return (value / 100).toFixed(1) + '%'
    }

    /** 2026-10-05 -> 10-05，表格里省一列宽。 */
    function shortDate(date) {
      return typeof date === 'string' && date.length >= 10 ? date.slice(5) : String(date || '')
    }

    function emptyText(text) {
      return React.createElement('div', { style: { ...dimStyle, padding: '6px 0' } }, text)
    }

    // ---------------- 小部件 ----------------

    function Stat(props) {
      return React.createElement('div', {
        style: {
          flex: '1 1 150px',
          minWidth: '140px',
          padding: '12px 14px',
          borderRadius: '10px',
          border: '1px solid ' + C.border,
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
        },
      },
      React.createElement('div', { style: { ...dimStyle } }, props.label),
      React.createElement('div', { style: { fontSize: '20px', fontWeight: 600, lineHeight: '28px' } }, props.value),
      props.sub ? React.createElement('div', { style: { ...dimStyle } }, props.sub) : null)
    }

    function StatRow(props) {
      return React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px' } }, props.children)
    }

    /** 横向条形：类目占比。宽度用百分比，颜色只有一种，避免看起来像结论。 */
    function CategoryBars(props) {
      const rows = props.rows || []
      if (rows.length === 0) return emptyText(props.empty || '这个月还没有支出。')
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        rows.map((row) => React.createElement('div', { key: row.key, style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          React.createElement('div', { style: { width: '74px', flex: 'none', fontSize: '13px' } }, row.label),
          React.createElement('div', { style: { flex: 1, height: '8px', borderRadius: '4px', background: C.layer2, overflow: 'hidden' } },
            React.createElement('div', {
              style: {
                width: Math.max(2, Math.round(row.share_bp / 100)) + '%',
                height: '100%',
                background: C.accent,
                opacity: 0.75,
                borderRadius: '4px',
              },
            })),
          React.createElement('div', { style: { width: '92px', flex: 'none', textAlign: 'right', fontSize: '13px' } }, formatMoney(row.minor)),
          React.createElement('div', { style: { width: '54px', flex: 'none', textAlign: 'right', ...dimStyle } }, formatShare(row.share_bp)))))
    }

    /** 近六个月趋势：家里支出 / 店里卖出各一行，纯宽度条。 */
    function Trend(props) {
      const months = props.months || []
      if (months.length === 0) return emptyText('还没有历史。')
      const maxHome = Math.max(1, ...months.map((entry) => entry.home_spent_minor || 0))
      const maxShop = Math.max(1, ...months.map((entry) => entry.shop_sales_minor || 0))
      const line = (label, key, max) => React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        React.createElement('div', { style: { ...dimStyle } }, label),
        React.createElement('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '8px', height: '56px' } },
          months.map((entry) => React.createElement('div', {
            key: entry.month,
            title: entry.month + ' ' + formatMoney(entry[key]),
            style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: '4px', alignItems: 'center' },
          },
          React.createElement('div', {
            style: {
              width: '100%',
              height: Math.max(entry[key] > 0 ? 4 : 1, Math.round((entry[key] / max) * 44)) + 'px',
              background: entry.month === props.month ? C.accent : C.borderStrong,
              borderRadius: '3px',
              opacity: entry.month === props.month ? 1 : 0.55,
            },
          }),
          React.createElement('div', { style: { fontSize: '10px', ...dimStyle } }, entry.month.slice(2))))))
      return React.createElement('div', { style: { display: 'flex', gap: '22px', alignItems: 'flex-start' } },
        React.createElement('div', { style: { flex: 1 } }, line('家里支出', 'home_spent_minor', maxHome)),
        React.createElement('div', { style: { flex: 1 } }, line('店里卖出', 'shop_sales_minor', maxShop)))
    }

    function RecentTable(props) {
      const rows = props.rows || []
      if (rows.length === 0) return emptyText(props.empty || '还没有记录。')
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
        rows.map((row) => React.createElement('div', {
          key: row.id,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '7px 0',
            borderTop: '1px solid ' + C.border,
            fontSize: '13px',
          },
        },
        React.createElement('div', { style: { width: '48px', flex: 'none', ...dimStyle } }, shortDate(row.date)),
        React.createElement('div', { style: { width: '40px', flex: 'none', ...dimStyle } }, row.book === 'shop' ? '店里' : '家里'),
        React.createElement('div', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          (row.counterparty ? row.counterparty + ' · ' : '') + (row.note || row.category_label || row.kind_label)),
        row.paid_minor !== row.amount_minor
          ? React.createElement('div', { style: { ...dimStyle } }, '欠 ' + formatMoney(row.amount_minor - row.paid_minor))
          : null,
        React.createElement('div', { style: { width: '104px', flex: 'none', textAlign: 'right', fontWeight: 500 } }, formatMoney(row.amount_minor)),
        React.createElement('div', { style: { width: '76px', flex: 'none', textAlign: 'right', ...dimStyle } }, row.entered_by || ''))))
    }

    function DebtBlock(props) {
      const debt = props.debt || {}
      const people = debt.people || []
      const header = React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px' } },
        React.createElement('span', { style: { fontWeight: 600 } }, props.title),
        React.createElement('span', { style: { fontWeight: 600 } }, formatMoney(debt.total_minor || 0)))
      const body = people.length === 0
        ? React.createElement('div', { style: { ...dimStyle } }, props.empty || '没有欠账。')
        : people.map((person) => React.createElement('div', {
          key: person.name,
          style: { display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' },
        },
        React.createElement('span', null, person.name + (person.age_days ? '（' + person.age_days + ' 天）' : '')),
        React.createElement('span', null, formatMoney(person.open_minor))))
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, header, body)
    }

    function SourceBadge(props) {
      const map = { ui: '面板', deployment: '配置文件', default: '默认' }
      return React.createElement('span', {
        style: { fontSize: '11px', padding: '1px 6px', borderRadius: '999px', border: '1px solid ' + C.border, color: C.dim },
      }, map[props.source] || props.source)
    }

    function Field(props) {
      const setting = props.setting
      const value = props.value
      const onChange = props.onChange
      const label = React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        React.createElement('span', { style: { fontSize: '13px' } }, setting.label),
        React.createElement(SourceBadge, { source: setting.source }))
      let control
      if (setting.type === 'boolean') {
        control = React.createElement('button', {
          type: 'button',
          style: { ...buttonStyle, minWidth: '64px' },
          onClick: () => onChange(!value),
        }, value ? '开' : '关')
      } else if (setting.type === 'choice') {
        control = React.createElement('div', { style: { display: 'flex', gap: '6px' } },
          (setting.options || []).map((option) => React.createElement('button', {
            key: option,
            type: 'button',
            style: option === value ? { ...buttonStyle, borderColor: C.accent, color: C.accent } : buttonStyle,
            onClick: () => onChange(option),
          }, option === 'home' ? '家里' : option === 'shop' ? '店里' : option === 'cash' ? '现结' : option === 'credit' ? '赊账' : option)))
      } else if (setting.type === 'integer') {
        control = React.createElement('input', {
          type: 'number',
          style: { ...inputStyle, width: '110px' },
          value: value === null || value === undefined ? '' : String(value),
          min: setting.min,
          max: setting.max,
          onChange: (event) => onChange(event.target.value === '' ? null : Number(event.target.value)),
        })
      } else {
        control = React.createElement('input', {
          type: 'text',
          style: inputStyle,
          value: value === null || value === undefined ? '' : String(value),
          placeholder: setting.type === 'time' ? '21:30' : '',
          onChange: (event) => onChange(event.target.value),
        })
      }
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 0', borderTop: '1px solid ' + C.border } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' } },
          label, control),
        setting.hint ? React.createElement('div', { style: dimStyle }, setting.hint) : null)
    }

    // ---------------- 纯展示面板（无 hooks，可单测） ----------------

    function LedgerPanel(props) {
      const data = props.data
      const draft = props.draft || {}
      const settings = (props.config && props.config.settings) || []
      if (!data) {
        return React.createElement('div', { style: wrapStyle },
          React.createElement('div', { style: dimStyle }, props.error ? '读不到账本：' + props.error : '正在读账本…'))
      }
      const month = data.month
      const months = data.months || []
      const storage = data.storage || {}
      const homeStats = data.home || {}
      const shop = data.shop || {}
      const monthButtons = months.map((entry) => React.createElement('button', {
        key: entry.month,
        type: 'button',
        style: entry.month === month
          ? { ...buttonStyle, background: C.layer2, fontWeight: 600 }
          : buttonStyle,
        onClick: () => props.onMonth(entry.month),
      }, entry.month.slice(2)))
      return React.createElement('div', { style: wrapStyle },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' } },
          React.createElement('div', null,
            React.createElement('div', { style: { fontSize: '18px', fontWeight: 600, lineHeight: '26px' } }, '账本 · ' + month),
            React.createElement('div', { style: dimStyle },
              '家里 ' + (homeStats.count || 0) + ' 笔 · 店里 ' + (shop.sales_count || 0) + ' 单 · ' +
              '共 ' + (storage.entries || 0) + ' 条记录')),
          React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            monthButtons,
            React.createElement('button', { type: 'button', style: buttonStyle, onClick: props.onRefresh }, '刷新'))),

        React.createElement(StatRow, null,
          React.createElement(Stat, { label: '家里支出', value: formatMoney(homeStats.expense_minor || 0), sub: '退款 ' + formatMoney(homeStats.refund_minor || 0) }),
          React.createElement(Stat, { label: '家里收入', value: formatMoney(homeStats.income_minor || 0), sub: '净 ' + formatMoney(homeStats.net_minor || 0) }),
          React.createElement(Stat, { label: '店里卖出', value: formatMoney(shop.sales_minor || 0), sub: (shop.sales_count || 0) + ' 单' }),
          React.createElement(Stat, { label: '现金净流', value: formatMoney(shop.cash_net_minor || 0), sub: '收 ' + formatMoney(shop.cash_in_minor || 0) + ' / 付 ' + formatMoney(shop.cash_out_minor || 0) }),
          React.createElement(Stat, { label: '应收未收', value: formatMoney((data.receivable || {}).total_minor || 0), sub: ((data.receivable || {}).people_count || 0) + ' 人' }),
          React.createElement(Stat, { label: '应付未付', value: formatMoney((data.payable || {}).total_minor || 0), sub: ((data.payable || {}).people_count || 0) + ' 家' })),

        React.createElement('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } },
          React.createElement('div', { style: { ...cardStyle, flex: '1 1 380px' } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' } },
              React.createElement('div', { style: h2Style }, '家里花在哪'),
              (homeStats.uncategorized_count || 0) > 0
                ? React.createElement('div', { style: { ...dimStyle, color: C.error } }, (homeStats.uncategorized_count || 0) + ' 笔未归类')
                : null),
            React.createElement(CategoryBars, { rows: homeStats.by_category || [], empty: '这个月还没有家里支出。' })),
          React.createElement('div', { style: { ...cardStyle, flex: '1 1 300px' } },
            React.createElement('div', { style: h2Style }, '欠账'),
            React.createElement(DebtBlock, { title: '应收（别人欠店里）', debt: data.receivable || {}, empty: '没有赊账。' }),
            React.createElement(DebtBlock, { title: '应付（欠厂家）', debt: data.payable || {}, empty: '不欠厂家。' }))),

        React.createElement('div', { style: cardStyle },
          React.createElement('div', { style: h2Style }, '近六个月'),
          React.createElement(Trend, { months, month })),

        React.createElement('div', { style: cardStyle },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' } },
            React.createElement('div', { style: h2Style }, '最近记录'),
            React.createElement('div', { style: dimStyle }, data.generated_at ? '数据截至 ' + data.generated_at.slice(11, 16) : '')),
          React.createElement(RecentTable, { rows: data.recent || [] })),

        React.createElement('div', { style: cardStyle },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
            React.createElement('div', null,
              React.createElement('div', { style: h2Style }, '配置'),
              React.createElement('div', { style: dimStyle }, '保存后需要重启 DSH 才生效（账本启动时只读一次配置）。')),
            React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              props.saved ? React.createElement('span', { style: { ...dimStyle, color: C.ok } }, '已保存，重启后生效') : null,
              React.createElement('button', { type: 'button', style: primaryButtonStyle, disabled: props.saving, onClick: props.onSave },
                props.saving ? '保存中…' : '保存'))),
          settings.length === 0
            ? emptyText('配置读取中…')
            : settings.map((setting) => React.createElement(Field, {
              key: setting.key,
              setting,
              value: setting.key in draft ? draft[setting.key] : setting.value,
              onChange: (value) => props.onChange(setting.key, value),
            }))),

        React.createElement('div', { style: { ...dimStyle, display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' } },
          React.createElement('span', null,
            '账本目录：' + (storage.data_dir || '未知') + (storage.is_default ? '（默认）' : '（自定义）') +
            (storage.git_ready ? ' · 已启用本地 git' : '') +
            (storage.git_nested_in ? ' · 目录在仓库 ' + storage.git_nested_in + ' 内，未自动提交' : '') +
            (storage.git_error ? ' · git 不可用：' + storage.git_error : '')),
          React.createElement('span', null,
            '隔离行 ' + (storage.quarantined || 0) + ' · 配置文件：' + ((props.config && props.config.ui_config_path) || '未知') +
            (data.generated_at ? ' · 读于 ' + data.generated_at.slice(11, 19) : ''))),
        props.error ? React.createElement('div', { style: { color: C.error, fontSize: '13px' } }, props.error) : null)
    }

    // ---------------- 有状态容器 ----------------

    function LedgerSection() {
      const [month, setMonth] = React.useState(null)
      const [data, setData] = React.useState(null)
      const [config, setConfig] = React.useState(null)
      const [draft, setDraft] = React.useState({})
      const [error, setError] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [saved, setSaved] = React.useState(false)

      const loadSummary = React.useCallback((wanted) => {
        const url = wanted ? SUMMARY_URL + '?month=' + encodeURIComponent(wanted) : SUMMARY_URL
        fetch(url)
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
          .then((value) => { setData(value); setError(null); setMonth(value.month) })
          .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)))
      }, [])

      const loadConfig = React.useCallback(() => {
        fetch(CONFIG_URL)
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
          .then((value) => { setConfig(value); setDraft({}) })
          .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)))
      }, [])

      React.useEffect(() => { loadSummary(null); loadConfig() }, [loadSummary, loadConfig])

      // The journal is a file another process may be appending to (a phone
      // message, another window), so the open panel re-reads instead of
      // claiming a snapshot from the moment it mounted.
      React.useEffect(() => {
        const timer = setInterval(() => loadSummary(month), REFRESH_MS)
        return () => clearInterval(timer)
      }, [month, loadSummary])

      const save = () => {
        const values = {}
        let dirty = false
        for (const key of Object.keys(draft)) {
          if (draft[key] === null || draft[key] === undefined || draft[key] === '') {
            values[key] = null
            dirty = true
          } else {
            values[key] = draft[key]
            dirty = true
          }
        }
        if (!dirty) { setSaved(true); return }
        setSaving(true)
        fetch(CONFIG_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ values }),
        })
          .then((response) => (response.ok ? response.json() : response.json().then((body) => Promise.reject(new Error(body.error || ('HTTP ' + response.status))))))
          .then((value) => { setConfig(value); setDraft({}); setSaved(true); setError(null) })
          .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)))
          .finally(() => setSaving(false))
      }

      return React.createElement(LedgerPanel, {
        data,
        config,
        draft,
        error,
        saving,
        saved,
        onMonth: (next) => loadSummary(next),
        onRefresh: () => { loadSummary(month); loadConfig() },
        onChange: (key, value) => setDraft({ ...draft, [key]: value }),
        onSave: save,
      })
    }

    // ---------------- 悬浮看板（右下角按钮 + 居中弹窗，DASHBOARD.md 2-4） ----------------
    //
    // 和设置区块共享同一个 bundle：宿主只允许 require('react')，不允许相对 require，
    // 所以这里只能与上面同处一个文件。挂载方式照搬日记插件：自己建一个 div 挂到 body，
    // 用 react-dom 渲染 —— 这是唯一能盖住整个框架又不动布局树的正当做法。

    const RANGE_URL = '/api/ledger/range'
    const ACTORS_ROUTE = '/api/ledger/actors'
    const DOCK_VIEW_KEY = 'dsh-ledger.dockView'
    const PRESETS = [
      { key: 'last7', label: '近 7 天' },
      { key: 'last30', label: '近 30 天' },
      { key: 'thisMonth', label: '本月' },
      { key: 'lastMonth', label: '上月' },
      { key: 'custom', label: '自定义' },
    ]
    const GROUPS = [
      { key: 'book', label: '整体' },
      { key: 'actor', label: '分人' },
    ]
    const BOOKS = [
      { key: 'all', label: '两本' },
      { key: 'home', label: '家里' },
      { key: 'shop', label: '店里' },
    ]

    function pad2(value) { return String(value).padStart(2, '0') }

    /** 本地日历日（浏览器时区就是用户时区，DASHBOARD.md 14）。 */
    function isoDay(date = new Date()) {
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    }

    function addDaysIso(day, delta) {
      const parts = String(day).split('-').map(Number)
      const utc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
      utc.setUTCDate(utc.getUTCDate() + delta)
      return utc.toISOString().slice(0, 10)
    }

    function shiftMonthIso(month, delta) {
      const parts = String(month).split('-').map(Number)
      const index = parts[0] * 12 + (parts[1] - 1) + delta
      return Math.floor(index / 12) + '-' + pad2((index % 12 + 12) % 12 + 1)
    }

    function monthBounds(month) {
      const parts = String(month).split('-').map(Number)
      const last = new Date(Date.UTC(parts[0], parts[1], 0)).toISOString().slice(0, 10)
      return { from: month + '-01', to: last }
    }

    /** 预设范围；custom 返回 null，由调用方用输入框里的日期。 */
    function presetRange(key, today = isoDay()) {
      if (key === 'last7') return { from: addDaysIso(today, -6), to: today }
      if (key === 'last30') return { from: addDaysIso(today, -29), to: today }
      if (key === 'thisMonth') return monthBounds(today.slice(0, 7))
      if (key === 'lastMonth') return monthBounds(shiftMonthIso(today.slice(0, 7), -1))
      return null
    }

    /** 服务端回来的范围属于哪个预设；都不像就是自定义。 */
    function presetOf(range, today = isoDay()) {
      for (const preset of PRESETS) {
        if (preset.key === 'custom') continue
        const bounds = presetRange(preset.key, today)
        if (bounds && bounds.from === range.from && bounds.to === range.to) return preset.key
      }
      return 'custom'
    }

    function defaultView() {
      return { preset: 'last30', from: presetRange('last30').from, to: presetRange('last30').to, group: 'book', book: 'all' }
    }

    function readDockView() {
      try {
        const raw = window.localStorage.getItem(DOCK_VIEW_KEY)
        if (!raw) return defaultView()
        const saved = JSON.parse(raw)
        const view = defaultView()
        if (saved && typeof saved === 'object') {
          if (PRESETS.some((preset) => preset.key === saved.preset)) view.preset = saved.preset
          if (GROUPS.some((group) => group.key === saved.group)) view.group = saved.group
          if (BOOKS.some((book) => book.key === saved.book)) view.book = saved.book
        }
        const bounds = presetRange(view.preset)
        if (bounds) { view.from = bounds.from; view.to = bounds.to }
        return view
      } catch {
        return defaultView()
      }
    }

    function writeDockView(view) {
      try {
        window.localStorage.setItem(DOCK_VIEW_KEY, JSON.stringify({ preset: view.preset, group: view.group, book: view.book }))
      } catch {
        // 存不下就算了：记住上次选择只是方便，不是账本的一部分。
      }
    }

    function rangeQuery(view) {
      // 手拼查询串：bundle 里不引 URLSearchParams，少一个运行时依赖。
      const pairs = [['from', view.from], ['to', view.to], ['group', view.group], ['book', view.book]]
      return RANGE_URL + '?' + pairs
        .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
        .join('&')
    }

    const dockButtonStyle = {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      width: '56px',
      height: '56px',
      borderRadius: '28px',
      border: '1px solid ' + C.borderStrong,
      background: 'var(--dsw-alias-bg-layer-2, rgba(40,42,48,0.92))',
      color: C.text,
      fontSize: '17px',
      fontWeight: 600,
      cursor: 'pointer',
      zIndex: 2147482200,
      boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
      backdropFilter: 'blur(6px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 0,
      lineHeight: 1,
    }

    const overlayStyle = {
      position: 'fixed',
      inset: 0,
      zIndex: 2147482100,
      background: 'rgba(0,0,0,0.45)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
    }

    const modalStyle = {
      width: 'min(1120px, 92vw)',
      height: 'min(820px, 88vh)',
      display: 'flex',
      flexDirection: 'column',
      borderRadius: '16px',
      border: '1px solid ' + C.border,
      background: 'var(--dsw-alias-bg-layer-1, #17181c)',
      color: C.text,
      boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
      overflow: 'hidden',
    }

    const dockHeaderStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '16px',
      padding: '14px 20px',
      borderBottom: '1px solid ' + C.border,
    }

    const dockBodyStyle = {
      flex: 1,
      overflowY: 'auto',
      padding: '16px 20px 28px',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
    }

    const dockFooterStyle = {
      padding: '10px 20px',
      borderTop: '1px solid ' + C.border,
      fontSize: '12px',
      color: C.dim,
      display: 'flex',
      justifyContent: 'space-between',
      gap: '12px',
    }

    function segButton(active) {
      return active
        ? { ...buttonStyle, borderColor: C.accent, color: C.accent, fontWeight: 600 }
        : buttonStyle
    }

    function LedgerDockButton(props) {
      const open = props.open === true
      return React.createElement('button', {
        type: 'button',
        title: open ? '关闭账本看板' : '账本看板 · 最近 30 天',
        'aria-label': open ? '关闭账本看板' : '账本看板',
        'aria-expanded': open ? 'true' : 'false',
        style: open ? { ...dockButtonStyle, borderColor: C.accent, color: C.accent } : dockButtonStyle,
        onClick: props.onClick,
      }, open ? '×' : '账')
    }

    function RangeToolbar(props) {
      const view = props.view
      const today = props.today || isoDay()
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' } },
          PRESETS.filter((preset) => preset.key !== 'custom').map((preset) => React.createElement('button', {
            key: preset.key,
            type: 'button',
            style: segButton(preset.key === view.preset),
            onClick: () => props.onPreset(preset.key),
          }, preset.label)),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            React.createElement('input', {
              type: 'date',
              style: { ...inputStyle, width: '136px' },
              value: view.from,
              'aria-label': '开始日期',
              onChange: (event) => props.onCustomFrom(event.target.value),
            }),
            React.createElement('span', { style: dimStyle }, '→'),
            React.createElement('input', {
              type: 'date',
              style: { ...inputStyle, width: '136px' },
              value: view.to,
              'aria-label': '结束日期',
              onChange: (event) => props.onCustomTo(event.target.value),
            }))),
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '18px', alignItems: 'center' } },
          React.createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            React.createElement('span', { style: dimStyle }, '视角'),
            GROUPS.map((group) => React.createElement('button', {
              key: group.key,
              type: 'button',
              style: segButton(group.key === view.group),
              onClick: () => props.onGroup(group.key),
            }, group.label))),
          React.createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            React.createElement('span', { style: dimStyle }, '账本'),
            BOOKS.map((book) => React.createElement('button', {
              key: book.key,
              type: 'button',
              style: segButton(book.key === view.book),
              onClick: () => props.onBook(book.key),
            }, book.label))),
          props.recentFrom ? React.createElement('span', { style: dimStyle }, '最近一次记录 ' + shortDate(props.recentFrom)) : null))
    }

    /** 纯展示：整个弹窗。数据没到就显示一句人话，不闪骨架。 */
    function LedgerDock(props) {
      const open = props.open === true
      // 按钮一直留在右下角（盖在遮罩之上），打开时变成「×」：
      // 之前打开就整块消失，看起来像入口被点没了。
      const toggle = React.createElement(LedgerDockButton, {
        key: 'toggle',
        open,
        onClick: open ? props.onClose : props.onOpen,
      })
      if (!open) return [toggle]
      const data = props.data
      const view = props.view
      const storage = (data && data.storage) || {}
      const range = (data && data.range) || {}
      const summary = (data && data.summary) || []
      const dialog = React.createElement('div', { style: overlayStyle, onClick: props.onClose, role: 'presentation' },
        React.createElement('div', {
          style: modalStyle,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '账本看板',
          onClick: (event) => event.stopPropagation(),
        },
        React.createElement('div', { style: dockHeaderStyle },
          React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            React.createElement('div', { style: { fontSize: '16px', fontWeight: 600 } }, '账本看板'),
            React.createElement('div', { style: dimStyle }, range.label || '最近 30 天')),
          React.createElement('div', { style: { display: 'flex', gap: '8px' } },
            React.createElement('button', { type: 'button', style: buttonStyle, onClick: props.onRefresh }, '刷新'),
            React.createElement('button', { type: 'button', style: buttonStyle, onClick: props.onClose, 'aria-label': '关闭' }, '关闭'))),
        React.createElement('div', { style: { padding: '12px 20px 0' } },
          React.createElement(RangeToolbar, {
            view: view,
            recentFrom: (data && data.recent && data.recent[0] && data.recent[0].date) || null,
            onPreset: props.onPreset,
            onCustomFrom: props.onCustomFrom,
            onCustomTo: props.onCustomTo,
            onGroup: props.onGroup,
            onBook: props.onBook,
          })),
        React.createElement('div', { style: dockBodyStyle },
          props.error
            ? React.createElement('div', { style: { padding: '10px 12px', borderRadius: '10px', border: '1px solid ' + C.error, color: C.error, fontSize: '13px' } },
              '读不到账本：' + props.error)
            : null,
          !data && !props.error
            ? React.createElement('div', { style: dimStyle }, '正在读账本…')
            : null,
          data ? React.createElement(DockSummary, { lines: summary }) : null,
          data
            ? React.createElement(DockBody, {
              data,
              onPreset: props.onPreset,
              actorView: view.group === 'actor' && data.actors
                ? React.createElement(ActorBoard, { actors: data.actors, onRename: props.onRename })
                : null,
            })
            : null),
        React.createElement('div', { style: dockFooterStyle },
          React.createElement('span', null,
            (storage.data_dir || '') + (storage.is_default ? '（默认位置）' : '（自定义位置）') +
            ' · 命中 ' + (storage.matched || 0) + ' 条' +
            (storage.quarantined > 0 ? ' · 隔离 ' + storage.quarantined + ' 行' : '')),
          React.createElement('span', null,
            (props.loading ? '读取中… · ' : '') + '读于 ' + (data && data.generated_at ? data.generated_at.slice(11, 19) : '—')))))

      return [toggle, dialog]
    }

    /** 摘要：服务端给句子，前端只排版（措辞与聊天里一致）。 */
    function DockSummary(props) {
      const lines = props.lines || []
      if (lines.length === 0) return null
      return React.createElement('div', {
        style: { padding: '12px 14px', borderRadius: '10px', background: C.layer, border: '1px solid ' + C.border, display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', lineHeight: '20px' },
      }, lines.map((line, index) => React.createElement('div', { key: line.kind + index }, line.text)))
    }

    /** 图表配色：不用主题强调色——它在这个主题里接近白色，条和底分不开。 */
    const CHART_BAR = '#4f8ef7'
    const CHART_INCOME = '#2f9e44'
    const CHART_HEIGHT = 150
    const CHART_TICKS = [1, 0.8, 0.6, 0.4, 0.2, 0]
    const CHART_LABEL_WIDTH = 52

    /** 把峰值向上取整成 1/2/5×10ⁿ，轴刻度才是整数钱。 */
    function niceCeil(value) {
      const amount = Math.max(1, Math.round(value))
      const exponent = Math.floor(Math.log10(amount))
      const base = Math.pow(10, exponent)
      const scaled = amount / base
      const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
      return step * base
    }

    /** 轴上的钱：小钱带两位小数，上万用「万」，别在轴上演算术题。 */
    function axisText(minor) {
      const yuan = minor / 100
      if (yuan >= 10000) {
        const wan = yuan / 10000
        return '¥' + (Number.isInteger(wan) ? wan : wan.toFixed(1)) + '万'
      }
      if (Number.isInteger(yuan)) return '¥' + yuan
      return '¥' + yuan.toFixed(2)
    }

    /** 左侧刻度 + 虚线网格 + 底部基线；children 一排柱子，overlay 画线。 */
    function ChartFrame(props) {
      const max = props.max > 0 ? props.max : 100
      const height = props.height || CHART_HEIGHT
      const labels = CHART_TICKS.map((fraction) => React.createElement('div', {
        key: 'tick-' + fraction,
        style: {
          position: 'absolute',
          right: 0,
          bottom: (fraction * 100) + '%',
          transform: fraction === 0 ? 'none' : 'translateY(50%)',
          fontSize: '10px',
          lineHeight: '12px',
          color: C.dim,
          whiteSpace: 'nowrap',
        },
      }, axisText(fraction * max)))
      const gridlines = CHART_TICKS.filter((fraction) => fraction > 0).map((fraction) => React.createElement('div', {
        key: 'grid-' + fraction,
        style: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: (fraction * 100) + '%',
          borderTop: '1px dashed ' + C.border,
          opacity: 0.7,
        },
      }))
      return React.createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } },
        React.createElement('div', { style: { position: 'relative', width: CHART_LABEL_WIDTH + 'px', flex: 'none', height: height + 'px' } }, labels),
        React.createElement('div', { style: { position: 'relative', flex: 1, height: height + 'px', borderBottom: '1px solid ' + C.border } },
          gridlines,
          React.createElement('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: '2px' } }, props.children),
          props.overlay || null))
    }

    /**
     * 一根柱子。hover 时把精确数字浮在柱顶——原生 title 要等一秒、
     * 而且在截图和长辈手机上等于没有，所以自己画一个。
     */
    function ChartColumn(props) {
      const [hover, setHover] = React.useState(false)
      const tip = props.tip
        ? React.createElement('div', {
          style: {
            position: 'absolute',
            bottom: 'calc(' + Math.min(78, Math.max(0, Math.round((props.fraction || 0) * 100))) + '% + 8px)',
            left: props.align === 'left' ? '0' : undefined,
            right: props.align === 'right' ? '0' : undefined,
            transform: props.align === 'left' || props.align === 'right' ? 'none' : 'translateX(-50%)',
            display: hover ? 'block' : 'none',
            zIndex: 3,
            padding: '6px 8px',
            borderRadius: '8px',
            background: '#24262b',
            color: '#f4f4f6',
            border: '1px solid rgba(255,255,255,0.16)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            fontSize: '12px',
            lineHeight: '16px',
            whiteSpace: 'pre',
            pointerEvents: 'none',
          },
        }, props.tip)
        : null
      return React.createElement('div', {
        'aria-label': props.title,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          flex: 1,
          minWidth: '2px',
          position: 'relative',
          display: 'flex',
          flexDirection: props.reverse ? 'column-reverse' : 'column',
          justifyContent: 'flex-end',
          height: '100%',
        },
      }, tip, props.children)
    }

    /** X 轴日期：和刻度左对齐，只隔几个写一次，避免糊成一片。 */
    function AxisLabels(props) {
      const points = props.points || []
      const step = points.length <= 7 ? 1 : Math.ceil(points.length / 6)
      return React.createElement('div', { style: { display: 'flex', gap: '2px', paddingLeft: (CHART_LABEL_WIDTH + 6) + 'px', ...dimStyle } },
        points.map((point, index) => React.createElement('div', {
          key: point.key,
          style: { flex: 1, minWidth: '2px', textAlign: 'center', fontSize: '10px', overflow: 'hidden', whiteSpace: 'nowrap' },
        }, index % step === 0 || index === points.length - 1 ? point.label.slice(0, 5) : '')))
    }

    /** 每日支出柱 + 收入线：纯 div/SVG，不引图表库（DASHBOARD.md 6.2）。 */
    function DailyChart(props) {
      const points = props.points || []
      if (points.length === 0) return emptyText('这段时间没有记录。')
      const income = points.some((point) => point.home_income_minor > 0)
      const peak = Math.max(1, ...points.map((point) => Math.max(point.home_expense_minor || 0, point.home_income_minor || 0)))
      const max = niceCeil(peak)
      const yOf = (value) => 100 - (Math.max(0, value) / max) * 100
      const xOf = (index) => (points.length <= 1 ? 50 : (index / (points.length - 1)) * 100)
      const line = income
        ? React.createElement('svg', {
          viewBox: '0 0 100 100',
          preserveAspectRatio: 'none',
          'aria-hidden': 'true',
          style: { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' },
        }, React.createElement('polyline', {
          points: points.map((point, index) => xOf(index) + ',' + yOf(point.home_income_minor)).join(' '),
          fill: 'none',
          stroke: CHART_INCOME,
          strokeWidth: 1.5,
          vectorEffect: 'non-scaling-stroke',
        }))
        : null
      const legend = React.createElement('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', ...dimStyle } },
        React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
          React.createElement('span', { style: { width: '8px', height: '8px', borderRadius: '2px', background: CHART_BAR, display: 'inline-block' } }),
          '支出'),
        income
          ? React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
            React.createElement('span', { style: { width: '12px', height: '2px', background: CHART_INCOME, display: 'inline-block' } }),
            '收入')
          : null)
      const columns = points.map((point, index) => React.createElement(ChartColumn, {
        key: point.key,
        align: index === 0 ? 'left' : index === points.length - 1 ? 'right' : 'center',
        title: point.label + ' 支出 ' + formatMoney(point.home_expense_minor) + ' · 收入 ' + formatMoney(point.home_income_minor) + ' · ' + point.count + ' 笔',
        tip: point.label + '\n支出 ' + formatMoney(point.home_expense_minor)
          + (point.home_income_minor > 0 ? '\n收入 ' + formatMoney(point.home_income_minor) : '')
          + '\n' + point.count + ' 笔',
        fraction: Math.max(point.home_expense_minor, point.home_income_minor || 0) / max,
      },
      React.createElement('div', {
        style: {
          height: (point.home_expense_minor / max) * 100 + '%',
          minHeight: point.home_expense_minor > 0 ? '3px' : '0',
          background: CHART_BAR,
          borderRadius: '2px 2px 0 0',
        },
      })))
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        legend,
        React.createElement(ChartFrame, { max, overlay: line }, columns),
        React.createElement(AxisLabels, { points }))
    }

    /** 一张卡：标题 + 一行说明 + 内容。 */
    function DockCard(props) {
      return React.createElement('div', { style: { ...cardStyle, flex: props.flex || '1 1 320px', minWidth: '280px' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' } },
          React.createElement('div', { style: h2Style }, props.title),
          props.note ? React.createElement('div', { style: dimStyle }, props.note) : null),
        props.children)
    }

    function CategoryCard(props) {
      const categories = props.categories || { rows: [], uncategorized: { minor: 0, count: 0 } }
      const uncategorized = categories.uncategorized || { minor: 0, count: 0 }
      return React.createElement(DockCard, { title: '家里花在哪', note: categories.total_minor ? formatMoney(categories.total_minor) : null },
        uncategorized.count > 0
          ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' } },
            React.createElement('span', { style: { width: '6px', height: '6px', borderRadius: '3px', background: C.error } }),
            React.createElement('span', null, '未归类 ' + uncategorized.count + ' 笔 ' + formatMoney(uncategorized.minor)),
            React.createElement('span', { style: dimStyle }, '（说一句「那笔算餐饮」就能归好）'))
          : null,
        React.createElement(CategoryBars, { rows: categories.rows, empty: '这段时间还没有支出。' }))
    }

    function ShopCard(props) {
      const shop = props.shop
      const line = (label, value, extra) => React.createElement('div', { style: { display: 'flex', gap: '10px', fontSize: '13px' } },
        React.createElement('div', { style: { width: '82px', flex: 'none', ...dimStyle } }, label),
        React.createElement('div', { style: { flex: 1 } }, value),
        extra ? React.createElement('div', { style: dimStyle }, extra) : null)
      return React.createElement(DockCard, { title: '店里：卖出与现金' },
        line('卖出', formatMoney(shop.sales_minor), shop.sales_count + ' 单'),
        line('实收', formatMoney(shop.cash_in_minor)),
        line('赊出', formatMoney(shop.credit_out_minor || 0)),
        line('现金净', formatMoney(shop.cash_net_minor), '收 ' + formatMoney(shop.cash_in_minor) + ' / 付 ' + formatMoney(shop.cash_out_minor)))
    }

    function RecentCard(props) {
      const rows = props.rows || []
      return React.createElement(DockCard, { title: '最近记录', note: rows.length > 0 ? rows.length + ' 笔' : null },
        rows.length === 0
          ? emptyText('这段时间没有记录。')
          : React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
            rows.map((row) => React.createElement('div', {
              key: row.id,
              style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 0', borderTop: '1px solid ' + C.border, fontSize: '13px' },
            },
            React.createElement('div', { style: { width: '44px', flex: 'none', ...dimStyle } }, shortDate(row.date)),
            React.createElement('div', { style: { width: '38px', flex: 'none', ...dimStyle } }, row.book === 'shop' ? '店里' : '家里'),
            React.createElement('div', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              (row.counterparty ? row.counterparty + ' · ' : '') + (row.note || row.kind_label) +
              (row.category_label ? ' · ' + row.category_label : '')),
            React.createElement('div', { style: { width: '80px', flex: 'none', textAlign: 'right' } }, formatMoney(row.amount_minor)),
            React.createElement('div', { style: { width: '56px', flex: 'none', textAlign: 'right', ...dimStyle } }, row.entered_by_name || ''),
            row.kind === 'transfer' || row.kind === 'draw'
              ? React.createElement('div', { style: { width: '70px', flex: 'none', textAlign: 'right', fontSize: '11px', ...dimStyle } }, '不计收支')
              : null))))
    }

    function DebtCard(props) {
      const debt = props.debt || { receivable: { people: [], total_minor: 0, people_count: 0 }, payable: { people: [], total_minor: 0, people_count: 0 }, as_of: '' }
      const side = (title, data, emptyLabel) => React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '13px' } },
          React.createElement('span', { style: dimStyle }, title),
          React.createElement('span', null, formatMoney(data.total_minor) + (data.people_count > 0 ? ' · ' + data.people_count + ' 人' : ''))),
        (data.people || []).length === 0
          ? React.createElement('div', { style: dimStyle }, emptyLabel)
          : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            data.people.map((person) => React.createElement('div', { key: person.name, style: { display: 'flex', gap: '8px', fontSize: '13px' } },
              React.createElement('span', { style: { flex: 1 } }, person.name),
              React.createElement('span', { style: { ...dimStyle, color: person.age_days > 90 ? C.error : person.age_days > 30 ? '#c99700' : C.dim } }, person.age_days + ' 天'),
              React.createElement('span', null, formatMoney(person.open_minor))))))
      return React.createElement(DockCard, { title: '欠账', note: debt.as_of ? '截至 ' + debt.as_of.slice(5) : null },
        side('应收（别人欠我）', debt.receivable || { people: [], total_minor: 0, people_count: 0 }, '没有欠账'),
        side('应付（我欠别人）', debt.payable || { people: [], total_minor: 0, people_count: 0 }, '没有欠账'))
    }

    /** 分人色板：每人固定一色，超出六人合并成灰（DASHBOARD.md 6.4）。 */
    const ACTOR_COLORS = ['#4f8ef7', '#8b5cf6', '#2f9e44', '#c99700', '#e5484d', '#0b7285']

    function actorColor(index) {
      return ACTOR_COLORS[index] || C.dim
    }

    /**
     * 分人视图：谁记的（不是谁花的），按金额排行 + 每日堆叠。
     * 名字可改：改的是 meta 里的别名，历史记录一个字都不动。
     */
    function ActorBoard(props) {
      const actors = props.actors || []
      if (actors.length === 0) return React.createElement(DockCard, { title: '谁记的' }, emptyText('这段时间没有人记过账。'))
      const series = (actors[0] && actors[0].points) || []
      const ranking = actors.slice(0, 6)
      const rest = actors.slice(6)
      const totals = series.map((point, index) => actors.reduce((sum, actor) => sum + ((actor.points[index] && actor.points[index].minor) || 0), 0))
      const axisMax = niceCeil(Math.max(1, ...totals))

      const nameInput = (actor) => React.createElement('input', {
        type: 'text',
        'aria-label': '给 ' + actor.name + ' 改名',
        defaultValue: actor.name,
        title: actor.name_source === 'id' ? '这是微信 id，改个名字以后就按名字显示' : '点这里改名字',
        style: { width: '112px', flex: 'none', padding: '2px 6px', fontSize: '13px', borderRadius: '6px', border: '1px solid ' + C.border, background: 'transparent', color: C.text },
        onKeyDown: (event) => { if (event.key === 'Enter' && props.onRename) props.onRename(actor.key, event.target.value) },
        onBlur: (event) => { if (props.onRename && event.target.value !== actor.name) props.onRename(actor.key, event.target.value) },
      })

      const row = (actor, index) => React.createElement('div', { key: actor.key, style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        nameInput(actor),
        React.createElement('div', { style: { flex: 1, height: '8px', borderRadius: '4px', background: C.layer2, overflow: 'hidden' } },
          React.createElement('div', { style: { width: Math.max(2, Math.round(actor.share_bp / 100)) + '%', height: '100%', background: actorColor(index), opacity: 0.8 } })),
        React.createElement('div', { style: { width: '84px', flex: 'none', textAlign: 'right', fontSize: '13px' } }, formatMoney(actor.expense_minor)),
        React.createElement('div', { style: { width: '72px', flex: 'none', textAlign: 'right', ...dimStyle } }, actor.count + ' 笔 · ' + (actor.share_bp / 100).toFixed(1) + '%'),
        actor.uncategorized_count > 0
          ? React.createElement('div', { style: { width: '48px', flex: 'none', textAlign: 'right', fontSize: '11px', color: C.error } }, actor.uncategorized_count + ' 未归类')
          : null)

      const restLine = rest.length > 0
        ? React.createElement('div', { style: dimStyle }, '另有 ' + rest.length + ' 人合计 ' + formatMoney(rest.reduce((sum, actor) => sum + actor.expense_minor, 0)))
        : null

      const rankingCard = React.createElement(DockCard, { title: '谁记的', note: actors.length + ' 人' },
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          ranking.map((actor, index) => row(actor, index)),
          restLine))

      const legend = React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', ...dimStyle } },
        ranking.map((actor, index) => React.createElement('span', { key: actor.key, style: { display: 'flex', alignItems: 'center', gap: '4px' } },
          React.createElement('span', { style: { width: '8px', height: '8px', borderRadius: '4px', background: actorColor(index), display: 'inline-block' } }),
          actor.name)))

      const columns = series.map((point, index) => {
        const segments = actors.map((actor, actorIndex) => {
          const minor = (actor.points[index] && actor.points[index].minor) || 0
          if (minor <= 0) return null
          return React.createElement('div', {
            key: actor.key,
            style: { height: (minor / axisMax) * 100 + '%', minHeight: '1px', background: actorColor(actorIndex) },
          })
        })
        const lines = [point.key + ' \u00b7 ' + formatMoney(totals[index])]
        const speakers = actors.filter((actor) => ((actor.points[index] && actor.points[index].minor) || 0) > 0)
        for (const actor of speakers.slice(0, 5)) {
          lines.push(actor.name + ' ' + formatMoney((actor.points[index] && actor.points[index].minor) || 0))
        }
        if (speakers.length > 5) lines.push('另有 ' + (speakers.length - 5) + ' 人')
        return React.createElement(ChartColumn, {
          key: point.key,
          title: point.key + ' · ' + formatMoney(totals[index]),
          tip: lines.join('\n'),
          fraction: totals[index] / axisMax,
          align: index === 0 ? 'left' : index === series.length - 1 ? 'right' : 'center',
          reverse: true,
        }, segments)
      })

      const stackCard = React.createElement(DockCard, { title: '每日 × 记账人', note: actors.length + ' 人' },
        legend,
        React.createElement(ChartFrame, { max: axisMax }, columns),
        React.createElement(AxisLabels, { points: series }))

      return React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-start' } },
        rankingCard,
        stackCard)
    }

    /** 面板主体：KPI → 图表 → 明细。缺哪块数据就少画哪块，不编零出来。 */
    function DockBody(props) {
      const data = props.data || {}
      const totals = data.totals || {}
      const cards = []
      if (totals.home) {
        cards.push(['家里支出', formatMoney(totals.home.expense_minor - totals.home.refund_minor),
          '日均 ' + formatMoney(totals.home.avg_per_day_minor) + ' · ' + totals.home.count + ' 笔'])
        cards.push(['家里收入', formatMoney(totals.home.income_minor), '净 ' + formatMoney(totals.home.net_minor)])
      }
      if (totals.shop) {
        cards.push(['店里卖出', formatMoney(totals.shop.sales_minor), totals.shop.sales_count + ' 单 · 实收 ' + formatMoney(totals.shop.cash_in_minor)])
        cards.push(['现金净流', formatMoney(totals.shop.cash_net_minor), '收 ' + formatMoney(totals.shop.cash_in_minor) + ' / 付 ' + formatMoney(totals.shop.cash_out_minor)])
      }
      if (data.debt) {
        cards.push(['应收未收', formatMoney(data.debt.receivable.total_minor),
          data.debt.receivable.people_count > 0 ? data.debt.receivable.people_count + ' 人' : '没有欠账'])
      }
      const empty = data.storage && data.storage.matched === 0
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px' } },
          cards.map(([label, value, sub]) => React.createElement(Stat, { key: label, label, value, sub }))),
        props.actorView || null,
        empty
          ? React.createElement(DockCard, { title: '这段时间没有记录' },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', ...dimStyle } },
              React.createElement('span', null, '换个范围试试：'),
              React.createElement('button', { type: 'button', style: primaryButtonStyle, onClick: () => props.onPreset && props.onPreset('last30') }, '近 30 天')))
          : null,
        !empty && totals.home
          ? React.createElement(DockCard, { title: '每日支出', note: data.range ? data.range.days + ' 天' : null },
            React.createElement(DailyChart, { points: (data.series && data.series.points) || [], bucket: data.series && data.series.bucket }))
          : null,
        !empty
          ? React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-start' } },
            totals.home ? React.createElement(CategoryCard, { categories: data.categories }) : null,
            totals.shop ? React.createElement(ShopCard, { shop: totals.shop }) : null,
            totals.shop && totals.shop.uncategorized_count > 0
              ? React.createElement(DockCard, { title: '店里未归类' }, emptyText(totals.shop.uncategorized_count + ' 笔进货/开销没归类，说一句就能补。'))
              : null)
          : null,
        !empty
          ? React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-start' } },
            React.createElement(RecentCard, { rows: data.recent || [] }),
            React.createElement(DebtCard, { debt: data.debt }))
          : null)
    }

    /** 把状态和数据集中在这里：纯展示组件（LedgerDock）留给 vm 测试。 */
    function LedgerDockHost() {
      const [open, setOpen] = React.useState(false)
      const [view, setView] = React.useState(readDockView)
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)

      const load = React.useCallback((next) => {
        setLoading(true)
        fetch(rangeQuery(next))
          .then((response) => (response.ok ? response.json() : response.json().then((body) => Promise.reject(new Error(body.error || ('HTTP ' + response.status))))))
          .then((value) => { setData(value); setError(null) })
          .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)))
          .finally(() => setLoading(false))
      }, [])

      const apply_ = (patch) => {
        const next = { ...view, ...patch }
        if (patch.preset && patch.preset !== 'custom') {
          const bounds = presetRange(patch.preset)
          if (bounds) { next.from = bounds.from; next.to = bounds.to }
        }
        setView(next)
        writeDockView(next)
        if (open) load(next)
      }

      React.useEffect(() => {
        if (open) load(view)
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        const timer = setInterval(() => load(view), REFRESH_MS)
        return () => clearInterval(timer)
      }, [open, view.preset, view.from, view.to, view.group, view.book])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const rename = (key, name) => {
        fetch(ACTORS_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key, name }),
        })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
          .then(() => load(view))
          .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)))
      }

      return React.createElement(LedgerDock, {
        open,
        data,
        view,
        error,
        loading,
        onRename: rename,
        onOpen: () => setOpen(true),
        onClose: () => setOpen(false),
        onRefresh: () => load(view),
        onPreset: (preset) => apply_({ preset }),
        onCustomFrom: (from) => apply_({ from, preset: 'custom' }),
        onCustomTo: (to) => apply_({ to, preset: 'custom' }),
        onGroup: (group) => apply_({ group }),
        onBook: (book) => apply_({ book }),
      })
    }

    /**
     * 挂载：建一个宿主节点渲染自己，卸载时连根拔掉。
     * 只有真浏览器里能跑，Node 里调用直接返回 noop（vm 测试就是这么跑的）。
     */
    function mountDock() {
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return () => {}
      let createRoot
      try {
        createRoot = require('react-dom/client').createRoot
      } catch (failure) {
        // 宿主没给 react-dom 就等于没有入口，说一声别静默消失。
        console.warn('[ledger] 右下角看板没有挂载：', failure)
        return () => {}
      }
      const existing = document.getElementById('dsh-ledger-dock-root')
      if (existing) existing.remove()
      const host = document.createElement('div')
      host.id = 'dsh-ledger-dock-root'
      document.body.appendChild(host)
      const root = createRoot(host)
      root.render(React.createElement(LedgerDockHost))
      return () => {
        try { root.unmount() } catch { /* 已经卸载过就算了 */ }
        host.remove()
      }
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-ledger',
        order: 80,
        label: () => 'Ledger',
      }, LedgerSection))

      // 右下角看板：与设置区块共用同一份 bundle，但自己建根节点，
      // 这样它能在任何页面出现，又不会挤进布局。
      const disposeDock = mountDock()
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => disposeDock, 'dsh-ledger:dock')
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    // 浏览器半不能在 Node 里跑；纯函数与纯展示组件留给 vm 测试用。
    exports.__test = {
      formatMoney,
      formatShare,
      shortDate,
      LedgerPanel,
      LedgerDock,
      RangeToolbar,
      ActorBoard,
      DailyChart,
      DockBody,
      presetRange,
      presetOf,
      isoDay,
      addDaysIso,
      shiftMonthIso,
      rangeQuery,
    }

    return module.exports
  },
})