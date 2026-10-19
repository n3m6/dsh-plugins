window.__ModuleLoader__.load({
  id: '@local/dsh-compaction-threshold',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const NS = 'compactionThreshold'
    const ENTRY_ID = 'compaction-threshold-settings'
    const DEFAULT_THRESHOLD_TOKENS = 300_000
    const SELECT_ID = 'compaction-threshold-select'
    const OPTIONS = [100_000, 150_000, 200_000, 250_000, 300_000, 400_000, 500_000, 650_000]

    const en = {
      title: 'Context compaction',
      description:
        'Summarize older history once the conversation reaches this many tokens. '
        + 'The 300k default leaves room for large tool results; the effective trigger '
        + 'is capped by the routed model\'s context window.',
      indicator: 'compact',
      aria: '{percent}% to compaction, ~{used} of {trigger} tokens',
      ariaWaiting: 'Compaction at ~{trigger} tokens, waiting for the first request',
      tooltip: '{percent}% to compaction · ~{used} / {trigger}',
      tooltipWaiting: 'Compaction at ~{trigger} · waiting for the first request',
      tooltipShare: 'trigger {share}% of the {window} window',
      panelTitle: 'Compaction',
      panelBarAria: 'Current context composition toward the compaction trigger',
      panelSystem: 'System',
      panelTools: 'Tools',
      panelMessages: 'Messages',
      panelRemaining: 'Remaining to trigger',
      panelTrigger: 'Trigger',
      panelWindow: 'Context window',
      panelShare: 'Trigger share',
      panelShareValue: '{share}% of {window}',
      panelWaiting: 'Waiting for the first request',
      panelNote:
        'At the trigger, older history is summarized and the context ring drops. '
        + 'The effective trigger is capped by the routed model\'s window.',
      panelLegacy: 'New sessions use this trigger; an earlier session keeps its original preset.',
    }
    const zh = {
      title: '上下文压缩',
      description:
        '对话达到此 token 数后压缩较早的历史。默认 300k，为较大的工具结果留出空间；'
        + '实际触发点受当前模型上下文窗口上限约束。',
      indicator: '压缩',
      aria: '距压缩 {percent}%，约 {used} / {trigger} tokens',
      ariaWaiting: '压缩触发点约 {trigger} tokens，等待首次请求',
      tooltip: '距压缩 {percent}% · ~{used} / {trigger}',
      tooltipWaiting: '压缩触发点 ~{trigger} · 等待首次请求',
      tooltipShare: '触发点占 {window} 窗口的 {share}%',
      panelTitle: '压缩',
      panelBarAria: '当前上下文构成与压缩触发点的关系',
      panelSystem: '系统',
      panelTools: '工具',
      panelMessages: '消息',
      panelRemaining: '距触发点',
      panelTrigger: '触发点',
      panelWindow: '上下文窗口',
      panelShare: '触发点占比',
      panelShareValue: '占 {window} 的 {share}%',
      panelWaiting: '等待首次请求',
      panelNote: '达到触发点后会压缩较早历史，上下文圆环随之下降。实际触发点受当前模型窗口上限约束。',
      panelLegacy: '新会话使用此触发点；此前启动的会话保留原预设。',
    }

    const styles = {
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '16px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l3)',
      },
      text: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      title: { fontSize: '14px', lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
      description: {
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-caption)',
        maxWidth: '560px',
      },
      select: {
        flex: 'none',
        minWidth: '132px',
        padding: '6px 10px',
        fontSize: '13px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-sm, 8px)',
        cursor: 'pointer',
      },
      indicator: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '1px 8px',
        fontFamily: 'inherit',
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
        color: 'var(--dsw-alias-label-tertiary)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        background: 'transparent',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer',
      },
      ring: { flex: 'none', width: '14px', height: '14px' },
      ringTrack: { fill: 'none', stroke: 'var(--dsw-alias-border-l3)', strokeWidth: 2 },
      ringFill: {
        fill: 'none',
        stroke: 'var(--dsw-alias-state-business-primary)',
        strokeWidth: 2,
        strokeLinecap: 'round',
      },
      tooltip: {
        position: 'fixed',
        zIndex: 1200,
        boxSizing: 'border-box',
        maxWidth: '300px',
        padding: '6px 8px',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: 'var(--dsw-elevation-prominent)',
        '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
        fontSize: '12px',
        lineHeight: '18px',
        pointerEvents: 'none',
      },
      tooltipLine: { display: 'block', whiteSpace: 'nowrap' },
      tooltipSub: {
        display: 'block',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      panel: {
        position: 'fixed',
        zIndex: 1100,
        boxSizing: 'border-box',
        width: 'min(264px, 100vw - 24px)',
        padding: '12px',
        borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-specific-menu)',
        color: 'var(--dsw-alias-label-secondary)',
        boxShadow: 'var(--dsw-elevation-prominent)',
        '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
        backdropFilter: 'var(--dsw-menu-backdrop-filter)',
        fontSize: '12px',
        lineHeight: '20px',
        cursor: 'default',
      },
      panelHeader: { display: 'flex', alignItems: 'center', gap: '6px' },
      panelTitle: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
      panelPercent: {
        marginLeft: 'auto',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 500,
      },
      panelFigures: {
        color: 'var(--dsw-alias-label-primary)',
        fontVariantNumeric: 'tabular-nums',
        fontWeight: 500,
      },
      panelBar: {
        display: 'flex',
        gap: '1px',
        height: '4px',
        margin: '10px 0 12px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-interactive-bg-hover)',
        overflow: 'hidden',
      },
      panelSegment: { height: '100%', borderRadius: '1px', flex: 'none', minWidth: '2px' },
      panelRows: { margin: '6px 0 0' },
      panelRow: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '12px',
        padding: '2px 0',
      },
      panelRowDt: { color: 'var(--dsw-alias-label-secondary)' },
      panelRowDd: {
        margin: 0,
        color: 'var(--dsw-alias-label-primary)',
        fontVariantNumeric: 'tabular-nums',
      },
      panelSwatch: {
        display: 'inline-block',
        width: '8px',
        height: '8px',
        marginRight: '6px',
        borderRadius: '2px',
        verticalAlign: 'baseline',
      },
      panelNote: {
        marginTop: '8px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '11px',
        lineHeight: '16px',
      },
      panelLegacy: {
        marginTop: '4px',
        color: 'var(--dsw-alias-label-caption)',
        fontSize: '11px',
        lineHeight: '16px',
      },
    }

    const RING_RADIUS = 5.5
    const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
    const SEGMENT_COLORS = {
      system: 'var(--dsw-static-neutral-bluish-400)',
      tools: '#a78bfa',
      messages: 'var(--dsw-static-blue-450)',
    }

    /**
     * Compact token-count text for the ambient indicator and panel.
     * @param value - token count.
     * @returns `300k`, `12.3k`, `1M`, or a raw small count.
     */
    function formatTokens(value) {
      if (!Number.isFinite(value)) return '300k'
      if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
      if (value >= 1_000) return `${Math.round(value / 100) / 10}k`
      return String(Math.round(value))
    }

    /**
     * Minimal snapshot store for the slot hook: the Settings form is the fact
     * source, and this only makes its snapshots observable to the row.
     * @returns store handle with getSnapshot/subscribe/set.
     */
    function createStore() {
      let snapshot = {
        value: DEFAULT_THRESHOLD_TOKENS,
        status: 'loading',
        writable: false,
      }
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(next) {
          snapshot = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /**
     * Render the General-settings row.
     * @param props - slot props carrying the store hook, write action, and locale.
     * @returns the row element tree.
     */
    function CompactionThresholdRow({ useThreshold, setThreshold, t }) {
      const state = useThreshold((snapshot) => snapshot)
      const value = state.value
      const options = OPTIONS.includes(value) ? OPTIONS : [...OPTIONS, value].sort((a, b) => a - b)
      const label = (typeof t === 'function' ? t('title') : undefined) || en.title
      const description = (typeof t === 'function' ? t('description') : undefined) || en.description
      return h(
        'div',
        { style: styles.row },
        h(
          'div',
          { style: styles.text },
          h('label', { htmlFor: SELECT_ID, style: styles.title }, label),
          h('div', { id: `${SELECT_ID}-description`, style: styles.description }, description),
        ),
        h(
          'select',
          {
            id: SELECT_ID,
            'aria-describedby': `${SELECT_ID}-description`,
            value: String(value),
            disabled: !state.writable || state.status !== 'ready',
            style: { ...styles.select, opacity: state.writable ? 1 : 0.55 },
            onChange: (event) => setThreshold(Number(event.currentTarget.value)),
          },
          options.map((option) =>
            h('option', { key: option, value: String(option) }, `${Math.round(option / 1000)}k tokens`),
          ),
        ),
      )
    }

    /**
     * Ring-and-panel companion to the context meter: how close the current
     * request is to the configured trigger, with the same composition rows the
     * meter's panel uses.
     * @param props - slot props carrying the shared store, projections, and locale.
     * @returns the indicator element and its hover/panel portals.
     */
    function CompactionThresholdIndicator({ useThreshold, useProjection, t }) {
      const state = useThreshold((snapshot) => snapshot)
      const pressure = useProjection('contextPressure')
      const breakdown = useProjection('contextBreakdown')
      const trigger = Number.isFinite(state.value) ? state.value : DEFAULT_THRESHOLD_TOKENS
      const used = pressure?.projectedTokens ?? pressure?.pressureTokens
      const contextWindow = pressure?.contextWindow
      const percent = used === undefined || trigger <= 0
        ? 0
        : Math.min(100, Math.round(used / trigger * 100))
      const remaining = used === undefined ? trigger : Math.max(0, trigger - used)
      const share = contextWindow === undefined || contextWindow <= 0
        ? null
        : Math.min(100, Math.round(trigger / contextWindow * 100))
      const breakdownTotal = breakdown === undefined
        ? 0
        : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
      const segments = breakdown === undefined || breakdownTotal === 0
        ? (percent > 0 ? [{ key: 'total', color: 'var(--dsw-alias-label-tertiary)', width: percent }] : [])
        : [
            {
              key: 'system',
              color: SEGMENT_COLORS.system,
              width: percent * breakdown.systemTokens / breakdownTotal,
            },
            {
              key: 'tools',
              color: SEGMENT_COLORS.tools,
              width: percent * breakdown.toolsTokens / breakdownTotal,
            },
            {
              key: 'messages',
              color: SEGMENT_COLORS.messages,
              width: percent * breakdown.messageTokens / breakdownTotal,
            },
          ].filter((segment) => segment.width > 0)

      const [open, setOpen] = React.useState(false)
      const [hover, setHover] = React.useState(null)
      const [position, setPosition] = React.useState(null)
      const buttonRef = React.useRef(null)
      const panelRef = React.useRef(null)

      const triggerText = formatTokens(trigger)
      const usedText = used === undefined ? null : formatTokens(used)
      const reading = usedText === null
        ? t('ariaWaiting', { trigger: triggerText })
        : t('aria', { percent, used: usedText, trigger: triggerText })

      const openPanel = () => {
        if (open) {
          setOpen(false)
          return
        }
        const rect = buttonRef.current?.getBoundingClientRect()
        if (rect !== undefined) {
          setPosition({
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 272)),
            bottom: window.innerHeight - rect.top + 8,
          })
        }
        setHover(null)
        setOpen(true)
      }

      const showTooltip = () => {
        if (open) return
        const rect = buttonRef.current?.getBoundingClientRect()
        if (rect === undefined) return
        setHover({
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 308)),
          bottom: window.innerHeight - rect.top + 6,
        })
      }

      React.useEffect(() => {
        if (!open) return
        const close = () => setOpen(false)
        const onPointerDown = (event) => {
          if (buttonRef.current?.contains(event.target)) return
          if (panelRef.current?.contains(event.target)) return
          close()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        window.addEventListener('resize', close)
        window.addEventListener('scroll', close, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('resize', close)
          window.removeEventListener('scroll', close, true)
        }
      }, [open])

      const row = (key, label, value, color) =>
        h(
          'div',
          { key, style: styles.panelRow },
          h(
            'dt',
            { style: styles.panelRowDt },
            color !== undefined && h('span', {
              'aria-hidden': true,
              style: { ...styles.panelSwatch, background: color },
            }),
            label,
          ),
          h('dd', { style: styles.panelRowDd }, value),
        )

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            style: {
              ...styles.indicator,
              background: hover === null ? 'transparent' : 'var(--dsw-alias-interactive-bg-hover)',
            },
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': reading,
            onClick: openPanel,
            onMouseEnter: showTooltip,
            onMouseLeave: () => setHover(null),
            'data-composer-compaction': 'threshold',
          },
          h(
            'svg',
            {
              viewBox: '0 0 14 14',
              width: 14,
              height: 14,
              'aria-hidden': true,
              style: styles.ring,
            },
            h('circle', { cx: 7, cy: 7, r: RING_RADIUS, style: styles.ringTrack }),
            h('circle', {
              cx: 7,
              cy: 7,
              r: RING_RADIUS,
              style: styles.ringFill,
              strokeDasharray: `${RING_CIRCUMFERENCE * percent / 100} ${RING_CIRCUMFERENCE}`,
              transform: 'rotate(-90 7 7)',
            }),
          ),
          h('span', null, `${t('indicator')} ~${triggerText}`),
        ),
        hover !== null && !open && ReactDOM.createPortal(
          h(
            'div',
            {
              role: 'tooltip',
              style: { ...styles.tooltip, left: hover.left, bottom: hover.bottom },
            },
            h(
              'span',
              { style: styles.tooltipLine },
              usedText === null
                ? t('tooltipWaiting', { trigger: triggerText })
                : t('tooltip', { percent, used: usedText, trigger: triggerText }),
            ),
            share !== null && h(
              'span',
              { style: styles.tooltipSub },
              t('tooltipShare', { share, window: formatTokens(contextWindow) }),
            ),
          ),
          document.body,
        ),
        open && ReactDOM.createPortal(
          h(
            'div',
            {
              ref: panelRef,
              role: 'dialog',
              'aria-label': t('panelTitle'),
              style: position === null
                ? { ...styles.panel, visibility: 'hidden', left: 0, bottom: 0 }
                : { ...styles.panel, ...position },
            },
            h(
              'div',
              { style: styles.panelHeader },
              h('span', { style: styles.panelTitle }, t('panelTitle')),
              usedText !== null && h('span', { style: styles.panelPercent }, `${percent}%`),
              h(
                'span',
                { style: styles.panelFigures },
                usedText === null ? t('panelWaiting') : `~${usedText} / ${triggerText}`,
              ),
            ),
            h(
              'div',
              { style: styles.panelBar, role: 'img', 'aria-label': t('panelBarAria') },
              segments.map((segment) => h('div', {
                key: segment.key,
                style: {
                  ...styles.panelSegment,
                  width: `${segment.width}%`,
                  background: segment.color,
                },
              })),
            ),
            h(
              'dl',
              { style: styles.panelRows },
              breakdown !== undefined && [
                row('system', t('panelSystem'), `~${formatTokens(breakdown.systemTokens)}`, SEGMENT_COLORS.system),
                row('tools', t('panelTools'), `~${formatTokens(breakdown.toolsTokens)}`, SEGMENT_COLORS.tools),
                row('messages', t('panelMessages'), `~${formatTokens(breakdown.messageTokens)}`, SEGMENT_COLORS.messages),
              ],
              row('remaining', t('panelRemaining'), `~${formatTokens(remaining)}`),
              row('trigger', t('panelTrigger'), `~${triggerText}`),
              row(
                'window',
                t('panelWindow'),
                contextWindow === undefined ? t('panelWaiting') : formatTokens(contextWindow),
              ),
              row(
                'share',
                t('panelShare'),
                share === null
                  ? t('panelWaiting')
                  : t('panelShareValue', { share, window: formatTokens(contextWindow) }),
              ),
            ),
            h('div', { style: styles.panelNote }, t('panelNote')),
            h('div', { style: styles.panelLegacy }, t('panelLegacy')),
          ),
          document.body,
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'configForms', 'remote'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'compaction-threshold: dictionaries')

        const form = ctx.configForms.get(ENTRY_ID)
        const store = createStore()
        const sync = () => {
          const snapshot = form.getSnapshot()
          const value = snapshot.value?.thresholdTokens
          store.set({
            value: typeof value === 'number' ? value : DEFAULT_THRESHOLD_TOKENS,
            status: snapshot.status,
            writable: snapshot.writable === true,
          })
        }
        sync()
        ctx.effect(() => form.subscribe(sync), 'compaction-threshold: form snapshot')

        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            {
              name: 'settings.general.item',
              id: 'compaction-threshold',
              order: 35,
              locale: NS,
              inject: () => ({
                hooks: { threshold: store },
                setThreshold: (value) => {
                  void form.set('thresholdTokens', value)
                },
              }),
            },
            CompactionThresholdRow,
          ),
        )

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'compaction-threshold',
              order: 2,
              locale: NS,
              inject: () => ({ hooks: { threshold: store } }),
            },
            CompactionThresholdIndicator,
          ),
        )
      },
    }
  },
})
