import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentInfo } from 'claude-code'

import type { DeckAgent } from '../types'
import { cloudAgents, cloudSession, cloudSessions, cloudState } from '../hooks/cloud'
import { fetchCloud, reconcile } from '../hooks/register'
import { buildScene, describeCall, estimate, nextSteps } from '../hooks/scene'
import { decode, decodeFile, encode, fileUrl, merge, openCommands, sessionEntry } from '../hooks/window'

const PANE = {
  component: 'Pane',
  requestId: 'agent-deck',
  props: {
    title: 'Agent deck',
    isFocused: false,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const agent = (over: Partial<DeckAgent> = {}): DeckAgent => ({
  id: 'a1',
  type: 'general-purpose',
  description: 'Render promo videos',
  status: 'running',
  startedAt: 0,
  tools: 0,
  stepsDone: 0,
  stepsTotal: 0,
  doneTaskIds: [],
  isListed: false,
  ...over,
})

describe('time left', () => {
  test('comes from the step list when the agent keeps one', async () => {
    const est = estimate(agent({ stepsDone: 2, stepsTotal: 6 }), 4 * 60_000, undefined)
    expect(est.text).toBe('~8m 00s left (2/6 steps)')
    expect(Math.abs((est.fraction ?? 0) - 1 / 3)).toBeLessThan(1e-9)
  })

  test('falls back to how long the type usually runs, and only with 3 runs or more', async () => {
    const usual = [10 * 60_000, 12 * 60_000, 14 * 60_000]
    expect(estimate(agent(), 2 * 60_000, usual).text).toBe(
      '~10m 00s left (a general-purpose run usually takes 12m 00s)',
    )
    expect(estimate(agent(), 2 * 60_000, usual.slice(0, 2)).fraction).toBeUndefined()
    expect(estimate(agent(), 20 * 60_000, usual).text).toContain('running past its usual')
  })

  test('says so when there is nothing to estimate from', async () => {
    expect(estimate(agent(), 1000, undefined).text).toContain('no estimate yet')
    expect(estimate(agent({ startedAt: undefined }), 1000, undefined).text).toBe('no estimate yet')
  })
})

describe('steps', () => {
  test('TodoWrite sets the count, TaskCreate and TaskUpdate move it', async () => {
    const a = agent()
    const todo = nextSteps(a, 'TodoWrite', {
      todos: [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }],
    })
    expect([todo.stepsDone, todo.stepsTotal]).toEqual([1, 3])

    let s = nextSteps(a, 'TaskCreate', { subject: 'one' })
    s = nextSteps(s, 'TaskCreate', { subject: 'two' })
    s = nextSteps(s, 'TaskUpdate', { taskId: '1', status: 'completed' })
    s = nextSteps(s, 'TaskUpdate', { taskId: '1', status: 'completed' })
    expect([s.stepsDone, s.stepsTotal]).toEqual([1, 2])
    expect(nextSteps(a, 'Bash', { command: 'ls' })).toBe(a)
  })
})

describe('what it is doing', () => {
  test('reads as words', async () => {
    expect(describeCall('Bash', { command: 'ffmpeg -i a.mp4', description: 'Render the 15s cut' })).toBe(
      'Render the 15s cut',
    )
    expect(describeCall('Read', { file_path: 'C:\\Users\\yashy\\site\\promo-make.py' })).toBe('Reading promo-make.py')
    expect(describeCall('mcp__github__get_file_contents', {})).toBe('Using github: get file contents')
  })
})

describe('the engine list', () => {
  const info = (over: Partial<AgentInfo>): AgentInfo => ({
    id: 'b1',
    description: 'Earlier agent',
    type: 'Explore',
    status: 'running',
    ...over,
  })

  test('adds agents started before the deck loaded, and finishes ones it dropped', async () => {
    const added = reconcile({}, [info({})], 5000)
    expect(added?.b1?.startedAt).toBeUndefined()
    expect(added?.b1?.isListed).toBe(true)
    expect(reconcile(added ?? {}, [info({})], 6000)).toBeUndefined()

    const dropped = reconcile(added ?? {}, [], 7000)
    expect(dropped?.b1?.status).toBe('done')
    expect(dropped?.b1?.endedAt).toBe(7000)
  })
})

describe('scene', () => {
  test('is one SVG document with its labels escaped', async () => {
    const svg = buildScene({
      running: [{ n: 1, label: 'Fix <b> & "quotes"', status: 'running', fraction: 0.5 }],
      finished: [{ n: 1, label: 'Done one', status: 'done' }],
      types: ['general-purpose', 'Explore'],
      isMainWorking: true,
      yaw: 25,
    })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).not.toContain('<b>')
    expect(svg).toContain('1 working · 2 types ready · 1 finished')
    expect(svg.length).toBeLessThan(131_072)
  })

  test('stays under the Svg size limit with a crowd', async () => {
    const running = Array.from({ length: 12 }, (_, i) => ({
      n: i + 1,
      label: `Agent number ${i} doing a long task`,
      status: 'running' as const,
    }))
    const finished = Array.from({ length: 8 }, (_, i) => ({ n: i, label: `Done ${i}`, status: 'done' as const }))
    const types = Array.from({ length: 40 }, (_, i) => `type-${i}`)
    expect(buildScene({ running, finished, types, isMainWorking: true, yaw: 0 }).length).toBeLessThan(131_072)
  })
})

test('a spawned agent shows in the pane on every surface', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'a1' }))

  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'Make the videos',
    description: 'Render promo videos',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'test-model',
    background: true,
    fork: false,
  })

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-deck', surface, ...PANE })
    expect((await ui.find({ type: 'Text', text: /Working now \(1\)/ }))?.text).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#1 Render promo videos/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no estimate yet/ })).toBeDefined()
    const svg = await ui.find({ type: 'Svg' })
    if (surface === 'terminal') expect(svg).toBeUndefined()
    else expect(String(svg?.props.source)).toContain('Render promo videos')
    await ui.unmount()
  }
})

test('the turn buttons turn the camera', async $ => {
  const ui = await $.ui.mount({ plugin: 'agent-deck', surface: 'desktop', ...PANE })
  const before = String((await ui.find({ type: 'Svg' }))?.props.source)
  await ui.press({ key: 'right' })
  const after = String((await ui.find({ type: 'Svg' }))?.props.source)
  expect(after).not.toBe(before)
  await ui.unmount()
})

test('an inline terminal pane stays a few lines', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'a1' }))
  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'Make the videos',
    description: 'Render promo videos',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'test-model',
    background: true,
    fork: false,
  })
  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'terminal',
    ...PANE,
    props: { ...PANE.props, placement: 'inline' },
  })
  expect(await ui.find({ type: 'Text', text: /1 working/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#1 Render promo videos/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})

describe('the pop-out window', () => {
  const entry = (id: string, updatedAt: number) => ({
    id,
    name: id,
    updatedAt,
    main: { isWorking: false },
    types: [],
    agents: [],
  })

  test('its data file round-trips, and stale or removed sessions drop out', async () => {
    const text = encode({ s1: entry('s1', 1000), s2: entry('s2', 1000) })
    expect(text.startsWith('window.__deckData && window.__deckData(')).toBe(true)
    expect(Object.keys(decode(text))).toEqual(['s1', 's2'])
    expect(decode('garbage')).toEqual({})

    const merged = merge(decode(text), 's3', entry('s3', 70_000), 70_000)
    expect(Object.keys(merged)).toEqual(['s3'])
    const kept = merge(decode(text), 's1', undefined, 2000)
    expect(Object.keys(kept)).toEqual(['s2'])
  })

  test('a session entry numbers working agents first and carries their estimate', async () => {
    const e = sessionEntry({
      id: 's1',
      name: 'site',
      now: 10 * 60_000,
      agents: [
        agent({ id: 'x', status: 'done', endedAt: 5 }),
        agent({ id: 'y', stepsDone: 1, stepsTotal: 2, startedAt: 9 * 60_000 }),
      ],
      types: [{ name: 'Explore', description: '', source: 'built-in' }],
      main: { isWorking: true, action: 'Reading a.ts', since: 0 },
      history: {},
    })
    expect(e.agents.map(a => [a.id, a.n])).toEqual([
      ['y', 1],
      ['x', 1],
    ])
    expect(e.agents[0]?.est.text).toBe('~1m 00s left (1/2 steps)')
    expect(e.types).toEqual(['Explore'])
  })

  test('it opens as an app window first, the default browser last', async () => {
    const win = openCommands('windows', 'C:/Users/yoshi/.claude/agent-deck/index.html')
    expect(win[0]?.[4]).toContain("--app=file:///C:/Users/yoshi/.claude/agent-deck/index.html")
    expect(win.at(-1)).toEqual(['explorer.exe', 'C:\\Users\\yoshi\\.claude\\agent-deck\\index.html'])
    expect(fileUrl('/Users/yoshi/My Deck/index.html')).toBe('file:///Users/yoshi/My%20Deck/index.html')
    expect(openCommands('linux', '/home/y/index.html')).toEqual([['xdg-open', '/home/y/index.html']])
  })
})

describe('cloud sessions', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'session_1',
    title: 'Port the mixer',
    status: 'idle',
    worker_status: 'running',
    environment_kind: 'anthropic_cloud',
    connection_status: 'connected',
    created_at: '2026-10-12T05:00:00Z',
    last_event_at: '2026-10-12T06:00:00Z',
    config: { sources: [{ type: 'git_repository', url: 'https://github.com/someone/mixer' }] },
    ...over,
  })

  test('are read the way Claude Code reads them', async () => {
    expect(cloudState(row())).toBe('working')
    expect(cloudState(row({ worker_status: 'requires_action' }))).toBe('blocked')
    expect(cloudState(row({ connection_status: 'disconnected' }))).toBe('stopped')
    expect(cloudState(row({ worker_status: 'idle', status_bucket: 'blocked' }))).toBe('blocked')
    expect(cloudState(row({ worker_status: 'idle', status_bucket: 'SESSION_STATUS_BUCKET_FAILED' }))).toBe('failed')
    expect(cloudState(row({ worker_status: 'idle' }))).toBe('done')
    expect(cloudState(row({ status: 'archived' }))).toBe('archived')
  })

  test('a row says where it runs, its project and what it needs', async () => {
    const local = cloudSession(row({
      environment_kind: 'bridge',
      connection_status: 'disconnected',
      worker_status: 'idle',
      status_bucket: 'blocked',
      config: {},
      external_metadata: {
        current_branches: { 'someone/licence-server': 'master' },
        worktree_state: { 'someone/licence-server': {} },
        post_turn_summary: { needs_action: 'Pick a price' },
      },
    }))
    expect(local).toMatchObject({ place: 'local', offline: true, state: 'blocked', repo: 'licence-server', branch: 'master', needs: 'Pick a price' })
    expect(cloudSession(row())?.repo).toBe('mixer')
    const listed = cloudSessions(JSON.stringify({ data: [row(), row({ id: 'session_2', status: 'archived' })] }))
    expect(listed.map(x => x.id)).toEqual(['session_1'])
    expect(cloudSessions('not json')).toEqual([])
  })

  test('agents come from the history: who they are, what they did last, how they ended', async () => {
    const at = (s: number) => new Date(1_000_000 + s * 1000).toISOString()
    const ev = (s: number, payload: Record<string, unknown>) => ({ created_at: at(s), payload })
    const use = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) => ({
      type: 'assistant',
      parent_tool_use_id: parent,
      message: { content: [{ type: 'tool_use', id, name, input }] },
    })
    // Newest first, as the events route answers with sort_order=desc.
    const events = [
      ev(50, use('t9', 'Bash', { description: 'Run the audio tests' })),
      ev(40, use('t4', 'Write', { file_path: '/r/test/gain.test.ts' }, 'ag2')),
      ev(30, { type: 'system', subtype: 'task_notification', task_id: 'k1', tool_use_id: 'ag1', status: 'completed' }),
      ev(20, use('t3', 'Grep', { pattern: 'AudioContext' }, 'ag1')),
      ev(12, use('ag2', 'Agent', { description: 'Write gain tests', subagent_type: 'general-purpose' })),
      ev(10, use('ag1', 'Agent', { description: 'Measure latency', subagent_type: 'Explore' })),
    ]
    const read = cloudAgents(events, 1_000_000 + 60_000)
    expect(read.doing).toBe('Run the audio tests')
    expect(read.agents.map(a => [a.description, a.type, a.status, a.action])).toEqual([
      ['Write gain tests', 'general-purpose', 'running', 'Writing gain.test.ts'],
      ['Measure latency', 'Explore', 'done', 'Searching for "AudioContext"'],
    ])
    expect(read.activity).toHaveLength(6)
  })

  test('the data file keeps the cloud list when a session writes its own entry', async () => {
    const cloud = { fetchedAt: 5, sessions: [{ id: 'session_1', title: 'x', place: 'cloud' as const, offline: false, state: 'done' as const, updatedAt: 1, createdAt: 1 }] }
    const file = decodeFile(encode({}, cloud))
    expect(file.cloud?.sessions.map(x => x.id)).toEqual(['session_1'])
    expect(decodeFile(encode({})).cloud).toBeUndefined()
  })
})

type Fetch = (url: string, init?: { auth?: string }) => { status: number; ok: boolean; headers: Record<string, string>; text: string }
const engine = (authorized: boolean, fetch: Fetch) => ({
  session: { authorize: async () => (authorized ? { handle: 'h1', kind: 'bearer' as const } : null) },
  http: { fetch: async (url: string, init?: { auth?: string }) => fetch(url, init) },
})

test('the cloud list is fetched as the signed-in person, histories only for working sessions', async () => {
  const asked: string[] = []
  const $ = engine(true, (url, init) => {
    asked.push(url)
    expect(init?.auth).toBe('h1')
    const body = url.includes('/events')
      ? { data: [{ created_at: new Date(1_000_000).toISOString(), payload: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'Check the build' } }] } } }] }
      : {
          data: [
            { id: 'session_w', title: 'Working one', worker_status: 'running', created_at: '2026-10-12T05:00:00Z' },
            { id: 'session_i', title: 'Idle one', worker_status: 'idle', status_bucket: 'completed', created_at: '2026-10-12T05:00:00Z' },
          ],
        }
    return { status: 200, ok: true, headers: {}, text: JSON.stringify(body) }
  })
  const cloud = await fetchCloud($, 1_000_000 + 10_000, undefined)
  expect(cloud.error).toBeUndefined()
  expect(cloud.sessions.map(s => [s.id, s.state, s.agents?.map(a => a.description)])).toEqual([
    ['session_w', 'working', ['Check the build']],
    ['session_i', 'done', undefined],
  ])
  expect(asked).toEqual([
    'https://api.anthropic.com/v1/code/sessions?limit=100',
    'https://api.anthropic.com/v1/code/sessions/session_w/events?limit=80&sort_order=desc',
  ])
})

test('a refused cloud list keeps the last one and says why', async () => {
  const refused = engine(true, () => ({ status: 401, ok: false, headers: {}, text: '' }))
  const prev = { fetchedAt: 1, sessions: [{ id: 'session_1', title: 'x', place: 'cloud' as const, offline: false, state: 'done' as const, updatedAt: 1, createdAt: 1 }] }
  const cloud = await fetchCloud(refused, 2, prev)
  expect(cloud.error).toContain('/login')
  expect(cloud.sessions).toHaveLength(1)

  expect((await fetchCloud(engine(false, refused.http.fetch as never), 3, prev)).error).toContain('not signed in')
  expect((await fetchCloud({ session: {}, http: {} } as never, 4, prev)).error).toContain('Update Claude Code')
})
