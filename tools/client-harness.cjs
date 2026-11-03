// Deterministic regression harness for the browser half of the account balance
// plugin. It stubs the DSH module loader, React hooks, Remote account stream,
// document visibility, and browser timers without reading account credentials.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const code = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8')

async function flushPromises(turns = 20) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

class FakeClock {
  constructor() {
    this.now = 1_800_000_000_000
    this.nextId = 1
    this.timers = new Map()
  }

  add(callback, delay, interval) {
    const id = this.nextId++
    this.timers.set(id, {
      id,
      callback,
      at: this.now + Math.max(0, Number(delay) || 0),
      interval,
    })
    return id
  }

  setTimeout(callback, delay) { return this.add(callback, delay, null) }
  setInterval(callback, delay) { return this.add(callback, delay, Math.max(1, Number(delay) || 1)) }
  clear(id) { this.timers.delete(id) }

  async advance(milliseconds) {
    const end = this.now + milliseconds
    let steps = 0
    while (true) {
      const next = [...this.timers.values()]
        .filter((timer) => timer.at <= end)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0]
      if (next === undefined) break
      if (++steps > 1000) throw new Error('fake timer runaway')
      this.now = next.at
      if (next.interval === null) this.timers.delete(next.id)
      else next.at += next.interval
      next.callback()
      await flushPromises()
    }
    this.now = end
    await flushPromises()
  }

  get pendingCount() { return this.timers.size }
}

function makeQueue() {
  const values = []
  const waiters = []
  let closed = false
  return {
    push(value) {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false })
      else values.push(value)
    },
    close() {
      if (closed) return
      closed = true
      while (waiters.length > 0) waiters.shift()({ value: undefined, done: true })
    },
    next() {
      if (values.length > 0) return Promise.resolve({ value: values.shift(), done: false })
      if (closed) return Promise.resolve({ value: undefined, done: true })
      return new Promise((resolve) => waiters.push(resolve))
    },
    [Symbol.asyncIterator]() { return this },
  }
}

function createReactStub() {
  let renderer = null
  let cursor = 0
  const pendingEffects = []
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const index = cursor++
      let slot = renderer.hooks[index]
      if (slot === undefined) {
        slot = { kind: 'external', notifications: 0 }
        slot.unsubscribe = subscribe(() => { slot.notifications += 1 })
        renderer.hooks[index] = slot
      }
      return getSnapshot()
    },
    useRef(initialValue) {
      const index = cursor++
      let slot = renderer.hooks[index]
      if (slot === undefined) {
        slot = { kind: 'ref', value: { current: initialValue } }
        renderer.hooks[index] = slot
      }
      return slot.value
    },
    useEffect(effect, dependencies) {
      const index = cursor++
      let slot = renderer.hooks[index]
      if (slot === undefined) {
        slot = { kind: 'effect', dependencies: undefined, cleanup: undefined }
        renderer.hooks[index] = slot
      }
      const changed = dependencies === undefined
        || slot.dependencies === undefined
        || dependencies.length !== slot.dependencies.length
        || dependencies.some((value, dependencyIndex) => !Object.is(value, slot.dependencies[dependencyIndex]))
      if (changed) {
        slot.dependencies = dependencies
        pendingEffects.push({ slot, effect })
      }
    },
  }

  function createRenderer(component, props) {
    const instance = {
      hooks: [],
      render(nextProps = props) {
        props = nextProps
        cursor = 0
        pendingEffects.length = 0
        renderer = instance
        let output
        try {
          output = component(props)
        } finally {
          renderer = null
        }
        for (const pending of pendingEffects) {
          pending.slot.cleanup?.()
          const cleanup = pending.effect()
          pending.slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        }
        return output
      },
      unmount() {
        for (const slot of [...instance.hooks].reverse()) {
          if (slot.kind === 'effect') slot.cleanup?.()
          else if (slot.kind === 'external') slot.unsubscribe?.()
        }
        instance.hooks = []
      },
      get subscriptions() {
        return instance.hooks.filter((slot) => slot.kind === 'external' && slot.unsubscribe !== undefined).length
      },
      get storeNotifications() {
        return instance.hooks
          .filter((slot) => slot.kind === 'external')
          .reduce((total, slot) => total + slot.notifications, 0)
      },
    }
    return instance
  }

  return { React, createRenderer }
}

function makeTranslator(registeredStrings = {}) {
  const strings = {
    'balance.label': 'Balance',
    'balance.unavailable': 'Balance —',
    'balance.tooltip': 'Account balance · updated {time}',
    'balance.tooltipStale': 'Account balance · last updated {time}; refresh failed',
    'balance.tooltipUnavailable': 'Account balance is temporarily unavailable',
    'balance.bonus': 'Bonus balance {amount}',
    ...registeredStrings,
  }
  return (key, values = {}) => (strings[key] ?? key).replace(/\{([^}]+)\}/g, (_match, name) => values[name] ?? '')
}

function createHost({ getBalance = async () => ({
  ok: true,
  value: { status: 'ready', value: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [] },
}) } = {}) {
  const clock = new FakeClock()
  const listeners = new Map()
  const styleTags = []
  const events = makeQueue()
  const balanceCalls = []
  const effects = []
  const registrations = []
  const observers = new Set()
  let composerCards = []
  let acceptedFrames = 0
  let currentUsage
  let currentChat = { nodes: new Map(), order: [] }
  let currentSessionId = 'session-a'
  let registeredStrings = {}

  const document = {
    visibilityState: 'visible',
    body: {},
    head: { appendChild(tag) { styleTags.push(tag) } },
    createElement() { return { dataset: {}, textContent: '', parentElement: null, remove() { this.removed = true; this.parentElement?.removeChild(this); this.parentElement = null } } },
    querySelectorAll(selector) {
      assert.equal(selector, '[data-composer-card]')
      return composerCards
    },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener) },
    dispatch(name) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener({ type: name })
    },
  }
  const window = {
    navigator: { language: 'en-US' },
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clear.bind(clock),
    setInterval: clock.setInterval.bind(clock),
    clearInterval: clock.clear.bind(clock),
  }
  let registration
  window.__ModuleLoader__ = { load(entry) { registration = entry } }
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length === 0 ? [clock.now] : args)) }
    static now() { return clock.now }
  }

  const reactHarness = createReactStub()
  const requireStub = (name) => {
    if (name === 'react') return reactHarness.React
    if (name === 'react-dom') return { createPortal: (child, target) => ({ type: 'portal', props: { target }, children: [child] }) }
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback }
    observe() { observers.add(this) }
    disconnect() { observers.delete(this) }
  }
  vm.runInNewContext(code, { window, document, Date: ClockDate, MutationObserver }, { filename: 'plugins/account-balance/client.js' })
  assert.ok(registration, 'client bundle registers with the DSH module loader')
  const plugin = registration.factory(requireStub)
  assert.equal(Array.from(plugin.inject).join(','), 'slots,locale,remote,remote.account', 'nested remote service is declared for Cordis injection')
  const account = {
    getBalance(metadata) {
      balanceCalls.push(metadata)
      return getBalance(metadata, balanceCalls.length)
    },
    async *watch(signal) {
      const closeOnAbort = () => events.close()
      signal.addEventListener('abort', closeOnAbort, { once: true })
      try {
        for await (const frame of events) yield frame
      } finally {
        signal.removeEventListener('abort', closeOnAbort)
      }
    },
  }
  const ctx = {
    locale: {
      register(_namespace, dictionaries) { registeredStrings = dictionaries.en; return () => {} },
      getSnapshot() { return { active: 'en-US' } },
    },
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return cleanup
    },
    remote: {
      account,
      $stream({ open }) {
        const controller = new AbortController()
        const source = open(controller.signal)
        return {
          dispose() { controller.abort() },
          async *[Symbol.asyncIterator]() { yield* source },
        }
      },
    },
    slots: {
      inject(_key, callback) { return callback() },
      register(options, component) {
        const entry = { options, component }
        registrations.push(entry)
        return () => { const index = registrations.indexOf(entry); if (index >= 0) registrations.splice(index, 1) }
      },
    },
  }
  plugin.apply(ctx)
  const registered = registrations.find((entry) => entry.options.name === 'conversation.composer.dock')
  assert.ok(registered, 'balance component is registered in the existing composer slot')
  const store = registered.options.inject().balance
  const t = makeTranslator(registeredStrings)
  const renderer = reactHarness.createRenderer(registered.component, {
    balance: store,
    t,
    useProjection: () => currentUsage,
    useChat: (selector) => selector(currentChat),
    sessionId: currentSessionId,
  })
  const fallback = registrations.find((entry) => entry.options.name === 'shell.overlay')
  const fallbackRenderer = fallback === undefined ? undefined : reactHarness.createRenderer(fallback.component, { ...fallback.options.inject(), t })

  return {
    clock,
    store,
    renderer,
    balanceCalls,
    styleTags,
    registrations,
    acceptedFrames: () => acceptedFrames,
    async pushAccountState(status) {
      events.push({
        value: { status, links: { usageUrl: '', topUpUrl: '' } },
        accept() { acceptedFrames += 1 },
      })
      await flushPromises()
    },
    render() {
      return renderer.render({ balance: store, t, useProjection: () => currentUsage, useChat: (selector) => selector(currentChat), sessionId: currentSessionId })
    },
    setUsage(value) { currentUsage = value },
    setChat(value) { currentChat = value },
    renderFallback() { return fallbackRenderer?.render() },
    setComposerCards(cards) {
      composerCards = cards
      for (const observer of observers) observer.callback([])
    },
    observerCount() { return observers.size },
    setSession(sessionId, nodes = []) {
      currentSessionId = sessionId
      currentChat = { nodes: new Map(nodes.map((node) => [node.key, node])), order: nodes.map((node) => node.key) }
    },
    setVisibility(value) {
      document.visibilityState = value
      document.dispatch('visibilitychange')
    },
    listenerCount(name) { return listeners.get(name)?.size ?? 0 },
    async settle() { await flushPromises() },
    async dispose() {
      renderer.unmount()
      fallbackRenderer?.unmount()
      for (const cleanup of effects.reverse()) cleanup()
      await flushPromises()
    },
  }
}

function flattenText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node === 'object' && 'children' in node) return flattenText(node.children)
  return ''
}

function findStat(node, name) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map((child) => findStat(child, name)).find(Boolean)
  if (node.props?.['data-composer-stat'] === name) return node
  return findStat(node.children, name)
}

// The rc.5 host emits this node only after turn/end. Session tokenUsage is a
// different, cumulative projection and must never substitute for this value.
function turnTail(turn, tokenUsage, seq = turn * 10) {
  return {
    key: `turn-${turn}-tail`,
    kind: 'turn-tail',
    data: { turn, seq, ...(tokenUsage === undefined ? {} : { tokenUsage }) },
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function test(name, callback) {
  await callback()
  console.log(`ok - ${name}`)
}

async function main() {
  await test('formats full balances, sub-cent values, negatives, and negative zero in the rendered pill', async () => {
    const host = createHost({
      getBalance: async () => ({
        ok: true,
        value: {
          status: 'ready',
          value: [
            { currency: 'CNY', balance: '12345.678' },
            { currency: 'USD', balance: '0.009' },
            { currency: 'CNY', balance: '-0' },
            { currency: 'USD', balance: '-0.001' },
            { currency: 'CNY', balance: '-12.345' },
            { currency: 'USD', balance: '0.01' },
          ],
          bonusWallets: [],
        },
      }),
    })
    host.render()
    await host.pushAccountState('credential-stored')
    assert.equal(host.store.get().phase, 'ready')
    assert.ok(host.renderer.storeNotifications >= 2, 'external store updates notify the React subscriber')
    const tree = findStat(host.render(), 'balance')
    const expected = 'Balance ¥12,345.67 · <$0.01 · ¥0.00 · -$0.01 · -¥12.34 · $0.01'
    assert.equal(tree.props['aria-label'], expected)
    assert.ok(flattenText(tree).includes('¥12,345.67'))
    assert.ok(flattenText(tree).includes('<$0.01'))
    await host.dispose()
  })

  await test('a new account generation fetches immediately and ignores an older account response', async () => {
    const first = deferred()
    const second = deferred()
    const host = createHost({ getBalance: (_metadata, count) => count === 1 ? first.promise : second.promise })
    host.render()
    await host.pushAccountState('credential-stored')
    assert.equal(host.balanceCalls.length, 1)
    await host.pushAccountState('credential-stored')
    assert.equal(host.balanceCalls.length, 2, 'new account read is not held by the old in-flight request')
    second.resolve({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '22.00' }], bonusWallets: [] } })
    await host.settle()
    assert.equal(host.store.get().wallets[0].balance, '22.00')
    first.resolve({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '11.00' }], bonusWallets: [] } })
    await host.settle()
    assert.equal(host.store.get().wallets[0].balance, '22.00')
    await host.dispose()
  })

  await test('account events wait for a mounted footer before reading balance', async () => {
    const host = createHost()
    await host.pushAccountState('credential-stored')
    assert.equal(host.balanceCalls.length, 0)
    host.render()
    await host.settle()
    assert.equal(host.balanceCalls.length, 1, 'mount consumes the pending account refresh')
    assert.equal(host.store.get().phase, 'ready')
    await host.dispose()
  })

  await test('queued account frames are ignored after stream cleanup', async () => {
    const host = createHost()
    host.pushAccountState('credential-stored')
    await host.dispose()
    assert.equal(host.balanceCalls.length, 0)
    assert.equal(host.store.get().phase, 'unknown')
  })

  await test('sign-out invalidates an older in-flight balance response', async () => {
    const pending = deferred()
    const host = createHost({ getBalance: () => pending.promise })
    host.render()
    await host.pushAccountState('credential-stored')
    assert.equal(host.balanceCalls.length, 1)
    await host.pushAccountState('signed-out')
    assert.equal(host.store.get().phase, 'signed-out')
    pending.resolve({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '99.00' }], bonusWallets: [] } })
    await host.settle()
    assert.equal(host.store.get().phase, 'signed-out')
    assert.equal(host.store.get().wallets.length, 0)
    await host.dispose()
  })

  await test('first failure, recovery, and stale-balance failure render the expected states', async () => {
    const host = createHost({
      getBalance: async (_metadata, count) => {
        if (count === 1 || count === 3) return { ok: false, error: { message: 'offline' } }
        return { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '4.56' }], bonusWallets: [] } }
      },
    })
    host.render()
    await host.pushAccountState('credential-stored')
    assert.equal(host.store.get().phase, 'error')
    assert.equal(host.store.get().error, 'offline')
    let tree = findStat(host.render(), 'balance')
    assert.equal(tree.props['aria-label'], 'Balance —')
    assert.equal(tree.children[0].props['data-state'], 'stale')

    await host.store.load('manual')
    assert.equal(host.store.get().phase, 'ready')
    tree = findStat(host.render(), 'balance')
    assert.ok(tree.props['aria-label'].includes('¥4.56'))

    await host.store.load('manual')
    assert.equal(host.store.get().phase, 'stale')
    assert.equal(host.store.get().error, 'offline')
    tree = findStat(host.render(), 'balance')
    assert.ok(tree.props.title.includes('refresh failed'))
    assert.ok(tree.props['aria-label'].includes('¥4.56'))
    await host.dispose()
  })

  await test('a synchronous getBalance throw clears in-flight state and allows recovery', async () => {
    const host = createHost({
      getBalance: (_metadata, count) => {
        if (count === 1) throw new Error('sync offline')
        return { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '8.88' }], bonusWallets: [] } }
      },
    })
    host.render()
    await host.pushAccountState('credential-stored')
    assert.equal(host.store.get().phase, 'error')
    assert.equal(host.store.get().error, 'sync offline')
    await host.store.load('manual')
    assert.equal(host.balanceCalls.length, 2)
    assert.equal(host.store.get().phase, 'ready')
    assert.equal(host.store.get().wallets[0].balance, '8.88')
    await host.dispose()
  })

  await test('cooldown queues refresh, usage waits five seconds, hidden work resumes when visible, and unmount clears timers', async () => {
    const host = createHost()
    const tree = host.render()
    assert.equal(findStat(tree, 'balance').props['aria-label'], 'Balance —')
    assert.equal(host.clock.pendingCount, 1, 'mounted component owns one polling interval')
    await host.pushAccountState('credential-stored')
    assert.equal(host.balanceCalls.length, 1)

    host.setUsage({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
    host.render()
    host.setUsage({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 9 })
    host.render()
    await host.clock.advance(4999)
    assert.equal(host.balanceCalls.length, 1)
    await host.clock.advance(1)
    assert.equal(host.balanceCalls.length, 1, 'usage delay is respected and cooldown does not start early')
    await host.clock.advance(2999)
    assert.equal(host.balanceCalls.length, 1)
    await host.clock.advance(1)
    assert.equal(host.balanceCalls.length, 2, 'cooldown schedules the deferred usage refresh')

    host.store.load('usage')
    await host.clock.advance(4000)
    host.setVisibility('hidden')
    await host.clock.advance(10000)
    assert.equal(host.balanceCalls.length, 2, 'hidden page does not perform the queued refresh')
    host.setVisibility('visible')
    await host.settle()
    assert.equal(host.balanceCalls.length, 3, 'returning to visible refreshes immediately when the gap has elapsed')

    host.setVisibility('hidden')
    await host.pushAccountState('credential-stored')
    assert.equal(host.balanceCalls.length, 3, 'account change while hidden is deferred')
    host.setVisibility('visible')
    await host.settle()
    assert.equal(host.balanceCalls.length, 4, 'account change is refreshed on visibility restoration')

    host.store.load('usage')
    host.setUsage({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 })
    host.render()
    assert.ok(host.clock.pendingCount >= 3, 'poll, cooldown retry, and usage timeout are active before unmount')
    assert.equal(host.renderer.subscriptions, 1)
    host.renderer.unmount()
    assert.equal(host.renderer.subscriptions, 0)
    assert.equal(host.listenerCount('visibilitychange'), 0)
    assert.equal(host.clock.pendingCount, 0, 'all component and queued refresh timers are cleared')
    await host.dispose()
  })

  await test('unmount invalidates an outstanding response', async () => {
    const pending = deferred()
    const host = createHost({ getBalance: () => pending.promise })
    host.render()
    await host.pushAccountState('credential-stored')
    assert.equal(host.store.get().phase, 'loading')
    host.renderer.unmount()
    pending.resolve({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '77.00' }], bonusWallets: [] } })
    await host.settle()
    assert.equal(host.store.get().phase, 'loading')
    assert.equal(host.store.get().wallets.length, 0)
    assert.equal(host.clock.pendingCount, 0)
    await host.dispose()
  })

  await test('footer stays visible and cumulative generation usage never becomes a completed turn', async () => {
    const host = createHost()
    assert.equal(findStat(host.render(), 'balance').props['aria-label'], 'Balance —')
    host.setUsage({ uncachedInputTokens: 999900, outputTokens: 99, totalTokens: 999999 })
    let turn = findStat(host.render(), 'turn')
    assert.ok(turn, 'the latest-turn cell remains mounted before the first completed turn')
    assert.ok(flattenText(turn).includes('—'))
    assert.ok(!flattenText(turn).includes('999,999'))
    assert.equal(host.balanceCalls.length, 0)

    host.setSession('session-a', [turnTail(1, {
      uncachedInputTokens: 120, cacheReadTokens: 50, cacheWriteTokens: 30,
      outputTokens: 70, totalTokens: 270, reasoningTokens: 40,
      routes: [{ provider: 'unpriced-provider', model: 'unknown-model' }],
    })])
    turn = findStat(host.render(), 'turn')
    assert.ok(flattenText(turn).includes('270 tokens'), 'host totalTokens already includes reasoning')
    assert.ok(!flattenText(turn).includes('310 tokens'))
    host.setUsage({ uncachedInputTokens: 999900, outputTokens: 150, totalTokens: 1000050 })
    turn = findStat(host.render(), 'turn')
    assert.ok(flattenText(turn).includes('270 tokens'), 'an unfinished next turn retains the latest completed turn')
    assert.ok(!flattenText(turn).includes('1,000,050'))
    await host.dispose()
  })

  await test('latest completed turn replaces its predecessor and session changes rebuild from that session history', async () => {
    const host = createHost()
    const first = turnTail(1, { uncachedInputTokens: 20, outputTokens: 10, totalTokens: 30 })
    const second = turnTail(2, { uncachedInputTokens: 100, outputTokens: 200, totalTokens: 300 })
    host.setSession('session-a', [first, second])
    assert.ok(flattenText(findStat(host.render(), 'turn')).includes('300 tokens'))
    host.setSession('session-b')
    let turn = findStat(host.render(), 'turn')
    assert.ok(flattenText(turn).includes('—'))
    assert.ok(!flattenText(turn).includes('300 tokens'), 'the previous session does not leak into a fresh one')
    host.setSession('session-b', [turnTail(1, undefined)])
    turn = findStat(host.render(), 'turn')
    assert.ok(flattenText(turn).includes('—'), 'a completed tail without exact usage remains unknown')
    assert.ok(!flattenText(turn).includes('0 tokens'))
    host.setSession('session-a', [first, second])
    assert.ok(flattenText(findStat(host.render(), 'turn')).includes('300 tokens'), 'revisiting history restores its last completed usage')
    host.setSession('session-a', [first, second, turnTail(3, undefined)])
    turn = findStat(host.render(), 'turn')
    assert.ok(!flattenText(turn).includes('300 tokens'), 'an unmeasurable newest turn cannot reuse an older turn total')
    await host.dispose()
  })

  await test('exact zero usage is shown as zero tokens while missing pricing stays unknown', async () => {
    const host = createHost()
    host.setSession('session-a', [turnTail(1, {
      uncachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
      routes: [{ provider: 'unpriced-provider', model: 'unknown-model' }],
    })])
    const turn = findStat(host.render(), 'turn')
    assert.ok(flattenText(turn).includes('0 tokens'))
    assert.ok(flattenText(turn).includes('—'), 'unpriced usage does not invent a zero monetary charge')
    await host.dispose()
  })

  await test('known DeepSeek routes show a CNY estimate range with sufficient precision for small charges', async () => {
    const host = createHost({ getBalance: async () => ({ ok: true, value: {
      status: 'ready', value: [{ currency: 'USD', balance: '2.00' }], bonusWallets: [],
    } }) })
    host.render()
    await host.pushAccountState('credential-stored')
    const pricedTail = (turn, usage) => {
      const node = turnTail(turn, usage)
      node.data.time = '2026-11-03T02:00:00.000Z'
      return node
    }
    const route = { provider: 'deepseek-account', model: 'deepseek-flash' }
    host.setSession('session-a', [pricedTail(1, {
      uncachedInputTokens: 1000000, cacheWriteTokens: 1000000, cacheReadTokens: 1000000,
      outputTokens: 1000000, totalTokens: 4000000, routes: [route],
    })])
    let tree = host.render()
    assert.equal(findStat(tree, 'balance').props['aria-label'], 'Balance $2.00')
    let turn = findStat(tree, 'turn')
    // Published off-peak CNY / million: input 1, cache hit .02, output 4;
    // peak is double. Cache writes are input, reasoning is already in output.
    assert.ok(flattenText(turn).includes('Est. ¥6.02–¥12.04'))
    assert.ok(turn.props.title.includes('Excludes tool charges'))

    const optionalCacheCases = [
      [{ totalTokens: 2000000 }, 'Est. ¥5–¥10'],
      [{ totalTokens: 3000000 }, 'Est. ¥5.02–¥12'],
      [{ cacheWriteTokens: 0, totalTokens: 3000000 }, 'Est. ¥5.02–¥10.04'],
      [{ cacheReadTokens: 0, totalTokens: 3000000 }, 'Est. ¥6–¥12'],
    ]
    for (const [index, [cacheCounts, expected]] of optionalCacheCases.entries()) {
      host.setSession('session-a', [pricedTail(10 + index, {
        uncachedInputTokens: 1000000, outputTokens: 1000000, ...cacheCounts, routes: [route],
      })])
      assert.ok(flattenText(findStat(host.render(), 'turn')).includes(expected), `optional cache case ${index + 1} preserves a conservative range`)
    }
    host.setSession('session-a', [pricedTail(20, {
      uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0,
      outputTokens: 1000000, totalTokens: 2000000,
      routes: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }],
    })])
    assert.ok(flattenText(findStat(host.render(), 'turn')).includes('Est. ¥18–¥36'))

    host.setSession('session-a', [pricedTail(2, {
      uncachedInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 1,
      outputTokens: 0, totalTokens: 1, routes: [route],
    })])
    turn = findStat(host.render(), 'turn')
    assert.ok(flattenText(turn).includes('<¥0.000001'), 'a nonzero sub-microyuan estimate is not rounded to zero')
    host.setSession('session-a', [pricedTail(3, {
      uncachedInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
      outputTokens: 0, totalTokens: 0, routes: [{ provider: 'deepseek-account', model: 'deepseek-v4-pro' }],
    })])
    assert.ok(flattenText(findStat(host.render(), 'turn')).includes('Est. ¥0'))
    await host.dispose()
  })

  await test('historical tariffs, unknown models, and mixed routes do not invent a monetary amount', async () => {
    const host = createHost()
    const baseUsage = { uncachedInputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 100, totalTokens: 200 }
    const cases = [
      { time: '2026-09-01T02:00:00.000Z', routes: [{ provider: 'deepseek-account', model: 'deepseek-v4-flash' }] },
      { time: '2026-11-03T02:00:00.000Z', routes: [{ provider: 'deepseek-account', model: 'unknown-model' }] },
      { time: '2026-11-03T02:00:00.000Z', routes: [{ provider: 'deepseek-account', model: 'deepseek-pro' }] },
      { time: '2026-11-03T02:00:00.000Z', routes: [{ provider: 'custom', model: 'deepseek-v4-flash' }] },
      { time: '2026-11-03T02:00:00.000Z', routes: [{ provider: 'deepseek-account', model: 'deepseek-v4-flash' }, { provider: 'deepseek-account', model: 'deepseek-v4-pro' }] },
      { time: '2026-11-03T02:00:00.000Z', routes: [] },
    ]
    for (const [index, sample] of cases.entries()) {
      const node = turnTail(index + 1, { ...baseUsage, routes: sample.routes })
      node.data.time = sample.time
      host.setSession('session-a', [node])
      const text = flattenText(findStat(host.render(), 'turn'))
      assert.ok(text.includes('200 tokens'))
      assert.ok(text.includes('Cost —'), `unsupported cost case ${index + 1} remains explicitly unknown`)
      assert.ok(!text.includes('Est.'))
    }
    const inconsistent = turnTail(20, { ...baseUsage, totalTokens: 199, routes: [{ provider: 'deepseek-account', model: 'deepseek-flash' }] })
    inconsistent.data.time = '2026-11-03T02:00:00.000Z'
    host.setSession('session-a', [inconsistent])
    assert.ok(flattenText(findStat(host.render(), 'turn')).includes('Cost —'), 'contradictory token counts cannot produce an estimate')
    await host.dispose()
  })

  await test('hero fallback mounts its own portal, yields to a standard footer, and cleans up', async () => {
    const host = createHost()
    assert.deepEqual(host.registrations.map((entry) => entry.options.name).sort(), ['conversation.composer.dock', 'shell.overlay'])
    assert.equal(host.observerCount(), 1)
    assert.equal(host.renderFallback(), null)
    const hostControl = { role: 'host-input-controls' }
    const root = {
      children: [hostControl], standardFooter: false,
      querySelector() { return this.standardFooter ? {} : null },
      appendChild(child) { child.parentElement = this; this.children.push(child) },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1) },
    }
    const card = { parentElement: root, getClientRects: () => [{}] }
    host.setComposerCards([card])
    let portal = host.renderFallback()
    assert.equal(portal.type, 'portal')
    assert.equal(portal.props.target.parentElement, root)
    assert.equal(portal.children[0].props.fallback, true)
    assert.equal(root.children.length, 2)
    host.setComposerCards([card])
    assert.equal(root.children.length, 2, 'observer changes do not duplicate the fallback')
    root.standardFooter = true
    host.setComposerCards([card])
    assert.equal(host.renderFallback(), null)
    assert.deepEqual(root.children, [hostControl], 'the plugin removes only its own portal container')
    root.standardFooter = false
    host.setComposerCards([card])
    portal = host.renderFallback()
    assert.equal(portal.type, 'portal')
    await host.dispose()
    assert.equal(host.observerCount(), 0)
    assert.deepEqual(root.children, [hostControl])
  })

  console.log('15 client regression tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
