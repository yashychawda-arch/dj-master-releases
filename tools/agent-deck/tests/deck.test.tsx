import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentInfo } from 'claude-code'

import type { DeckAgent } from '../types'
import { reconcile } from '../hooks/register'
import { buildScene, describeCall, estimate, nextSteps } from '../hooks/scene'
import { decode, encode, fileUrl, merge, openCommands, sessionEntry } from '../hooks/window'

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
