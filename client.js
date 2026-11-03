window.__ModuleLoader__.load({
  id: '@local/dsh-account-balance',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');

    const NS = 'account.balance';
    const SLOT = 'conversation.composer.dock';
    // The Desktop build reports this version to the Platform on account calls.
    const CLIENT_VERSION = '0.2.1-rc.5';
    // A balance is a remote Platform read: keep it cheap enough for a footer
    // that stays open, but fresh enough that a spent request shows up on its own.
    const POLL_INTERVAL_MS = 30000;
    const MIN_FETCH_GAP_MS = 8000;
    // After a turn's token total moves, give the Platform a few seconds to book
    // the charge, then re-read once.
    const USAGE_REFRESH_DELAY_MS = 5000;

    const EN = {
      'balance.label': 'Balance',
      'balance.unavailable': 'Balance —',
      'balance.tooltip': 'Account balance · updated {time}',
      'balance.tooltipStale': 'Account balance · last updated {time}; refresh failed',
      'balance.tooltipUnavailable': 'Account balance is temporarily unavailable',
      'balance.bonus': 'Bonus balance {amount}',
      'turn.label': 'Last turn',
      'turn.tokens': '{count} tokens',
      'turn.cost': 'Cost {amount}',
      'turn.pending': 'Turn in progress',
      'turn.tooltip': 'Token usage recorded by the host for the latest completed turn',
      'turn.unavailable': 'No completed turn usage is available',
      'turn.costUnavailable': 'Token cost cannot be estimated from the available turn records',
      'turn.estimate': 'Est. {amount}',
      'turn.estimateTooltip': 'Token cost estimate at published DeepSeek rates (off-peak–peak). Excludes tool charges; the bill is authoritative.',
    };
    const ZH = {
      'balance.label': '余额',
      'balance.unavailable': '余额 —',
      'balance.tooltip': '账户余额 · {time} 更新',
      'balance.tooltipStale': '账户余额 · 上次更新 {time}，刷新失败',
      'balance.tooltipUnavailable': '暂时无法获取账户余额',
      'balance.bonus': '赠送余额 {amount}',
      'turn.label': '本轮',
      'turn.tokens': '{count} Token',
      'turn.cost': '金额 {amount}',
      'turn.pending': '本轮进行中',
      'turn.tooltip': '宿主记录的最近已完成轮次 Token 用量',
      'turn.unavailable': '暂无已完成轮次的用量',
      'turn.costUnavailable': '无法按现有记录预估 Token 费用',
      'turn.estimate': '预估 {amount}',
      'turn.estimateTooltip': '按 DeepSeek 公布费率预估 Token 费用（闲时–高峰范围），不含工具收费，以账单为准。',
    };

    // Copied from the shipped composer stats pills (ui-chat StatsPills.module.css)
    // so this cell sits in the footer with exactly the same metrics and colors.
    const CSS = [
      '.dshSpendBalance_footer{box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:2px 8px;min-width:0;padding:2px 8px;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-tertiary)}',
      '.dshSpendBalance_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
      '.dshSpendBalance_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
      '.dshSpendBalance_pill svg{flex:none;width:14px;height:14px}',
      '.dshSpendBalance_pill[data-state="stale"]{color:var(--dsw-alias-label-tertiary);opacity:.72}',
      '.dshSpendBalance_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.dshSpendBalance_sep{color:var(--dsw-alias-separator-primary);margin:0 6px}',
    ].join('');

    const SYMBOLS = { CNY: '¥', USD: '$' };

    /**
     * Format one Host wallet string the way the Platform Web balance does:
     * two decimals, grouped digits, positive sub-cent amounts as "<0.01", and a
     * 0.01 floor for negative amounts. The Host value stays a decimal string.
     * @param wallet - one account wallet.
     * @returns the display amount including its currency symbol.
     */
    function formatWallet(wallet) {
      const symbol = SYMBOLS[wallet.currency] ?? `${wallet.currency} `;
      const raw = String(wallet.balance ?? '').trim();
      const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(raw);
      if (match === null) return `${symbol}—`;
      const negative = match[1] === '-';
      const intRaw = match[2] ?? '0';
      const fracRaw = match[3] ?? match[4] ?? '';
      const intPart = intRaw.replace(/^0+(?=\d)/, '') || '0';
      const fracPart = (fracRaw + '00').slice(0, 2);
      const zero = /^0+$/.test(intPart) && /^0*$/.test(fracRaw);
      if (zero) return `${symbol}0.00`;
      const subCent = intPart === '0'
        && fracPart === '00'
        && /[1-9]/.test(fracRaw.slice(2));
      if (!negative && subCent) return `<${symbol}0.01`;
      const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      if (negative) return `-${symbol}${subCent ? '0.01' : `${grouped}.${fracPart}`}`;
      return `${symbol}${grouped}.${fracPart}`;
    }

    function positiveBonus(bonusWallets) {
      return bonusWallets.filter((wallet) => Number(wallet.balance) > 0);
    }

    // A turn-tail exists only after turn/end. Never substitute the session-wide
    // tokenUsage projection, nor fall back to an older tail with known usage.
    function latestCompletedTurn(chat) {
      if (chat?.nodes === undefined || !Array.isArray(chat.order)) return undefined;
      for (let index = chat.order.length - 1; index >= 0; index -= 1) {
        const node = chat.nodes.get(chat.order[index]);
        if (node?.kind === 'turn-tail') return node.data;
      }
      return undefined;
    }

    function isTokenCount(value) {
      return Number.isSafeInteger(value) && value >= 0;
    }

    // Verified 2026-11-03 against the official pricing table. Aggregated routes
    // have no per-request token split or timestamps, so disclose a price range.
    // Do not price historical turns before this tariff's effective date.
    function estimateTurnCost(turn) {
      const usage = turn?.tokenUsage;
      const time = new Date(turn?.time).getTime();
      if (!Number.isFinite(time) || time < Date.UTC(2026, 8, 10, 4)
        || usage === undefined || !Array.isArray(usage.routes) || usage.routes.length !== 1
        || ![usage.uncachedInputTokens, usage.outputTokens, usage.totalTokens].every(isTokenCount)
        || [usage.cacheReadTokens, usage.cacheWriteTokens].some((count) => count !== undefined && !isTokenCount(count))) return undefined;
      const route = usage.routes[0];
      if (route.provider !== 'deepseek-account' && route.provider !== 'deepseek-official') return undefined;
      let rates;
      if (['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(route.model)) rates = [1, 0.02, 4];
      else if (route.model === 'deepseek-v4-pro') rates = [4.5, 0.15, 13.5];
      else return undefined;
      let read = usage.cacheReadTokens ?? 0;
      let write = usage.cacheWriteTokens ?? 0;
      const residual = usage.totalTokens - usage.uncachedInputTokens - usage.outputTokens - read - write;
      if (!isTokenCount(residual)) return undefined;
      let unknownCache = 0;
      if (usage.cacheReadTokens === undefined && usage.cacheWriteTokens === undefined) unknownCache = residual;
      else if (usage.cacheReadTokens === undefined) read += residual;
      else if (usage.cacheWriteTokens === undefined) write += residual;
      else if (residual !== 0) return undefined;
      const knownCost = (usage.uncachedInputTokens + write) * rates[0] + read * rates[1] + usage.outputTokens * rates[2];
      return { low: (knownCost + unknownCache * rates[1]) / 1e6,
        high: 2 * (knownCost + unknownCache * rates[0]) / 1e6 };
    }

    function formatTurnAmount(value) {
      if (value === 0) return '¥0';
      if (value < 0.000001) return '<¥0.000001';
      return `¥${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
    }

    /**
     * Account state and the last good balance, shared by the footer cell.
     * The account stream is the authority on signed-in state; polling only runs
     * while a cell is mounted.
     * @param ctx - client plugin context.
     * @param account - the account Remote namespace.
     * @returns snapshot accessors plus the balance loader.
     */
    function createStore(ctx, account) {
      let snapshot = {
        phase: account === undefined ? 'unavailable' : 'unknown',
        wallets: [],
        bonusWallets: [],
        updatedAt: 0,
        error: null,
      };
      const listeners = new Set();
      let generation = 0;
      let inFlight = null;
      let lastAttemptAt = 0;
      let retryTimer = null;
      let pendingReason = null;
      let refreshMounts = 0;

      const emit = (next) => {
        snapshot = { ...snapshot, ...next };
        for (const listener of listeners) listener();
      };
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      const active = () => snapshot.phase === 'loading'
        || snapshot.phase === 'ready'
        || snapshot.phase === 'stale'
        || snapshot.phase === 'error';
      const metadata = () => ({
        version: CLIENT_VERSION,
        locale: ctx.locale.getSnapshot().active,
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      });

      const clearRetry = () => {
        if (retryTimer !== null) window.clearTimeout(retryTimer);
        retryTimer = null;
      };
      const mounted = () => refreshMounts > 0;
      const advanceGeneration = () => {
        generation += 1;
        inFlight = null;
        lastAttemptAt = 0;
        pendingReason = null;
        clearRetry();
      };
      const visible = () => document.visibilityState === 'visible';
      const schedulePending = () => {
        if (!mounted() || !visible() || pendingReason === null || !active()
          || (inFlight !== null && inFlight.generation === generation)
          || retryTimer !== null) return;
        const delay = Math.max(0, lastAttemptAt + MIN_FETCH_GAP_MS - Date.now());
        const scheduledGeneration = generation;
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          if (scheduledGeneration !== generation || !mounted() || !visible()) return;
          const reason = pendingReason;
          pendingReason = null;
          if (reason !== null) load(reason);
        }, delay);
      };
      const queueRefresh = (reason) => {
        pendingReason = reason;
        schedulePending();
      };

      const load = (reason) => {
        if (account === undefined || !active()) return Promise.resolve();
        if (!mounted()) {
          pendingReason = reason;
          clearRetry();
          return Promise.resolve();
        }
        if (!visible()) {
          pendingReason = reason;
          clearRetry();
          return Promise.resolve();
        }
        if (inFlight !== null && inFlight.generation === generation) {
          if (reason === 'usage' || reason === 'visible' || reason === 'account') pendingReason = reason;
          return inFlight.promise;
        }
        const now = Date.now();
        if (reason !== 'manual' && now - lastAttemptAt < MIN_FETCH_GAP_MS) {
          queueRefresh(reason);
          return Promise.resolve();
        }
        pendingReason = null;
        clearRetry();
        lastAttemptAt = now;
        const requestGeneration = generation;
        const request = { generation: requestGeneration, promise: null };
        inFlight = request;
        request.promise = Promise.resolve().then(async () => {
          try {
            if (requestGeneration !== generation) return;
            const result = await account.getBalance(metadata());
            if (requestGeneration !== generation) return;
            if (!result.ok) throw new Error(result.error?.message ?? 'balance request failed');
            const value = result.value;
            if (value === null) {
              advanceGeneration();
              emit({ phase: 'signed-out', wallets: [], bonusWallets: [], updatedAt: 0, error: null });
              return;
            }
            if (value.status !== 'ready') throw new Error('balance unavailable');
            emit({
              phase: 'ready',
              wallets: value.value,
              bonusWallets: value.bonusWallets,
              updatedAt: Date.now(),
              error: null,
            });
          } catch (error) {
            if (requestGeneration !== generation) return;
            const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
              ? error.message
              : String(error);
            emit(snapshot.updatedAt > 0
              ? { phase: 'stale', error: message }
              : { phase: 'error', error: message });
          } finally {
            if (inFlight === request) {
              inFlight = null;
              if (pendingReason !== null) schedulePending();
            }
          }
        });
        return request.promise;
      };

      const activate = () => {
        refreshMounts += 1;
        if (pendingReason !== null) load(pendingReason);
      };
      const deactivate = () => {
        refreshMounts = Math.max(0, refreshMounts - 1);
        if (!mounted()) advanceGeneration();
      };
      const pause = () => clearRetry();

      const start = () => {
        if (account === undefined) return () => advanceGeneration();
        if (typeof ctx.remote.$stream !== 'function') {
          emit({ phase: 'error', error: 'remote stream unavailable' });
          return () => advanceGeneration();
        }
        const stream = ctx.remote.$stream({
          name: 'account',
          open: (signal) => account.watch(signal),
          ended: () => new Error('account stream ended'),
        });
        let disposed = false;
        (async () => {
          for await (const frame of stream) {
            if (disposed) break;
            const view = frame.value;
            if (view?.status === 'credential-stored') {
              advanceGeneration();
              emit({ phase: 'loading', wallets: [], bonusWallets: [], updatedAt: 0, error: null });
              frame.accept?.();
              load('account');
            } else {
              advanceGeneration();
              emit({ phase: 'signed-out', wallets: [], bonusWallets: [], updatedAt: 0, error: null });
              frame.accept?.();
            }
          }
        })().catch(() => {
          if (disposed) return;
          emit(snapshot.updatedAt > 0
            ? { phase: 'stale', error: 'account stream ended' }
            : { phase: 'error', error: 'account stream ended' });
        });
        return () => {
          disposed = true;
          advanceGeneration();
          stream.dispose?.();
        };
      };

      return { get: () => snapshot, subscribe, start, load, activate, deactivate, pause };
    }

    function useSnapshot(store) {
      return React.useSyncExternalStore(store.subscribe, store.get, store.get);
    }

    function WalletIcon() {
      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      React.createElement('path', { d: 'M4 7.5A2.5 2.5 0 0 1 6.5 5h9A2.5 2.5 0 0 1 18 7.5' }),
      React.createElement('path', { d: 'M4 7.5V17a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1' }),
      React.createElement('path', { d: 'M20 9.5h-3.2a2.75 2.75 0 0 0 0 5.5H20z' }),
      React.createElement('path', { d: 'M16.9 12.25h.01' }));
    }

    /**
     * One footer statistic: the signed-in account balance. The pill mirrors the
     * shipped stats cells; when the account is signed out or the read fails it
     * either disappears (signed out) or shows a muted placeholder.
     * @param props - slot props plus the shared store.
     */
    function BalancePill({ t, balance, useProjection, useChat, fallback = false }) {
      const snapshot = useSnapshot(balance);
      const chat = typeof useChat === 'function' ? useChat((state) => state) : undefined;
      const turn = latestCompletedTurn(chat);
      const turnUsage = turn?.tokenUsage;
      const turnTotal = isTokenCount(turnUsage?.totalTokens) ? turnUsage.totalTokens : null;
      const turnEstimate = estimateTurnCost(turn);
      const usage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined;
      const usageTotal = usage === undefined
        ? null
        : [usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens]
          .reduce((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
      const hasUsageSample = React.useRef(false);
      const previousUsageTotal = React.useRef(null);

      React.useEffect(() => {
        balance.activate();
        const timer = window.setInterval(() => {
          if (document.visibilityState === 'visible') balance.load('poll');
        }, POLL_INTERVAL_MS);
        const onVisibilityChange = () => {
          if (document.visibilityState === 'visible') balance.load('visible');
          else balance.pause();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        balance.load('mount');
        return () => {
          window.clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisibilityChange);
          balance.deactivate();
        };
      }, [balance]);

      React.useEffect(() => {
        if (usageTotal === null) return undefined;
        if (!hasUsageSample.current) {
          hasUsageSample.current = true;
          previousUsageTotal.current = usageTotal;
          return undefined;
        }
        if (previousUsageTotal.current === usageTotal) return undefined;
        previousUsageTotal.current = usageTotal;
        const timer = window.setTimeout(() => balance.load('usage'), USAGE_REFRESH_DELAY_MS);
        return () => window.clearTimeout(timer);
      }, [balance, usageTotal]);

      const locale = window.navigator.language || 'en';
      const wallets = snapshot.wallets;
      const stale = snapshot.phase === 'stale' || snapshot.phase === 'error';
      const amountParts = [];
      wallets.forEach((wallet, index) => {
        if (index > 0) amountParts.push(React.createElement('span', {
          key: `sep-${index}`,
          className: 'dshSpendBalance_sep',
          'aria-hidden': true,
        }, '·'));
        amountParts.push(React.createElement('span', { key: `wallet-${index}` }, formatWallet(wallet)));
      });

      const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(snapshot.updatedAt || Date.now()));
      let tooltip = snapshot.updatedAt > 0
        ? t(stale ? 'balance.tooltipStale' : 'balance.tooltip', { time })
        : t('balance.tooltipUnavailable');
      const bonus = positiveBonus(snapshot.bonusWallets);
      if (bonus.length > 0) tooltip += `\n${t('balance.bonus', { amount: bonus.map(formatWallet).join(' · ') })}`;

      const unavailable = wallets.length === 0;
      const label = unavailable
        ? t('balance.unavailable')
        : [t('balance.label'), ' ', ...amountParts];
      const accessibleLabel = unavailable
        ? t('balance.unavailable')
        : `${t('balance.label')} ${wallets.map(formatWallet).join(' · ')}`;

      const balancePill = React.createElement('span', {
        className: 'dshSpendBalance_anchor',
        'data-composer-stat': 'balance',
        title: tooltip,
        'aria-label': accessibleLabel,
      }, React.createElement('span', {
        className: 'dshSpendBalance_pill',
        'data-state': stale ? 'stale' : 'fresh',
      }, React.createElement(WalletIcon), React.createElement('span', {
        className: 'dshSpendBalance_label',
      }, label)));

      const tokenText = t('turn.tokens', { count: turnTotal === null ? '—' : new Intl.NumberFormat(locale).format(turnTotal) });
      const costText = turnEstimate === undefined
        ? t('turn.cost', { amount: '—' })
        : t('turn.estimate', { amount: turnEstimate.low === turnEstimate.high
          ? formatTurnAmount(turnEstimate.low)
          : `${formatTurnAmount(turnEstimate.low)}–${formatTurnAmount(turnEstimate.high)}` });
      const turnTooltip = [turn === undefined || turnTotal === null ? t('turn.unavailable') : t('turn.tooltip'),
        turnEstimate === undefined ? t('turn.costUnavailable') : t('turn.estimateTooltip')].join('\n');
      const turnLabel = `${t('turn.label')} ${tokenText} · ${costText}`;
      return React.createElement('div', {
        className: 'dshSpendBalance_footer',
        'data-dsh-spend-footer': true,
        'data-dsh-spend-fallback': fallback ? true : undefined,
      }, balancePill, React.createElement('span', {
        className: 'dshSpendBalance_anchor',
        'data-composer-stat': 'turn',
        title: turnTooltip,
        'aria-label': turnLabel,
      }, React.createElement('span', { className: 'dshSpendBalance_pill' }, turnLabel)));
    }

    // The hero InputBar does not render composer.dock. Mount only our own
    // container at the same InputBar's end; never replace host controls.
    function createFallbackTarget() {
      let target = null;
      const listeners = new Set();
      const emit = () => { for (const listener of listeners) listener(); };
      const clear = () => {
        if (target === null) return;
        target.remove();
        target = null;
        emit();
      };
      return {
        get: () => target,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        start() {
          const update = () => {
            const root = [...document.querySelectorAll('[data-composer-card]')]
              .filter((card) => card.getClientRects().length > 0)
              .map((card) => card.parentElement)
              .find((parent) => parent !== null && !parent.querySelector('[data-dsh-spend-footer]:not([data-dsh-spend-fallback])'));
            if (root === undefined) { clear(); return; }
            if (target?.parentElement === root) return;
            clear();
            target = document.createElement('div');
            target.dataset.dshSpendPortal = 'true';
            root.appendChild(target);
            emit();
          };
          const observer = new MutationObserver(update);
          observer.observe(document.body, { childList: true, subtree: true });
          update();
          return () => { observer.disconnect(); clear(); };
        },
      };
    }

    function FallbackFooter({ t, balance, fallbackTarget }) {
      const target = useSnapshot(fallbackTarget);
      return target === null ? null : ReactDOM.createPortal(React.createElement(BalancePill, {
        t, balance, fallback: true,
      }), target);
    }

    /**
     * Register the footer cell and its account subscription.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'account-balance: dictionaries');
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@local/dsh-account-balance';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => tag.remove();
      }, 'account-balance: styles');

      const account = ctx.remote === undefined ? undefined : ctx.remote.account;
      const store = createStore(ctx, account);
      ctx.effect(() => store.start(), 'account-balance: account stream');
      const fallbackTarget = createFallbackTarget();
      ctx.effect(() => fallbackTarget.start(), 'account-balance: hero footer target');

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: 'balance',
        order: 2,
        locale: NS,
        inject: () => ({ balance: store }),
      }, BalancePill));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'account-balance-hero',
        locale: NS,
        inject: () => ({ balance: store, fallbackTarget }),
      }, FallbackFooter));
    }

    return { inject: ['slots', 'locale', 'remote', 'remote.account'], apply };
  },
});

