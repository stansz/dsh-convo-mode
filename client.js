/**
 * Client half of dsh-convo-mode.
 *
 * One contribution: a compact toggle chip at the left of the composer tool row. It reads
 * the Host-computed `conversation` projection (durable state, not client optimism) and
 * switches the mode by executing the same `/conversation` line a user would type, so the
 * chip and the slash command can never disagree.
 *
 * Everything is registered inside `apply` through `ctx.slots.inject`; the stylesheet is
 * inserted once per module materialization.
 */
window.__ModuleLoader__.load({
  id: 'dsh-convo-mode',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'conversation-mode';
    /** Host projection key carrying the durable mode state (see the Host half). */
    const PROJECTION_KEY = 'conversation';
    /** Stable module/plugin id. */
    const PLUGIN_ID = 'dsh-convo-mode';
    /** Stylesheet identity used to avoid double insertion. */
    const CSS_ID = PLUGIN_ID + '/client.css';

    /** The chip's styles: host theme tokens only, corrected under the plugin prefix. */
    const CSS = [
      '.cm-wrap{display:inline-flex;align-items:center;gap:6px}',
      '.cm-chip{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;white-space:nowrap}',
      '.cm-chip:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
      '.cm-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.cm-chip:disabled{opacity:.6;cursor:default}',
      '.cm-chip-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.cm-chip-on:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.cm-glyph{display:inline-flex;flex:none;width:14px;height:14px}',
      '.cm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
    ].join('\n');

    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') === null
    ) {
      const tag = document.createElement('style');
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** A small chat-bubble glyph drawn with the current text color. */
    function ChatGlyph() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('path', {
          d: 'M2.8 3.2h10.4c.66 0 1.2.54 1.2 1.2v6.1c0 .66-.54 1.2-1.2 1.2H7.4L4 14.2v-2.5H2.8c-.66 0-1.2-.54-1.2-1.2V4.4c0-.66.54-1.2 1.2-1.2Z',
        }),
        h('circle', { cx: 5.6, cy: 7.4, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 8, cy: 7.4, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 10.4, cy: 7.4, r: 0.9, fill: 'currentColor', stroke: 'none' }),
      );
    }

    /**
     * The mode toggle. The effective target is the Host's folded view, so a change made
     * from another tab or by `/conversation` renders the same here.
     */
    function ConversationChip({ useProjection, t, toggleConversation }) {
      const mode = useProjection(PROJECTION_KEY);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const alive = React.useRef(true);
      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);
      if (mode === undefined) return null;
      const on = mode.active === true;
      const title = on ? t('chip.on.title') : t('chip.off.title');
      const toggle = () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        Promise.resolve(toggleConversation(!on)).then(
          (failure) => {
            if (!alive.current) return;
            setBusy(false);
            setError(typeof failure === 'string' ? failure : null);
          },
          (reason) => {
            if (!alive.current) return;
            setBusy(false);
            setError(reason instanceof Error ? reason.message : String(reason));
          },
        );
      };
      const row = [
        h(
          'button',
          {
            key: 'chip',
            type: 'button',
            className: on ? 'cm-chip cm-chip-on' : 'cm-chip',
            'aria-label': title,
            'aria-pressed': on,
            title,
            disabled: busy,
            onClick: toggle,
          },
          h('span', { className: 'cm-glyph', 'aria-hidden': true }, h(ChatGlyph)),
          h('span', null, t('chip.label')),
        ),
      ];
      if (error !== null) {
        row.push(
          h('span', { key: 'error', className: 'cm-error', role: 'status', title: error }, t('chip.failed')),
        );
      }
      return h('span', { className: 'cm-wrap' }, row);
    }

    /** English copy; the Chinese dictionary below mirrors this key set. */
    const en = {
      'chip.label': 'Chat',
      'chip.on.title': 'Conversation mode on — click to turn off (/conversation off)',
      'chip.off.title': 'Conversation mode off — click to turn on (/conversation)',
      'chip.failed': 'Could not switch conversation mode',
    };

    /** Simplified Chinese copy. */
    const zh = {
      'chip.label': '对话',
      'chip.on.title': '对话模式已开启 — 点击关闭（/conversation off）',
      'chip.off.title': '对话模式已关闭 — 点击开启（/conversation）',
      'chip.failed': '切换对话模式失败',
    };

    return {
      inject: ['slots', 'remote', 'remote.commands', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { en, zh }),
          'conversation-mode: dictionaries',
        );
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: PLUGIN_ID,
              order: 20,
              locale: NS,
              inject: (sessionId) => ({
                toggleConversation: async (next) => {
                  const line = next === true ? '/conversation' : '/conversation off';
                  const result = await ctx.remote.commands.execute(sessionId, line, []);
                  if (!result.ok) return `${result.error.message} (${result.error.code})`;
                  if (result.value === undefined) return `unknown command: ${line}`;
                  return null;
                },
              }),
            },
            ConversationChip,
          ),
        );
      },
    };
  },
});
