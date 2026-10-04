/* @jsx h */
import type { Register } from 'claude-code'

// ---- stats sidebar: everything is this session's ----
// Token rows sum the API's usage over every response this session (subagents
// included: they are spend too). Speed, first token and the cache countdown
// follow the main conversation only: a subagent runs its own model and its own
// prompt cache. The countdown is the main conversation's cache TTL minus the
// time since its last request was sent (when the cache was last used).

type Stats = { tps: number; ttftMs: number | null; isWarmingUp?: boolean }
type Last = Stats & { at: number }
type Sums = { input: number; output: number; cacheRead: number; cacheWrite: number }

let live: Stats | null = null // the step currently streaming
let last: Last | null = null // the last finished step
let sums: Sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
let lastInvalidateAt = 0
let tick: unknown
let isOpen = false // ponytail: module var, a hot reload reopens the pane anyway

const PANE = { id: 'meter', title: 'Claude Code Sidebar', columns: 38, rows: 3 } as const
let git: {
  branch: string | null
  dirty: boolean | null
  changed: number
  added: number
  removed: number
} | null = null
let gitAt = 0
let sessionId = ''
let taskStarts = new Map<string, number>() // in-progress task key -> when it started
let limitUse = new Map<string, LimitUse>() // per window kind: what this session has used
let tasks: Task[] = [] // the main conversation's task list, as its task tools last left it

const round1 = (n: number) => Math.round(n * 10) / 10

function formatTtft(ms: number | null): string {
  if (ms === null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

function formatTps(n: number): string {
  return n >= 100 ? `${Math.round(n)} tok/s` : `${n.toFixed(0)} tok/s`
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'expired'
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// One accent on a neutral base. Green/amber/red appear only as status
// (git state, cache about to expire, lines added/removed), never decoration.
const C = {
  accent: '#7aa2f7',
  track: '#3b4048',
  muted: '#8b919a',
  ok: '#8fbf7a',
  warn: '#d9a55b',
  bad: '#e07a7a',
}

// Compact counts: 76, 16.8k, 3.68M. Calmer than 3,684,818 in a narrow column.
function compact(n: number): string {
  if (n < 1000) return String(n)
  const k = (n / 1000).toFixed(n < 100_000 ? 1 : 0)
  // 999,950 rounds to "1000" k: that is 1M, so fall through to millions.
  if (+k < 1000) return `${+k}k`
  return `${+(n / 1_000_000).toFixed(2)}M`
}

// Smooth block bar. Terminal: full cells █, then one partial cell in eighths
// (▏..▉) so the end moves smoothly, then a dim ░ track; monospace, exact.
// Desktop/remote: an SVG pill, since a proportional font makes glyph runs drift.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

function smoothBar(ratio: number, width: number): { fill: string; track: string } {
  const eighths = Math.round(Math.max(0, Math.min(1, ratio)) * width * 8)
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8]!
  return { fill: '█'.repeat(full) + part, track: '░'.repeat(width - full - (part ? 1 : 0)) }
}

function Bar(props: { ratio: number; color: string; width: number; surface: string; el: any }) {
  const { ratio, color, width, surface, el } = props
  const r = Math.max(0, Math.min(1, ratio))
  if (surface === 'terminal') {
    const { fill, track } = smoothBar(r, width)
    return (
      <el.Text>
        <el.Text color={color}>{fill}</el.Text>
        <el.Text color={C.track}>{track}</el.Text>
      </el.Text>
    )
  }
  const w = Math.round(r * 1000)
  // 8px pill centred in 14px: the transparent margin spaces rows on desktop.
  // rx is wider than ry because the 1000-wide viewBox is squeezed to the pane.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="14" viewBox="0 0 1000 14" preserveAspectRatio="none"><rect y="3" width="1000" height="8" rx="10" ry="4" fill="${C.track}"/>${w > 0 ? `<rect y="3" width="${Math.max(w, 20)}" height="8" rx="10" ry="4" fill="${color}"/>` : ''}</svg>`
  return (
    <el.Box width="100%">
      <el.Svg source={svg} alt={`${Math.round(r * 100)}%`} height={14} />
    </el.Box>
  )
}

function Title(props: { label: string; right?: string; el: any }) {
  const { label, right, el } = props
  return (
    <el.Box flexDirection="row" justifyContent="space-between" width="100%">
      <el.Text bold>{label}</el.Text>
      {right !== undefined ? <el.Text bold color={C.accent}>{right}</el.Text> : undefined}
    </el.Box>
  )
}

function Row(props: { label: string; value: string; el: any; color?: string; dim?: boolean }) {
  const { label, value, el, color, dim } = props
  return (
    <el.Box flexDirection="row" justifyContent="space-between" width="100%">
      <el.Text color={C.muted}>{label}</el.Text>
      <el.Text color={dim ? C.muted : color}>{value}</el.Text>
    </el.Box>
  )
}

async function pollGit($: any): Promise<void> {
  try {
    const branchRun = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 3000 })
    const statusRun = await $.process.run(['git', 'status', '--porcelain'], { timeoutMs: 3000 })
    // Staged and unstaged edits against HEAD, so Lines agrees with Status after
    // a `git add`. A repo with no commit yet has no HEAD: compare the index then.
    let diffRun = await $.process.run(['git', 'diff', 'HEAD', '--numstat'], { timeoutMs: 3000 })
    if (diffRun.exitCode !== 0) diffRun = await $.process.run(['git', 'diff', '--cached', '--numstat'], { timeoutMs: 3000 })
    if (branchRun.exitCode !== 0) {
      git = null // not a repo: the sidebar shows its empty state
      return
    }
    const branch = String(branchRun.stdout).trim() || null
    const statusLines =
      statusRun.exitCode === 0 ? String(statusRun.stdout).split('\n').filter(l => l.trim().length > 0) : []
    let added = 0
    let removed = 0
    for (const line of String(diffRun.stdout).split('\n')) {
      const parts = line.split(/\s+/)
      if (parts.length >= 2 && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[1]!)) {
        added += Number(parts[0])
        removed += Number(parts[1])
      }
    }
    git = { branch, dirty: statusLines.length > 0, changed: statusLines.length, added, removed }
  } catch {
    // not a repo or git missing: keep last known
  }
}

// Share of all input served from the cache: uncached input counts against it
// as much as cache writes do.
function hitRate(): number | null {
  const { cacheRead, cacheWrite, input } = sums
  const total = cacheRead + cacheWrite + input
  return total > 0 ? cacheRead / total : null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Newer models (Opus 5.5 and up) get no task tools unless this is set, and
    // without them there is nothing for the Tasks section to follow. Turn them
    // on for this process, before the session builds its tool list; a value
    // the person set themselves (0 to keep them off) is left alone.
    try {
      if ((await $.env.get('CLAUDE_CODE_ENABLE_TODO_TOOLS')) === undefined) {
        await $.env.set('CLAUDE_CODE_ENABLE_TODO_TOOLS', '1')
      }
    } catch {
      // no env access: the sidebar still opens, Tasks just stays hidden
    }
    const result = await next(e)
    limitUse = new Map() // a new session counts its share of the limits from here

    // Counters are this session's. Start from zero, and pick saved ones back up
    // only for this same session (a resume or a plugin reload), never another's.
    sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    last = null
    sessionId = await $.session.id().catch(() => '')
    const [stored, storedSums, storedFor] = await Promise.all([
      $.store.get('last').catch(() => undefined),
      $.store.get('sums').catch(() => undefined),
      $.store.get('session').catch(() => undefined),
    ])
    const isSameSession = sessionId !== '' && storedFor === sessionId
    if (isSameSession && stored && typeof stored === 'object') {
      const s = stored as { tps?: unknown; ttftMs?: unknown; at?: unknown }
      if (typeof s.tps === 'number' && Number.isFinite(s.tps)) {
        last = {
          tps: s.tps,
          ttftMs: typeof s.ttftMs === 'number' && Number.isFinite(s.ttftMs) ? s.ttftMs : null,
          at: typeof s.at === 'number' && Number.isFinite(s.at) ? s.at : 0,
        }
      }
    }
    if (isSameSession && storedSums && typeof storedSums === 'object') {
      const s = storedSums as Sums
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        if (typeof s[k] === 'number' && Number.isFinite(s[k])) sums[k] = s[k]
      }
    }

    await $.command.register({ name: 'sidebar', description: 'Show or hide the sidebar' })

    // Dock the sidebar beside the transcript (columns => docked).
    await $.ui
      .open(PANE)
      .then(r => { isOpen = r?.isPlaced !== false })
      .catch(err => $.ui.log(`sidebar: pane not opened: ${err}`))

    // Redraw once a second for the cache countdown, and ~8 times a second
    // while a task is in progress so its spinner turns.
    ;(tick as { cancel(): void } | undefined)?.cancel?.()
    let ticks = 0
    tick = $.clock.every(SPIN_MS, () => {
      ticks++
      if (tasks.some(t => t.status === 'in_progress') || ticks % Math.round(1000 / SPIN_MS) === 0) {
        $.ui.invalidate('ui.render')
      }
    })

    return result
  })

  on('command.run', { command: 'sidebar' }, async $ => {
    const shown = await toggle($)
    return { text: shown ? 'Sidebar shown.' : 'Sidebar hidden. /sidebar or ctrl+x s shows it again.' }
  })

  // While hidden, a one-line "show" button above the prompt keeps the shortcut
  // alive: a Button's `action` chord only fires while that Button is mounted.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isOpen || e.props.hasSurvey) return next(e)
    const { Box, Button } = (await $.ui.resolve(e)) as any
    return (
      <Box>
        <Button key="toggle" label="Show sidebar  ctrl+x s" plain dimColor action={TOGGLE_ACTION} onPress={() => toggle($)} />
      </Box>
    )
  })

  // The person can also close it with the pane's own x; keep the toggle in step.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE.id) {
      isOpen = false
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Tasks: follow the main conversation's task tools. Subagents keep lists of
  // their own (agentId set); those would muddle the plan shown here.
  on('tool.call', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId || !TASK_TOOLS.has(e.tool) || 'deny' in out || out.isError) return out
    const args = e as unknown as Record<string, unknown>
    if (e.tool === 'TodoWrite') tasks = applyTodoWrite(args.todos)
    else if (e.tool === 'TaskCreate') tasks = applyTaskCreate(tasks, args, out.result, out.text)
    else tasks = applyTaskUpdate(tasks, args)
    taskStarts = trackStarts(tasks, taskStarts, await $.clock.now())
    $.ui.invalidate('ui.render')
    return out
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = !e.agentId // speed and the cache clock are the main conversation's
    const startedAt = await $.clock.now()
    let firstTokenAt: number | null = null
    let lastTokenAt: number | null = null
    let chars = 0
    const stream = next(e)
    try {
      for await (const chunk of stream) {
        // Every streamed piece of output counts: visible text, thinking, and
        // tool-call arguments (a file the model writes streams as `input`).
        const piece =
          chunk.kind === 'text' || chunk.kind === 'thinking' ? chunk.text : chunk.kind === 'input' ? chunk.json : null
        if (piece !== null && isMain) {
          const now = await $.clock.now()
          if (firstTokenAt === null) firstTokenAt = now
          lastTokenAt = now
          chars += piece.length
          const tps = speed(Math.round(chars / 4), firstTokenAt, now)
          live = { tps: tps ?? live?.tps ?? last?.tps ?? 0, ttftMs: firstTokenAt - startedAt, isWarmingUp: tps === null }
          if (now - lastInvalidateAt > 500) {
            lastInvalidateAt = now
            $.ui.invalidate('ui.render')
          }
        }
        yield chunk
      }
    } finally {
      live = null
    }

    const result = await stream.result
    const usage = result.usage
    if (usage) {
      sums = {
        input: sums.input + (usage.input_tokens ?? 0),
        output: sums.output + (usage.output_tokens ?? 0),
        cacheRead: sums.cacheRead + (usage.cache_read_input_tokens ?? 0),
        cacheWrite: sums.cacheWrite + (usage.cache_creation_input_tokens ?? 0),
      }
      $.store.set('sums', sums).catch(err => {
        $.ui.log(`sidebar: store write failed: ${err}`)
      })
      $.store.set('session', sessionId).catch(() => undefined)
    }
    if (isMain && (usage || chars > 0)) {
      // A main-conversation response arrived: the cache clock restarts whether
      // or not the speed reading below is trustworthy.
      const tps = firstTokenAt === null ? null : speed(usage?.output_tokens ?? Math.round(chars / 4), firstTokenAt, lastTokenAt!)
      last = {
        tps: tps ?? last?.tps ?? 0,
        ttftMs: firstTokenAt === null ? (last?.ttftMs ?? null) : firstTokenAt - startedAt,
        // The cache was last used when this request was read, not when the
        // reply finished: counting from the end would overstate time left.
        at: startedAt,
      }
      $.store.set('last', last).catch(err => {
        $.ui.log(`sidebar: store write failed: ${err}`)
      })
    }
    live = null
    $.ui.invalidate('ui.render')
    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== 'meter') return next(e)
    // Being drawn means it is open. An unasked open below 144 columns waits
    // ({ isPlaced: false }) and is seated later, after session.start already
    // recorded it closed; without this the band's "Show sidebar" lingers.
    if (!isOpen) {
      isOpen = true
      $.ui.invalidate('ui.render') // drop the band's show button
    }
    const els = (await $.ui.resolve(e)) as any // Svg exists on desktop, not terminal
    const { Box, Text } = els

    // CONTEXT figures from the session usage (same source as the status line).
    let contextPct: number | null = null
    let contextLine = '— / —'
    let rateLimits: { kind: string; percentUsed: number }[] = []
    let costUsd: number | undefined
    try {
      const usage = await $.session.usage()
      rateLimits = usage?.rateLimits ?? []
      costUsd = usage?.cost?.usd
      limitUse = trackLimitUse(limitUse, rateLimits)
      if (usage && usage.context && usage.context.window) {
        const used = usage.context.tokens ?? 0
        contextPct = used / usage.context.window
        contextLine = `${compact(used)} / ${compact(usage.context.window)}`
      }
    } catch {
      // a test or a build without session.usage: draw without context
    }

    // Prompt-cache TTL of the main conversation, resolved as Claude Code does.
    const [envTtl, force5m, enable1h, settings] = await Promise.all([
      $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(() => undefined),
      $.env.get('FORCE_PROMPT_CACHING_5M').catch(() => undefined),
      $.env.get('ENABLE_PROMPT_CACHING_1H').catch(() => undefined),
      $.settings.read().catch(() => ({}) as Record<string, unknown>),
    ])
    const ttl = resolveTtl({
      envTtl,
      force5m,
      enable1h,
      setting: settings.promptCacheTtl,
      rateLimits,
    })
    const ttlMin = ttl.minutes

    const now = await $.clock.now()
    if (now - gitAt > 5000) {
      gitAt = now
      await pollGit($)
    }
    const remaining = last ? ttlMin * 60_000 - (now - last.at) : null
    const remainingRatio = remaining !== null ? remaining / (ttlMin * 60_000) : 0

    let workspace = ''
    try {
      workspace = await $.session.cwd()
    } catch {
      // keep defaults
    }
    const workspaceName = workspace ? workspace.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '' : '—'

    const liveStats = live ?? last
    const rate = hitRate()
    const contextBarRatio = contextPct ?? 0

    const ctxPctText = contextPct === null ? '—' : `${(contextPct * 100).toFixed(1)}%`
    const rateText = rate === null ? '—' : `${(rate * 100).toFixed(1)}%`
    const validText = remaining === null ? '—' : formatCountdown(remaining)
    const speedText = liveStats && liveStats.tps > 0 ? formatTps(liveStats.tps) : '—'
    // Expiry is the one value that changes meaning near zero: color it then.
    const expiryColor = remaining === null ? C.muted : remaining < 30_000 ? C.bad : remaining < 90_000 ? C.warn : undefined
    const el = els
    const barW = Math.max(10, (e.props.bodyColumns || 30) - 3) // minus paddingLeft 1 + paddingRight 2

    // Main-screen terminal seats the pane inline above the prompt, full width:
    // a sidebar layout there is a takeover, so draw a compact strip instead.
    if (e.props.placement === 'inline') {
      const dot = <Text color={C.track}>  ·  </Text>
      return (
        <Box flexDirection="column" width="100%">
          <Box flexDirection="row" width="100%" flexWrap="wrap">
            <Text color={C.muted}>Context </Text>
            <Bar ratio={contextBarRatio} color={C.accent} width={16} surface={e.surface} el={el} />
            <Text bold color={C.accent}> {ctxPctText}</Text>
            {dot}
            <Text color={C.muted}>Cache </Text><Text>{rateText}</Text>
            <Text color={C.muted}> expires </Text><Text color={expiryColor}>{validText}</Text>
            {dot}
            <Text color={C.muted}>Speed </Text><Text>{speedText}</Text>
            {dot}
            <Text color={C.muted}>Total </Text>
            <Text>{compact(sums.input + sums.output + sums.cacheRead + sums.cacheWrite)}</Text>
          </Box>
          <Text color={C.muted}>Run /tui fullscreen to dock this as a sidebar.</Text>
        </Box>
      )
    }

    const gap = <Box height={1} />
    return (
      <Box flexDirection="column" width="100%" minHeight={e.props.scroll?.bodyRows} paddingLeft={1} paddingRight={2} paddingTop={1}>
        {tasks.length > 0 ? (
          <Box flexDirection="column" width="100%" marginBottom={1}>
            <Title label="Tasks" right={`${taskDone(tasks)}/${tasks.length}${taskFailed(tasks) ? ` · ${taskFailed(tasks)} ✗` : ''}`} el={el} />
            <Bar ratio={(taskDone(tasks) + taskFailed(tasks)) / tasks.length} color={C.accent} width={barW} surface={e.surface} el={el} />
            <TaskRows tasks={tasks} starts={taskStarts} now={now} el={el} />
          </Box>
        ) : undefined}
        <Title label="Context" right={ctxPctText} el={el} />
        <Bar ratio={contextBarRatio} color={C.accent} width={barW} surface={e.surface} el={el} />
        <Text color={C.muted}>{contextLine} tokens</Text>
        {gap}

        <Title label="Tokens" el={el} />
        <Row label="Input" value={compact(sums.input)} el={el} />
        <Row label="Output" value={compact(sums.output)} el={el} />
        <Row label="Cache read" value={compact(sums.cacheRead)} el={el} />
        <Row label="Cache write" value={compact(sums.cacheWrite)} el={el} />
        <Box flexDirection="row" justifyContent="space-between" width="100%">
          <Text>Total</Text>
          <Text bold>{compact(sums.input + sums.output + sums.cacheRead + sums.cacheWrite)}</Text>
        </Box>
        {/* What this session spent, in the unit the person pays in: a share of
            the plan's limits on a subscription, dollars on an API key. */}
        {rateLimits.length > 0 ? (
          <Box flexDirection="column" width="100%">
            {LIMIT_ROWS.filter(([kind]) => limitUse.has(kind)).map(([kind, label]) => (
              <Row key={`limit-${kind}`} label={label} value={formatShare(sessionShare(limitUse.get(kind)!))} el={el} />
            ))}
          </Box>
        ) : costUsd !== undefined && costUsd > 0 ? ( // > 0: before the first reply, a subscriber has no readings yet
          <Row label="Cost" value={formatUsd(costUsd)} el={el} />
        ) : undefined}
        {gap}

        <Title label="Cache" el={el} />
        <Row label="Hit rate" value={rateText} el={el} color={C.accent} />
        <Bar ratio={rate ?? 0} color={C.accent} width={barW} surface={e.surface} el={el} />
        {gap}
        <Box flexDirection="row" justifyContent="space-between" width="100%">
          <Text color={C.muted}>Expires in</Text>
          <Text>
            <Text color={expiryColor}>{validText}</Text>
            <Text color={C.muted}> / {ttlMin === 60 ? '1h' : '5m'}</Text>
          </Text>
        </Box>
        <Bar ratio={remainingRatio} color={expiryColor ?? C.accent} width={barW} surface={e.surface} el={el} />
        {/* Which rule set the TTL, on its own line: beside the time it overflowed a narrow pane. */}
        <Text color={C.muted}>{ttlMin === 60 ? '1h' : '5m'} cache · {ttl.source}</Text>
        {gap}

        <Title label="Speed" el={el} />
        <Row label="First token" value={formatTtft(liveStats?.ttftMs ?? null)} el={el} />
        <Row label="Output" value={speedText} el={el} />
        {gap}

        <Title label="Workspace" el={el} />
        <Row label="Folder" value={workspaceName} el={el} />
        {git ? (
          <Box flexDirection="column" width="100%">
            <Row label="Branch" value={git.branch ?? 'detached'} el={el} />
            <Row label="Status" value={git.dirty ? `${git.changed} changed` : 'Clean'} el={el} color={git.dirty ? C.warn : C.ok} />
            <Box flexDirection="row" justifyContent="space-between" width="100%">
              <Text color={C.muted}>Lines</Text>
              <Text>
                <Text color={C.ok}>+{compact(git.added)}</Text>
                <Text color={C.muted}> </Text>
                <Text color={C.bad}>−{compact(git.removed)}</Text>
              </Text>
            </Box>
          </Box>
        ) : (
          <Row label="Git" value="Not a repository" el={el} dim />
        )}

        {/* Spacer: the pane's body is bodyRows tall, so the toggle sits at its foot. */}
        <Box flexGrow={1} minHeight={1} />
        <els.Button key="toggle" label="Hide sidebar  ctrl+x s" plain dimColor action={TOGGLE_ACTION} onPress={() => toggle($)} />
      </Box>
    )
  })
}

// Borrowed engine action: the person binds a chord to it in keybindings.json
// (ctrl+x s -> app:toggleReplTab), and that chord presses whichever toggle
// button is mounted. ponytail: no custom-action API for plugins yet; swap the
// name if the engine ever mounts its own handler for this action.
const TOGGLE_ACTION = 'app:toggleReplTab'

async function toggle($: any): Promise<boolean> {
  if (isOpen) {
    await $.ui.close({ id: PANE.id })
    isOpen = false
  } else {
    await $.ui.open(PANE)
    isOpen = true
  }
  $.ui.invalidate('ui.render') // the band's show button appears/disappears
  return isOpen
}

// Prompt-cache TTL for the main conversation, per Claude Code's own
// `promptCacheTtl` setting description: CLAUDE_CODE_PROMPT_CACHE_TTL wins,
// then the setting, then automatic (1 hour on a Claude subscription within its
// usage limits, 5 minutes on an API key, Bedrock, Vertex or Foundry).
// rateLimits is empty off a subscription; any window at 100% means over limits.
// ponytail: where FORCE_PROMPT_CACHING_5M / ENABLE_PROMPT_CACHING_1H sit
// against the setting is not documented; they rank just under the env TTL.
export function resolveTtl(i: {
  envTtl?: string
  force5m?: string
  enable1h?: string
  setting?: unknown
  rateLimits: { percentUsed: number }[]
}): { minutes: 5 | 60; source: string } {
  if (i.envTtl === '1h') return { minutes: 60, source: 'env' }
  if (i.envTtl === '5m') return { minutes: 5, source: 'env' }
  if (i.force5m === '1') return { minutes: 5, source: 'env' }
  if (i.enable1h === '1') return { minutes: 60, source: 'env' }
  if (i.setting === '1h') return { minutes: 60, source: 'setting' }
  if (i.setting === '5m') return { minutes: 5, source: 'setting' }
  if (i.rateLimits.length === 0) return { minutes: 5, source: 'API key' }
  if (i.rateLimits.some(r => r.percentUsed >= 100)) return { minutes: 5, source: 'over limit' }
  return { minutes: 60, source: 'subscription' }
}

// Output tokens per second over the streaming span (first piece -> last piece).
// Under MIN_SPAN_MS the span is mostly network burst, not generation: a reply
// that lands in one or two chunks would read as thousands of tok/s, so no
// reading is taken (null) and the previous one stays on screen.
const MIN_SPAN_MS = 500
export function speed(tokens: number, firstAt: number, lastAt: number): number | null {
  const spanMs = lastAt - firstAt
  if (tokens <= 0 || spanMs < MIN_SPAN_MS) return null
  return round1((tokens / spanMs) * 1000)
}

// ---- Tasks ----
// Two task tools exist: TodoWrite sends the whole list every call; TaskCreate /
// TaskUpdate add or change one task at a time, by id.
type TaskStatus = 'pending' | 'in_progress' | 'completed'
type Task = { id: string; title: string; active?: string; status: TaskStatus }
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])
const asStatus = (v: unknown): TaskStatus | null =>
  v === 'pending' || v === 'in_progress' || v === 'completed' ? v : null
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const taskDone = (list: Task[]) => list.filter(t => t.status === 'completed' && !failedTitle(t.title)).length
const taskFailed = (list: Task[]) => list.filter(t => t.status === 'completed' && failedTitle(t.title)).length

// The task tools have no "failed" state: Claude marks a failed task completed
// and says so in its title ("FAILED: Run setup_db.py"). Read that prefix as a
// failure; the rest of the title is the task. ponytail: a heuristic on Claude's
// wording; extend FAIL_PREFIX if it starts using another word.
const FAIL_PREFIX = /^\s*(?:failed|failure|error|blocked|skipped|cancell?ed)\b\s*[:\-–—]?\s*/i
export function failedTitle(title: string): string | null {
  const m = FAIL_PREFIX.exec(title)
  return m && m[0].trim() ? title.slice(m[0].length) || title : null
}

export function applyTodoWrite(todos: unknown): Task[] {
  if (!Array.isArray(todos)) return []
  return todos.flatMap((t, i) => {
    const title = str(t?.content)
    return title ? [{ id: String(i), title, active: str(t?.activeForm), status: asStatus(t?.status) ?? 'pending' }] : []
  })
}

export function applyTaskCreate(list: Task[], args: Record<string, unknown>, result: unknown, text?: string): Task[] {
  const title = str(args.subject)
  if (!title) return list
  // The new id comes back in the result: its record, or "Task #12 created ...".
  const rec = (result as { task?: { id?: unknown } } | null)?.task?.id
  const id = rec !== undefined ? String(rec) : (/#(\w+)/.exec(text ?? '')?.[1] ?? `new-${list.length}`)
  return [...list.filter(t => t.id !== id), { id, title, active: str(args.activeForm), status: 'pending' }]
}

export function applyTaskUpdate(list: Task[], args: Record<string, unknown>): Task[] {
  const id = str(String(args.taskId ?? ''))
  if (!id) return list
  if (args.status === 'deleted') return list.filter(t => t.id !== id)
  return list.map(t =>
    t.id !== id
      ? t
      : {
          ...t,
          status: asStatus(args.status) ?? t.status,
          title: str(args.subject) ?? t.title,
          active: str(args.activeForm) ?? t.active,
        },
  )
}

// Every task, one row each, in the order Claude made them: ✓ done (dimmed),
// ▸ in progress (accent, in its "-ing" form), ○ not started. The task tools
// have no "failed" state, so none is shown. Past MAX_TASK_ROWS the rest fold
// into "+N more", keeping the in-progress row in view.
const MAX_TASK_ROWS = 8
const TASK_MARK = { completed: '✓', in_progress: '▸', pending: '○' } as const

export function visibleTasks(list: Task[], max = MAX_TASK_ROWS): { rows: Task[]; more: number } {
  if (list.length <= max) return { rows: list, more: 0 }
  // Start the window just before the task in progress (or the first not done).
  const focus = list.findIndex(t => t.status === 'in_progress')
  const pivot = focus >= 0 ? focus : Math.max(0, list.findIndex(t => t.status !== 'completed'))
  const start = Math.min(Math.max(0, pivot - 2), list.length - (max - 1))
  const rows = list.slice(start, start + max - 1)
  return { rows, more: list.length - rows.length }
}

function TaskRows(props: { tasks: Task[]; starts: Map<string, number>; now: number; el: any }) {
  const { tasks, starts, now, el } = props
  const { rows, more } = visibleTasks(tasks)
  return (
    <el.Box flexDirection="column" width="100%">
      {rows.map(t => {
        const failed = t.status === 'completed' ? failedTitle(t.title) : null
        return (
        <el.Box key={`task-${t.id}`} flexDirection="row" width="100%">
          <el.Text color={failed !== null ? C.bad : t.status === 'completed' ? C.ok : t.status === 'in_progress' ? C.accent : C.muted}>
            {t.status === 'in_progress' ? spinnerFrame(now) : failed !== null ? '✗' : TASK_MARK[t.status]}{' '}
          </el.Text>
          <el.Text
            wrap="truncate"
            bold={t.status === 'in_progress'}
            color={t.status === 'in_progress' ? undefined : C.muted}
          >
            {t.status === 'in_progress' ? (t.active ?? t.title) : (failed ?? t.title)}
          </el.Text>
          {t.status === 'in_progress' && starts.has(taskKey(t)) ? (
            <el.Box flexGrow={1} justifyContent="flex-end">
              <el.Text color={C.muted}> {formatElapsed(now - starts.get(taskKey(t))!)}</el.Text>
            </el.Box>
          ) : undefined}
        </el.Box>
        )
      })}
      {more > 0 ? <el.Text color={C.muted}>+{more} more</el.Text> : undefined}
    </el.Box>
  )
}

// ---- In-progress animation ----
const SPIN_MS = 125
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
// 0:42, 12:05, 1:02:09
export function formatElapsed(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = String(t % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
export const spinnerFrame = (now: number) => SPINNER[Math.floor(now / SPIN_MS) % SPINNER.length]!
// TodoWrite ids are list positions, so the title is part of the key.
const taskKey = (t: Task) => `${t.id}:${t.title}`

// When each in-progress task started: kept while it stays in progress,
// stamped `now` when it first appears so, dropped once it leaves.
export function trackStarts(list: Task[], prev: Map<string, number>, now: number): Map<string, number> {
  const next = new Map<string, number>()
  for (const t of list) if (t.status === 'in_progress') next.set(taskKey(t), prev.get(taskKey(t)) ?? now)
  return next
}

// $0.004 -> <$0.01, $3.456 -> $3.46, $1234.5 -> $1,235
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01'
  const cents = Math.round(usd * 100) / 100 // $99.999 is $100, so whole dollars
  if (cents < 100) return `$${cents.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString('en-US')}`
}

// ---- This session's share of the plan's limits (subscriptions) ----
// Claude Code reports each window's % used for the whole account. The first
// reading this session is the baseline; what it has climbed since is this
// session's share. When a window resets the % drops: bank what was used before
// the reset and count on from 0. ponytail: the baseline arrives after the first
// reply, so that reply goes uncounted, and use elsewhere on the account in the
// same window counts here too; Claude Code reports nothing finer.
type LimitUse = { base: number; last: number; banked: number }
const LIMIT_ROWS = [
  ['five_hour', '5-hour limit'],
  ['seven_day', 'Weekly limit'],
] as const

export function trackLimitUse(
  prev: Map<string, LimitUse>,
  readings: { kind: string; percentUsed: number }[],
): Map<string, LimitUse> {
  const next = new Map(prev)
  for (const { kind, percentUsed: p } of readings) {
    const u = prev.get(kind)
    if (!u) next.set(kind, { base: p, last: p, banked: 0 })
    else if (p < u.last) next.set(kind, { base: 0, last: p, banked: u.banked + (u.last - u.base) }) // window reset
    else next.set(kind, { ...u, last: p })
  }
  return next
}

export const sessionShare = (u: LimitUse) => u.banked + (u.last - u.base)

// +9%, +0.4%, <0.1%, 0%
export function formatShare(pct: number): string {
  if (pct <= 0) return '0%'
  if (pct < 0.1) return '<0.1%'
  return `+${pct < 10 ? +pct.toFixed(1) : Math.round(pct)}%`
}
