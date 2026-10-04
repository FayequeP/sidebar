/* @jsx h */
import { describe, expect, mock, test, tier } from 'claude-code/testing'
import { formatShare, sessionShare, trackLimitUse, formatUsd, failedTitle, applyTaskCreate, applyTaskUpdate, applyTodoWrite, resolveTtl, speed, formatElapsed, spinnerFrame, trackStarts, visibleTasks } from './register'

tier('user')

const USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'test-model',
}

const PANE_PROPS = {
  title: 'Claude Code Sidebar',
  isFocused: false,
  bodyColumns: 38,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

describe('register', () => {
  test('the meter pane shows context, tokens, cache and activity', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on, {})

    on('session.usage', async () => ({
      value: {
        context: { tokens: 85400, window: 272000, percent: 31 },
        rateLimits: [],
        cost: { usd: 3.456 },
      },
    }))
    on('env.get', async () => ({ value: undefined }))
    on('session.cwd', async () => ({ value: 'D:\\Buisness\\Claude-tps-mod\\tps-meter' }))
    on('session.repo', async () => ({ value: null }))
    on('session.messages', async () => ({ value: [] }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('ui.open', async () => ({ value: undefined }))
    on('ui.invalidate', async () => ({ value: undefined }))
    on('ui.log', async () => ({ value: undefined }))

    on('turn.step', async function* ($, e) {
      yield { kind: 'text', index: 0, text: 'hello world from the model, nicely streamed' }
      yield { kind: 'text', index: 0, text: ' and a second piece two seconds later' }
      yield { kind: 'stop', stopReason: 'end_turn', usage: USAGE }
      return {
        turnId: e.turnId,
        index: e.index,
        answer: 'hello world',
        toolUses: [],
        stopReason: 'end_turn',
        usage: USAGE,
      }
    })

    await $.session.start({
      surface: 'terminal',
      isInteractive: true,
      cwd: 'D:\\Buisness\\Claude-tps-mod\\tps-meter',
    })

    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })
    await stream.next()
    clock.advance(2000)
    // Drain the stream: the mod's generator only finishes (and records the
    // finished step) once the consumer pulls past its last yield.
    let step = await stream.next()
    while (!step.done) step = await stream.next()
    await stream.result

    const probes = [/^Context$/, /31\.4%/, /85\.4k/, /^Tokens$/, /Cache read/, /^Cache$/, /Expires in/, /^5m cache · API key$/, /[45]:[0-5][0-9]/, /^Speed$/, /First token/, /^Output$/, /^Workspace$/, /tps-meter/, /^Cost$/, /^\$3\.46$/]
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'sidebar',
        surface,
        component: 'Pane',
        requestId: 'meter',
        props: PANE_PROPS,
      })
      const missing: string[] = []
      for (const p of probes) {
        if (!(await ui.find({ type: 'Text', text: p }))) missing.push(String(p))
      }
      expect([surface, ...missing]).toEqual([surface])
      await ui.unmount()
    }

    // Inline (main-screen terminal): compact strip, not the tall sidebar.
    const strip = await $.ui.mount({
      plugin: 'sidebar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'meter',
      props: { ...PANE_PROPS, placement: 'inline' as const },
    })
    expect(await strip.find({ type: 'Text', text: /31\.4%/ })).toBeDefined()
    expect(await strip.find({ type: 'Text', text: /First token/ })).toBeUndefined()
    await strip.unmount()
  })

  test('before any turn: labels still draw, values are placeholders', async ($, on) => {
    mock.clock(on)
    mock.store(on, {})

    on('session.usage', async () => ({
      value: { context: { tokens: 0, window: 272000 }, rateLimits: [] },
    }))
    on('env.get', async () => ({ value: undefined }))
    on('session.cwd', async () => ({ value: 'C:\\work' }))
    on('session.repo', async () => ({ value: null }))
    on('session.messages', async () => ({ value: [] }))

    const ui = await $.ui.mount({
      plugin: 'sidebar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'meter',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: /^Context$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /—/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /tps-meter/ })).toBeUndefined()
    await ui.unmount()
  })
  test('/sidebar toggles the pane', async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    const calls: string[] = []
    on('ui.open', async () => { calls.push('open'); return { value: { isPlaced: true } } })
    on('ui.close', async () => { calls.push('close'); return { value: undefined } })
    on('command.register', async () => ({ value: undefined }))
    on('ui.log', async () => ({ value: undefined }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' })
    expect((await $.command.run({ command: 'sidebar' })).text).toMatch(/hidden/)
    expect((await $.command.run({ command: 'sidebar' })).text).toMatch(/shown/)
    expect(calls).toEqual(['open', 'close', 'open'])
  })
  test('a 1M context window reads 1M, not 1000.0k', async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    on('session.usage', async () => ({
      value: { context: { tokens: 999_950, window: 1_000_000 }, rateLimits: [] },
    }))
    on('env.get', async () => ({ value: undefined }))
    on('session.cwd', async () => ({ value: 'C:\work' }))

    const ui = await $.ui.mount({
      plugin: 'sidebar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'meter',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: /^1M \/ 1M tokens$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1000/ })).toBeUndefined()
    await ui.unmount()
  })
  test('cache TTL resolves like Claude Code', async () => {
    const sub = [{ percentUsed: 40 }]
    expect(resolveTtl({ rateLimits: sub })).toEqual({ minutes: 60, source: 'subscription' })
    expect(resolveTtl({ rateLimits: [] })).toEqual({ minutes: 5, source: 'API key' })
    expect(resolveTtl({ rateLimits: [{ percentUsed: 100 }] })).toEqual({ minutes: 5, source: 'over limit' })
    expect(resolveTtl({ rateLimits: sub, setting: '5m' })).toEqual({ minutes: 5, source: 'setting' })
    expect(resolveTtl({ rateLimits: [], setting: '1h' })).toEqual({ minutes: 60, source: 'setting' })
    expect(resolveTtl({ rateLimits: sub, setting: '1h', envTtl: '5m' })).toEqual({ minutes: 5, source: 'env' })
    expect(resolveTtl({ rateLimits: sub, force5m: '1' })).toEqual({ minutes: 5, source: 'env' })
    expect(resolveTtl({ rateLimits: [], enable1h: '1' })).toEqual({ minutes: 60, source: 'env' })
  })
  test('speed ignores bursts and measures first to last piece', async () => {
    expect(speed(20, 0, 2000)).toBe(10) // 20 tokens over 2s
    expect(speed(300, 1000, 1004)).toBeNull() // one burst: no reading, not 75,000 tok/s
    expect(speed(0, 0, 5000)).toBeNull()
    expect(speed(100, 0, 500)).toBe(200)
  })
  test('task lists follow TodoWrite and TaskCreate/TaskUpdate', async () => {
    const todo = applyTodoWrite([
      { content: 'Fix speed', activeForm: 'Fixing speed', status: 'completed' },
      { content: 'Add tasks', activeForm: 'Adding tasks', status: 'in_progress' },
      { content: '', status: 'pending' }, // no title: dropped
    ])
    expect(todo.map(t => [t.title, t.status])).toEqual([['Fix speed', 'completed'], ['Add tasks', 'in_progress']])
    expect(applyTodoWrite(undefined)).toEqual([])

    let list = applyTaskCreate([], { subject: 'Write tests' }, null, 'Task #4 created successfully: Write tests')
    list = applyTaskCreate(list, { subject: 'Ship it' }, { task: { id: 5 } })
    expect(list.map(t => t.id)).toEqual(['4', '5'])
    list = applyTaskUpdate(list, { taskId: '4', status: 'completed' })
    expect(list[0]!.status).toBe('completed')
    list = applyTaskUpdate(list, { taskId: '5', status: 'deleted' })
    expect(list.map(t => t.id)).toEqual(['4'])
    expect(applyTaskUpdate(list, { taskId: '99', status: 'completed' })).toEqual(list)
  })

  test('the Tasks section shows progress and the task in progress', async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    on('session.usage', async () => ({ value: { context: { tokens: 0, window: 200000 }, rateLimits: [] } }))
    on('env.get', async () => ({ value: undefined }))
    on('session.cwd', async () => ({ value: 'C:\work' }))
    on('ui.invalidate', async () => ({ value: undefined }))
    on('tool.call', async () => ({ result: {}, text: 'ok', isError: false }))

    const mount = () =>
      $.ui.mount({ plugin: 'sidebar', surface: 'terminal', component: 'Pane', requestId: 'meter', props: PANE_PROPS })
    const before = await mount()
    expect(await before.find({ type: 'Text', text: /^Tasks$/ })).toBeUndefined() // hidden with no list
    await before.unmount()

    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Fix speed', activeForm: 'Fixing speed', status: 'completed' },
        { content: 'Add tasks', activeForm: 'Adding the Tasks section', status: 'in_progress' },
        { content: 'Ship it', activeForm: 'Shipping', status: 'pending' },
      ],
    } as any)

    const ui = await mount()
    expect(await ui.find({ type: 'Text', text: /^Tasks$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1\/3$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Adding the Tasks section/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Fix speed$/ })).toBeDefined() // done rows stay listed
    expect(await ui.find({ type: 'Text', text: /^Ship it$/ })).toBeDefined() // and so do pending ones
    for (const mark of [/^✓ $/, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] $/, /^○ $/]) expect(await ui.find({ type: 'Text', text: mark })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ 0:00$/ })).toBeDefined() // elapsed time on the running task
    await ui.unmount()
  })
  test('session start turns the task tools on unless the person chose', async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    on('ui.log', async () => ({ value: undefined }))
    on('command.register', async () => ({ value: undefined }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    let preset: string | undefined
    const sets: [string, string | undefined][] = []
    on('env.get', async ($, e) => ({ value: e.name === 'CLAUDE_CODE_ENABLE_TODO_TOOLS' ? preset : undefined }))
    on('env.set', async ($, e) => (sets.push([e.name, e.value]), { value: undefined }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' })
    expect(sets).toEqual([['CLAUDE_CODE_ENABLE_TODO_TOOLS', '1']])

    sets.length = 0
    preset = '0' // the person turned them off: respected
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' })
    expect(sets).toEqual([])
  })
  test('long task lists fold but keep the task in progress in view', async () => {
    const mk = (n: number, active: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: String(i),
        title: `t${i}`,
        status: (i < active ? 'completed' : i === active ? 'in_progress' : 'pending') as any,
      }))
    expect(visibleTasks(mk(5, 2))).toEqual({ rows: mk(5, 2), more: 0 }) // short: all shown
    const { rows, more } = visibleTasks(mk(20, 12))
    expect(rows.length + more).toBe(20)
    expect(rows.length).toBe(7) // 7 rows + the "+N more" line = 8
    expect(rows.some(t => t.status === 'in_progress')).toBe(true)
    expect(visibleTasks(mk(20, 19)).rows.at(-1)!.title).toBe('t19') // near the end: window ends at the last
  })
  test('running tasks keep their start time; the spinner turns', async () => {
    const run = (id: string, status: any) => ({ id, title: id, status })
    let starts = trackStarts([run('a', 'in_progress')], new Map(), 1000)
    starts = trackStarts([run('a', 'in_progress'), run('b', 'pending')], starts, 5000)
    expect([...starts]).toEqual([['a:a', 1000]]) // still running: original start kept
    starts = trackStarts([run('a', 'completed'), run('b', 'in_progress')], starts, 9000)
    expect([...starts]).toEqual([['b:b', 9000]]) // finished dropped, new one stamped
    expect(spinnerFrame(0)).not.toBe(spinnerFrame(125))
    expect([formatElapsed(0), formatElapsed(42_000), formatElapsed(3_729_000)]).toEqual(['0:00', '0:42', '1:02:09'])
  })
  test('a completed task titled FAILED reads as failed', async () => {
    expect(failedTitle('FAILED: Run python setup_db.py')).toBe('Run python setup_db.py')
    expect(failedTitle('Failed - deploy')).toBe('deploy')
    expect(failedTitle('Blocked: waiting on API key')).toBe('waiting on API key')
    expect(failedTitle('Errors page cleanup')).toBeNull() // a word that merely starts with one
    expect(failedTitle('Fix failed builds')).toBeNull() // failure word not at the start
    expect(failedTitle('Create hello.py')).toBeNull()
  })
  test('cost reads in dollars at a glance', async () => {
    expect([formatUsd(0), formatUsd(0.004), formatUsd(3.456), formatUsd(99.999), formatUsd(1234.5)]).toEqual([
      '$0.00', '<$0.01', '$3.46', '$100', '$1,235',
    ])
  })
  test("a subscriber sees this session's share of the limits", async () => {
    let u = trackLimitUse(new Map(), [{ kind: 'five_hour', percentUsed: 40 }, { kind: 'seven_day', percentUsed: 10 }])
    u = trackLimitUse(u, [{ kind: 'five_hour', percentUsed: 49 }, { kind: 'seven_day', percentUsed: 12.5 }])
    expect(sessionShare(u.get('five_hour')!)).toBe(9)
    expect(sessionShare(u.get('seven_day')!)).toBe(2.5)
    // the 5-hour window resets (49 -> 3): the 9 used before it is kept
    u = trackLimitUse(u, [{ kind: 'five_hour', percentUsed: 3 }])
    expect(sessionShare(u.get('five_hour')!)).toBe(12)
    expect([formatShare(0), formatShare(0.04), formatShare(2.5), formatShare(12.4)]).toEqual(['0%', '<0.1%', '+2.5%', '+12%'])
  })

  test('subscribers get limit rows, API users get cost', async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    let usage: any = { context: { tokens: 0, window: 200000 }, rateLimits: [], cost: { usd: 1.5 } }
    on('session.usage', async () => ({ value: usage }))
    on('env.get', async () => ({ value: undefined }))
    on('session.cwd', async () => ({ value: 'C:\work' }))
    const mount = () =>
      $.ui.mount({ plugin: 'sidebar', surface: 'terminal', component: 'Pane', requestId: 'meter', props: PANE_PROPS })

    const api = await mount()
    expect(await api.find({ type: 'Text', text: /^\$1\.50$/ })).toBeDefined()
    expect(await api.find({ type: 'Text', text: /limit/ })).toBeUndefined()
    await api.unmount()

    usage = { ...usage, rateLimits: [{ kind: 'five_hour', percentUsed: 20 }, { kind: 'seven_day', percentUsed: 5 }] }
    const sub = await mount()
    expect(await sub.find({ type: 'Text', text: /^5-hour limit$/ })).toBeDefined()
    expect(await sub.find({ type: 'Text', text: /^Weekly limit$/ })).toBeDefined()
    expect(await sub.find({ type: 'Text', text: /^Cost$/ })).toBeUndefined()
    await sub.unmount()
  })
  test('CoVe: session-scoped totals, true hit rate, main-loop speed', async ($, on) => {
    mock.clock(on)
    // A previous session's totals are in the store: they must not carry over.
    mock.store(on, { sums: { input: 9e6, output: 9e6, cacheRead: 9e6, cacheWrite: 9e6 }, session: 'old-session' })
    on('session.id', async () => ({ value: 'new-session' }))
    on('session.usage', async () => ({ value: { context: { tokens: 0, window: 200000 }, rateLimits: [] } }))
    on('env.get', async () => ({ value: undefined }))
    on('env.set', async () => ({ value: undefined }))
    on('session.cwd', async () => ({ value: 'C:\work' }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    on('ui.invalidate', async () => ({ value: undefined }))
    on('ui.log', async () => ({ value: undefined }))
    on('command.register', async () => ({ value: undefined }))
    const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, model: 'm' }
    on('turn.step', async function* ($, e) {
      yield { kind: 'text', index: 0, text: 'hello' }
      yield { kind: 'stop', stopReason: 'end_turn', usage }
      return { turnId: e.turnId, index: e.index, answer: 'hello', toolUses: [], stopReason: 'end_turn', usage }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' })

    // A subagent's reply: its tokens count, but not its speed or cache clock.
    const drain = async (agentId?: string) => {
      const st = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) })
      let r = await st.next()
      while (!r.done) r = await st.next()
      await st.result
    }
    await drain('sub-1')
    const mount = () =>
      $.ui.mount({ plugin: 'sidebar', surface: 'terminal', component: 'Pane', requestId: 'meter', props: PANE_PROPS })
    let ui = await mount()
    expect(['/^100$/', !!(await ui.find({ type: 'Text', text: /^100$/ }))]).toEqual(['/^100$/', true]) // input: this session only, not 9M
    expect(['/^80\\.0%$/', !!(await ui.find({ type: 'Text', text: /^80\.0%$/ }))]).toEqual(['/^80\\.0%$/', true]) // 800 / (800 + 100 + 100)
    expect(['/^—$/', !!(await ui.find({ type: 'Text', text: /^—$/ }))]).toEqual(['/^—$/', true]) // no main reply yet: no expiry, no first token
    expect(['/^0ms$/', !!(await ui.find({ type: 'Text', text: /^0ms$/ }))]).toEqual(['/^0ms$/', false])
    await ui.unmount()

    await drain() // the main conversation's reply starts the clock
    ui = await mount()
    // the countdown now runs (the test kit's clock does not move, so no exact time)
    expect(!!(await ui.find({ type: 'Text', text: /^[45]:[0-5][0-9]$/ }))).toBe(true)
    await ui.unmount()
  })
})
