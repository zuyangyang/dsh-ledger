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
    const primaryButtonStyle = { ...buttonStyle, background: C.accent, borderColor: C.accent, color: '#fff', fontWeight: 600 }
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
      const canPrev = months.length > 0
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
            React.createElement('div', { style: h2Style }, '家里花在哪'),
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
            (storage.git_error ? ' · git 不可用：' + storage.git_error : '')),
          React.createElement('span', null,
            '隔离行 ' + (storage.quarantined || 0) + ' · 配置文件：' + ((props.config && props.config.ui_config_path) || '未知'))),
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

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-ledger',
        order: 80,
        label: () => 'Ledger',
      }, LedgerSection))
    }

    exports.apply = apply
    exports.inject = ['slots']
    // 浏览器半不能在 Node 里跑；纯函数与纯展示组件留给 vm 测试用。
    exports.__test = { formatMoney, formatShare, shortDate, LedgerPanel }

    return module.exports
  },
})