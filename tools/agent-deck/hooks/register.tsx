import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { DeckAgent, DeckStatus } from '../types'
import { buildScene, describeCall, estimate, fmt, nextSteps } from './scene'

const PANE = 'agent-deck'
const TITLE = 'Agent deck'
const HISTORY_KEY = 'typical-durations'
const KEEP_FINISHED = 8
const TICK_MS = 2000

const agents = atom({ plugin: 'agent-deck', key: 'agents' } as const, {})
const types = atom({ plugin: 'agent-deck', key: 'types' } as const, [])
const yaw = atom({ plugin: 'agent-deck', key: 'yaw' } as const, 25)
const now = atom({ plugin: 'agent-deck', key: 'now' } as const, 0)
const history = atom({ plugin: 'agent-deck', key: 'history' } as const, {})
const main = atom({ plugin: 'agent-deck', key: 'main' } as const, { isWorking: false, since: 0 })

type Agents = Record<string, DeckAgent>

const isLive = (s: DeckStatus) => s === 'running' || s === 'idle'

function fromEngine(status: AgentInfo['status']): DeckStatus {
  switch (status) {
    case 'idle':
      return 'idle'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'stopped'
    default:
      return 'running'
  }
}

function fresh(id: string, type: string, description: string, startedAt?: number): DeckAgent {
  return {
    id,
    type,
    description: description || type,
    status: 'running',
    startedAt,
    tools: 0,
    stepsDone: 0,
    stepsTotal: 0,
    doneTaskIds: [],
    isListed: false,
  }
}

/** Keeps every live agent and the newest finished ones. */
function prune(map: Agents): Agents {
  const finished = Object.values(map)
    .filter(a => !isLive(a.status))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, KEEP_FINISHED)
    .map(a => a.id)

  return Object.fromEntries(Object.entries(map).filter(([id, a]) => isLive(a.status) || finished.includes(id)))
}

/**
 * Folds the engine's own list into ours: agents started before the deck loaded
 * appear (with no start time), and the engine's word on status wins. A tracked
 * agent the engine has listed and then dropped has finished.
 */
export function reconcile(map: Agents, list: AgentInfo[], t: number): Agents | undefined {
  let changed = false
  const out: Agents = { ...map }
  const ids = new Set(list.map(info => info.id))

  for (const info of list) {
    const status = fromEngine(info.status)
    const cur = out[info.id]
    if (!cur) {
      out[info.id] = {
        ...fresh(info.id, info.type, info.description),
        status,
        isListed: true,
        endedAt: isLive(status) ? undefined : t,
      }
      changed = true
    } else if (cur.status !== status || !cur.isListed) {
      out[info.id] = {
        ...cur,
        status,
        isListed: true,
        endedAt: isLive(status) ? undefined : (cur.endedAt ?? t),
      }
      changed = true
    }
  }
  for (const a of Object.values(out)) {
    if (isLive(a.status) && a.isListed && !ids.has(a.id)) {
      out[a.id] = { ...a, status: 'done', endedAt: t }
      changed = true
    }
  }

  return changed ? prune(out) : undefined
}

async function tick($: EngineInterface) {
  const [list, t, known, m] = await Promise.all([$.agent.list(), $.clock.now(), read($, agents), read($, main)])
  if (reconcile(known, list, t)) {
    await update($, agents, cur => reconcile(cur, list, t) ?? cur)
  }
  const isBusy = m.isWorking || Object.values(await read($, agents)).some(a => isLive(a.status))
  if (isBusy) await update($, now, () => t)
}

// Timers end with the module, so a reload starts this afresh.
let ticking = false

/** Starts the refresh once; from session start, or the first open when the deck was installed mid-session. */
function ensureTicking($: EngineInterface) {
  if (ticking) return
  ticking = true
  try {
    $.clock.every(TICK_MS, () => {
      void tick($).catch(() => undefined)
    })
  } catch {
    ticking = false
  }
}

async function remember($: EngineInterface, type: string, ms: number) {
  const all = await read($, history)
  const next = { ...all, [type]: [...(all[type] ?? []), ms].slice(-20) }
  await update($, history, () => next)
  await $.store.set(HISTORY_KEY, next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-deck',
      description: "Open the 3D view of this session's agents",
    })
    const stored = await $.store.get(HISTORY_KEY)
    if (stored && typeof stored === 'object') {
      await update($, history, () => stored as Record<string, number[]>)
    }
    const startAt = await $.clock.now()
    await update($, now, () => startAt)
    void $.ui.open({ id: PANE, title: TITLE })
    ensureTicking($)

    return next(e)
  })

  on('command.run', { command: 'agent-deck' }, async $ => {
    ensureTicking($)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Agent deck opened.' }
  })

  // Agent types the model can start: the deck's "ready" rim.
  on('agent.offer', async ($, e, next) => {
    const offered = await next(e)
    try {
      const list = await read($, types)
      if (offered.isOffered && !list.some(t => t.name === e.agent)) {
        await update($, types, cur =>
          cur.some(t => t.name === e.agent)
            ? cur
            : [...cur, { name: e.agent, description: e.description, source: e.source }].slice(0, 60),
        )
      }
    } catch {
      // The deck is a view; it never stands in the way of an offer.
    }

    return offered
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    try {
      const id = started.agentId
      if (id) {
        const t = await $.clock.now()
        await update($, agents, cur =>
          prune({ ...cur, [id]: { ...fresh(id, e.subagentType, e.description, t), ...pick(cur[id]) } }),
        )
        await update($, now, () => t)
      }
    } catch {
      // As above: never in the way of a spawn.
    }

    return started
  })

  on('tool.call', async ($, e, next) => {
    try {
      const tool = String(e.tool)
      const input = e as unknown as Record<string, unknown>
      const action = describeCall(tool, input)
      const id = e.agentId
      if (id) {
        await update($, agents, cur => {
          const a = cur[id]
          if (!a) return cur
          return {
            ...cur,
            [id]: {
              ...a,
              ...nextSteps(a, tool, input),
              action,
              tools: a.tools + 1,
              status: a.status === 'idle' || !isLive(a.status) ? 'running' : a.status,
              endedAt: undefined,
            },
          }
        })
      } else {
        await update($, main, m => ({ ...m, isWorking: true, action }))
      }
    } catch {
      // A view only: the tool runs whatever happens here.
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    try {
      const t = await $.clock.now()
      await update($, main, () => ({ isWorking: true, since: t }))
    } catch {
      // A view only.
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    try {
      const t = await $.clock.now()
      const id = e.agentId
      if (id) {
        const a = (await read($, agents))[id]
        const status: DeckStatus = e.isAborted ? 'stopped' : e.reason === 'answer' ? 'done' : 'failed'
        if (a) {
          await update($, agents, cur => (cur[id] ? prune({ ...cur, [id]: { ...cur[id], status, endedAt: t } }) : cur))
          if (status === 'done' && e.durationMs > 0) await remember($, a.type, e.durationMs)
        }
      } else {
        await update($, main, () => ({ isWorking: false, since: t }))
      }
    } catch {
      // A view only.
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [map, ty, angle, t, hist, m] = await Promise.all([
      read($, agents),
      read($, types),
      read($, yaw),
      read($, now),
      read($, history),
      read($, main),
    ])
    const live = Object.values(map)
      .filter(a => isLive(a.status))
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    const finished = Object.values(map)
      .filter(a => !isLive(a.status))
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    const rows = live.map((a, i) => ({ a, n: i + 1, est: estimate(a, t, hist[a.type]) }))

    // A terminal without fullscreen seats the pane above the prompt: keep it to a few lines there.
    if (e.surface === 'terminal' && e.props.placement === 'inline') {
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold>Agent deck</Text>
            <Text dimColor>
              {' '}
              · main {m.isWorking ? 'working' : 'waiting'} · {rows.length} working · {ty.length} ready ·{' '}
              {finished.length} finished
            </Text>
          </Text>
          {rows.map(({ a, n, est }) => (
            <Text key={`c-${a.id}`} wrap="truncate-end">
              <Text color="cyan">#{n}</Text> {a.description} <Text dimColor>· {a.action ?? 'starting up'} · {est.text}</Text>
            </Text>
          ))}
        </Box>
      )
    }

    let scene: unknown = null
    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const source = buildScene({
        running: rows.map(r => ({
          n: r.n,
          label: r.a.description,
          status: r.a.status,
          // Coarse steps, so the picture is redrawn when progress moves, not every tick.
          fraction: r.est.fraction === undefined ? undefined : Math.floor(r.est.fraction * 20) / 20,
        })),
        finished: finished.map((a, i) => ({ n: i + 1, label: a.description, status: a.status })),
        types: ty.map(x => x.name),
        isMainWorking: m.isWorking,
        yaw: angle,
      })
      const alt = `${rows.length} agents working: ${rows.map(r => r.a.description).join(', ') || 'none'}. ${ty.length} agent types ready.`
      scene = <Svg key="scene" source={source} alt={alt} isInteractive />
    }

    return (
      <Box flexDirection="column">
        {scene as never}
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Button key="left" label="◀ Turn" onPress={() => void update($, yaw, y => (y + 330) % 360)} />
          <Button key="right" label="Turn ▶" onPress={() => void update($, yaw, y => (y + 30) % 360)} />
          {finished.length > 0 && (
            <Button
              key="clear"
              label="Clear finished"
              dimColor
              onPress={() =>
                void update($, agents, cur =>
                  Object.fromEntries(Object.entries(cur).filter(([, a]) => isLive(a.status))),
                )
              }
            />
          )}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Main session</Text>
          <Text dimColor>
            {m.isWorking ? `Working${m.action ? `: ${m.action}` : ''}` : 'Waiting for you'}
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Working now ({rows.length})</Text>
          {rows.length === 0 && <Text dimColor>No agents working.</Text>}
          {rows.map(({ a, n, est }) => (
            <Box key={`a-${a.id}`} flexDirection="column" marginTop={1}>
              <Text color="cyan" bold>
                #{n} {a.description} <Text dimColor>· {a.type}</Text>
              </Text>
              <Text>  Now: {a.status === 'idle' ? 'waiting for a message' : (a.action ?? 'starting up')}</Text>
              <Text dimColor>
                {'  '}
                {a.startedAt === undefined ? 'started before the deck loaded' : `${fmt(t - a.startedAt)} so far`} ·{' '}
                {est.text} · {a.tools} tool calls
              </Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Ready to start ({ty.length})</Text>
          <Text dimColor wrap="wrap">
            {ty.length === 0
              ? 'Listed after the first turn: the types Claude can hand work to.'
              : ty.map(x => x.name).join(' · ')}
          </Text>
        </Box>

        {finished.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Finished</Text>
            {finished.map(a => (
              <Text key={`f-${a.id}`} dimColor>
                {a.status === 'done' ? '✓' : a.status === 'failed' ? '✕' : '■'} {a.description}
                {a.startedAt !== undefined && a.endedAt !== undefined ? ` · took ${fmt(a.endedAt - a.startedAt)}` : ''}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}

/** What a re-spawn under the same id keeps of the earlier record. */
function pick(a: DeckAgent | undefined): Partial<DeckAgent> {
  return a ? { isListed: a.isListed } : {}
}
