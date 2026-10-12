import type { DeckAgent } from '../types'

// Pure helpers: what a tool call means in words, how long is left, and the 3D
// scene as SVG. Nothing here touches `$`, so the tests call it directly.

export type Estimate = { text: string; fraction?: number }

export function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Fewer past runs than this and a type's typical length is not trusted. */
export const MIN_HISTORY = 3

/**
 * Time left, from the agent's own step list when it keeps one, else from how
 * long this agent type usually runs. Claude reports no progress of its own, so
 * every figure here is an estimate and says so.
 */
export function estimate(a: DeckAgent, now: number, typical: number[] | undefined): Estimate {
  if (a.status === 'done') return { text: 'finished', fraction: 1 }
  if (a.status === 'failed') return { text: 'failed' }
  if (a.status === 'stopped') return { text: 'stopped' }
  if (a.status === 'idle') return { text: 'waiting for a message' }

  const elapsed = a.startedAt === undefined ? undefined : now - a.startedAt
  const { stepsDone: done, stepsTotal: total } = a

  if (total > 0 && done >= total) {
    return { text: `${done}/${total} steps done, wrapping up`, fraction: 0.97 }
  }
  if (total > 0 && done > 0 && elapsed !== undefined) {
    const left = (elapsed / done) * (total - done)
    return { text: `~${fmt(left)} left (${done}/${total} steps)`, fraction: done / total }
  }

  const usual = (typical?.length ?? 0) >= MIN_HISTORY ? median(typical ?? []) : undefined
  if (usual !== undefined && elapsed !== undefined) {
    if (elapsed < usual) {
      return {
        text: `~${fmt(usual - elapsed)} left (a ${a.type} run usually takes ${fmt(usual)})`,
        fraction: elapsed / usual,
      }
    }
    return { text: `running past its usual ${fmt(usual)}; no estimate` }
  }
  if (total > 0) return { text: `0/${total} steps; estimate after the first`, fraction: 0 }
  if (elapsed === undefined) return { text: 'no estimate (it started before the deck loaded)' }

  return { text: 'no estimate yet (it keeps no step list, and too few past runs)' }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** One line on what a tool call is doing, in words. */
export function describeCall(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')

  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return str('description') || `Running ${clip(str('command'), 60)}`
    case 'Read':
      return `Reading ${base(str('file_path'))}`
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${base(str('file_path'))}`
    case 'Write':
      return `Writing ${base(str('file_path'))}`
    case 'NotebookEdit':
      return `Editing ${base(str('notebook_path'))}`
    case 'Grep':
      return `Searching the code for "${clip(str('pattern'), 40)}"`
    case 'Glob':
      return `Finding files ${clip(str('pattern'), 40)}`
    case 'WebFetch': {
      const url = str('url')
      const host = /^[a-z]+:\/\/([^/]+)/i.exec(url)?.[1] ?? url
      return `Reading ${clip(host, 50)}`
    }
    case 'WebSearch':
      return `Searching the web: ${clip(str('query'), 50)}`
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'Updating its step list'
    case 'Agent':
      return `Starting a helper: ${clip(str('description'), 50)}`
    case 'SendMessage':
      return 'Messaging another agent'
    case 'Skill':
      return `Using the ${str('skill')} skill`
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return `Using ${mcp[1]}: ${(mcp[2] ?? '').replace(/_/g, ' ')}`

  return `Using ${tool}`
}

type Steps = Pick<DeckAgent, 'stepsDone' | 'stepsTotal' | 'doneTaskIds'>

/** The step count after a step-list tool call; the same object for any other tool. */
export function nextSteps(a: Steps, tool: string, input: Record<string, unknown>): Steps {
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const todos = input.todos as Array<{ status?: unknown }>
    const done = todos.filter(t => t?.status === 'completed').length
    return { ...a, stepsTotal: todos.length, stepsDone: done }
  }
  if (tool === 'TaskCreate') return { ...a, stepsTotal: a.stepsTotal + 1 }
  if (tool === 'TaskUpdate') {
    const id = String(input.taskId ?? input.id ?? '')
    if (input.status === 'completed' && !a.doneTaskIds.includes(id)) {
      return {
        ...a,
        stepsDone: Math.min(a.stepsDone + 1, Math.max(a.stepsTotal, a.stepsDone + 1)),
        stepsTotal: Math.max(a.stepsTotal, a.stepsDone + 1),
        doneTaskIds: [...a.doneTaskIds, id].slice(-200),
      }
    }
    if (input.status === 'deleted') return { ...a, stepsTotal: Math.max(a.stepsDone, a.stepsTotal - 1) }
  }

  return a
}

// ---------------------------------------------------------------------------
// The scene: a round stage seen from above at an angle. The main session sits
// in the middle, working agents stand around it as glass towers that fill with
// their progress, finished ones sit further out as small blocks, and the agent
// types that can be started wait on the rim. Real perspective projection,
// painter's-order faces, shading from a fixed light, so turning the camera
// (the pane's rotate buttons) shows the stage from another side.

export type SceneAgent = {
  n: number
  label: string
  status: DeckAgent['status']
  /** 0-1 when there is an estimate; absent draws a pulsing column. */
  fraction?: number
}

export type SceneInput = {
  running: SceneAgent[]
  finished: SceneAgent[]
  types: string[]
  isMainWorking: boolean
  /** Camera angle around the stage, in degrees. */
  yaw: number
}

type V3 = [number, number, number]
type P2 = { x: number; y: number; depth: number; k: number }

const W = 760
const H = 430
const PITCH = 0.62
const CAM = 15
const FOCAL = 560
const HORIZON = H * 0.6

const COLORS = {
  running: '#37d7ff',
  done: '#3ddc84',
  failed: '#ff5c7a',
  stopped: '#9aa4b2',
  idle: '#f5b14c',
  type: '#7b86a6',
  main: '#b48cff',
  mainIdle: '#6a6f8a',
} as const

function project([x, y, z]: V3, yaw: number): P2 {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const x1 = x * c - z * s
  const z1 = x * s + z * c
  const cp = Math.cos(PITCH)
  const sp = Math.sin(PITCH)
  const y2 = y * cp + z1 * sp
  const z2 = z1 * cp - y * sp + CAM
  const k = FOCAL / z2

  return { x: W / 2 + x1 * k, y: HORIZON - y2 * k, depth: z2, k }
}

function shade(hex: string, f: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)))
  const r = ch((n >> 16) & 255)
  const g = ch((n >> 8) & 255)
  const b = ch(n & 255)

  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
}

const pts = (ps: P2[]) => ps.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

type Face = { depth: number; svg: string }

const LIGHT: V3 = (() => {
  const v: V3 = [-0.45, 0.8, -0.4]
  const len = Math.hypot(...v)
  return [v[0] / len, v[1] / len, v[2] / len]
})()

/** The visible faces of an upright box standing on y0, shaded and sorted later. */
function box(
  cx: number,
  cz: number,
  half: number,
  y0: number,
  y1: number,
  color: string,
  yaw: number,
  opts: { opacity?: number; cls?: string; stroke?: string; title?: string } = {},
): Face[] {
  const corners: Array<[number, number]> = [
    [cx - half, cz - half],
    [cx + half, cz - half],
    [cx + half, cz + half],
    [cx - half, cz + half],
  ]
  const bottom = corners.map(([x, z]) => project([x, y0, z], yaw))
  const top = corners.map(([x, z]) => project([x, y1, z], yaw))
  const normals: V3[] = [
    [0, 0, -1],
    [1, 0, 0],
    [0, 0, 1],
    [-1, 0, 0],
  ]
  const attrs = [
    opts.opacity !== undefined ? `fill-opacity="${opts.opacity}"` : '',
    opts.cls ? `class="${opts.cls}"` : '',
    `stroke="${opts.stroke ?? shade(color, 1.25)}" stroke-opacity="0.55" stroke-width="0.8" stroke-linejoin="round"`,
  ].join(' ')
  const tip = opts.title ? `<title>${esc(opts.title)}</title>` : ''
  const faces: Face[] = []

  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    const quad = [bottom[i], bottom[j], top[j], top[i]] as P2[]
    // Back faces turn clockwise on screen: skip them.
    const area =
      (quad[1]!.x - quad[0]!.x) * (quad[2]!.y - quad[0]!.y) -
      (quad[2]!.x - quad[0]!.x) * (quad[1]!.y - quad[0]!.y)
    if (area > 0) continue
    const n = normals[i]!
    const lit = 0.42 + 0.58 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2])
    faces.push({
      depth: quad.reduce((s, p) => s + p.depth, 0) / 4,
      svg: `<polygon points="${pts(quad)}" fill="${shade(color, lit)}" ${attrs}>${tip}</polygon>`,
    })
  }
  faces.push({
    depth: top.reduce((s, p) => s + p.depth, 0) / 4 - 0.01,
    svg: `<polygon points="${pts(top)}" fill="${shade(color, 1.18)}" ${attrs}>${tip}</polygon>`,
  })

  return faces
}

function ring(r: number, y: number, yaw: number, cx = 0, cz = 0, n = 72): P2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    return project([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r], yaw)
  })
}

function around(count: number, radius: number, offset: number): Array<[number, number]> {
  if (count === 1 && radius < 3) return [[0, radius]]
  return Array.from({ length: count }, (_, i) => {
    const a = offset + (i / count) * Math.PI * 2
    return [Math.cos(a) * radius, Math.sin(a) * radius]
  })
}

function label(p: P2, text: string, opts: { size: number; color: string; weight?: number; cls?: string }): string {
  return `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" font-size="${opts.size}" font-weight="${opts.weight ?? 500}" fill="${opts.color}" text-anchor="middle" class="lbl ${opts.cls ?? ''}">${esc(text)}</text>`
}

const STYLE = `
.lbl{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;paint-order:stroke;stroke:#070b16;stroke-width:3px;stroke-linejoin:round}
.pulse{animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.45}50%{opacity:1}}
.spin{stroke-dasharray:5 7;animation:spin 2.4s linear infinite}
@keyframes spin{to{stroke-dashoffset:-48}}
.bob{animation:bob 3.2s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
.beam{animation:beam 2.2s ease-in-out infinite}
@keyframes beam{0%,100%{opacity:.15}50%{opacity:.6}}
@media (prefers-reduced-motion:reduce){.pulse,.spin,.bob,.beam{animation:none}}
`

/** The whole scene as one SVG document. */
export function buildScene(s: SceneInput): string {
  const yaw = (s.yaw * Math.PI) / 180
  const back: string[] = []
  // Whole objects are sorted far to near by where they stand on the floor
  // (they never overlap there), so a tall tower's faces cannot cut in front
  // of a block behind it, as sorting single faces would.
  const objects: Array<{ depth: number; faces: Face[] }> = []
  const put = (x: number, z: number, ...parts: Face[][]) =>
    objects.push({ depth: project([x, 0, z], yaw).depth, faces: parts.flat() })
  const labels: Array<{ depth: number; svg: string }> = []

  // Stage: a dark disc with a lit rim and a faint grid.
  const STAGE = 7.4
  back.push(`<polygon points="${pts(ring(STAGE, -0.35, yaw))}" fill="#0c1428" stroke="#1d2b52" stroke-width="1"/>`)
  back.push(`<polygon points="${pts(ring(STAGE, 0, yaw))}" fill="url(#floor)" stroke="#3a5bb5" stroke-opacity="0.7" stroke-width="1.2"/>`)
  for (const r of [2.4, 4.8]) {
    back.push(`<polygon points="${pts(ring(r, 0, yaw))}" fill="none" stroke="#3a5bb5" stroke-opacity="0.22" stroke-width="1"/>`)
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    const p = project([Math.cos(a) * 1.2, 0, Math.sin(a) * 1.2], yaw)
    const q = project([Math.cos(a) * STAGE, 0, Math.sin(a) * STAGE], yaw)
    back.push(`<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke="#3a5bb5" stroke-opacity="0.13"/>`)
  }

  // The main session in the middle.
  const mainColor = s.isMainWorking ? COLORS.main : COLORS.mainIdle
  put(
    0,
    0,
    box(0, 0, 0.75, 0, 0.5, mainColor, yaw, { title: 'Main session' }),
    box(0, 0, 0.45, 0.5, 0.95, mainColor, yaw, { cls: s.isMainWorking ? 'pulse' : undefined }),
  )
  const mainTop = project([0, 1.25, 0], yaw)
  labels.push({
    depth: mainTop.depth,
    svg: label(mainTop, s.isMainWorking ? 'Main session · working' : 'Main session · waiting for you', {
      size: 12,
      color: s.isMainWorking ? '#d9c6ff' : '#a9aecb',
    }),
  })

  // Working agents: glass towers around the middle that fill as they go.
  const TOWER = 3.1
  around(s.running.length, s.running.length === 1 ? 2.9 : 3.0, -Math.PI / 2).forEach(([x, z], i) => {
    const a = s.running[i]!
    const color = a.status === 'idle' ? COLORS.idle : COLORS.running
    const floor = ring(0.95, 0.02, yaw, x, z, 40)
    back.push(`<polygon points="${pts(floor)}" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-opacity="0.75" stroke-width="1.4" class="spin"/>`)
    const fill =
      a.fraction === undefined
        ? box(x, z, 0.4, 0.12, 0.12 + TOWER * 0.92, color, yaw, { opacity: 0.55, cls: 'pulse' })
        : box(x, z, 0.4, 0.12, 0.12 + Math.max(0.08, Math.min(1, a.fraction)) * TOWER * 0.92, color, yaw, {
            opacity: 0.92,
          })
    put(
      x,
      z,
      box(x, z, 0.6, 0, 0.12, '#1b2747', yaw),
      fill,
      box(x, z, 0.5, 0.12, 0.12 + TOWER, '#9fdcff', yaw, {
        opacity: 0.07,
        stroke: '#bfe9ff',
        title: `#${a.n} ${a.label}`,
      }),
    )
    const base0 = project([x, 0.12 + TOWER, z], yaw)
    const beamTop = project([x, 0.12 + TOWER + 1.1, z], yaw)
    labels.push({
      depth: base0.depth + 0.5,
      svg: `<line x1="${base0.x.toFixed(1)}" y1="${base0.y.toFixed(1)}" x2="${beamTop.x.toFixed(1)}" y2="${beamTop.y.toFixed(1)}" stroke="${color}" stroke-width="2" class="beam"/>`,
    })
    const tag = project([x, 0.12 + TOWER + 0.55, z], yaw)
    const pct = a.fraction === undefined ? '' : ` · ${Math.round(a.fraction * 100)}%`
    labels.push({
      depth: tag.depth,
      svg: `<g class="bob">${label({ ...tag, y: tag.y - 14 }, `#${a.n}${pct}`, { size: 15, weight: 700, color })}${label(tag, clip(a.label, 26), { size: 12, color: '#e6f6ff' })}</g>`,
    })
  })

  // Finished agents: small blocks further out.
  around(s.finished.length, 5.2, Math.PI / 2 + 0.35).forEach(([x, z], i) => {
    const a = s.finished[i]!
    const color = COLORS[a.status === 'done' ? 'done' : a.status === 'failed' ? 'failed' : 'stopped']
    put(x, z, box(x, z, 0.38, 0, 0.55, color, yaw, { opacity: 0.85, title: `${a.label} (${a.status})` }))
    const tag = project([x, 0.95, z], yaw)
    const mark = a.status === 'done' ? '✓' : a.status === 'failed' ? '✕' : '■'
    labels.push({ depth: tag.depth, svg: label(tag, `${mark} ${clip(a.label, 20)}`, { size: 10, color: shade(color, 1.1) }) })
  })

  // Agent types that can be started: pedestals on the rim.
  const shown = s.types.slice(0, 12)
  around(shown.length, 6.55, -Math.PI / 2 + Math.PI / Math.max(1, shown.length)).forEach(([x, z], i) => {
    const name = shown[i]!
    put(x, z, box(x, z, 0.3, 0, 0.3, COLORS.type, yaw, { opacity: 0.9, title: `${name}: ready to start` }))
    const tag = project([x, 0.62, z], yaw)
    labels.push({ depth: tag.depth, svg: label(tag, clip(name, 18), { size: 10, color: '#aab4d4' }) })
  })

  objects.sort((a, b) => b.depth - a.depth)
  labels.sort((a, b) => b.depth - a.depth)

  const working = s.running.filter(a => a.status === 'running').length
  const more = s.types.length > shown.length ? ` (+${s.types.length - shown.length} more)` : ''
  const headline = `${working} working · ${s.types.length} type${s.types.length === 1 ? '' : 's'} ready${more} · ${s.finished.length} finished`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<style>${STYLE}</style>`,
    '<defs>',
    '<radialGradient id="sky" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#16224a"/><stop offset="1" stop-color="#05080f"/></radialGradient>',
    '<radialGradient id="floor" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#1c2d63"/><stop offset="1" stop-color="#0d1530"/></radialGradient>',
    '</defs>',
    `<rect width="${W}" height="${H}" rx="14" fill="url(#sky)"/>`,
    ...back,
    ...objects.flatMap(o => o.faces.map(f => f.svg)),
    ...labels.map(l => l.svg),
    `<text x="20" y="30" font-size="13" font-weight="700" fill="#e6ecff" class="lbl" letter-spacing="2">AGENT DECK</text>`,
    `<text x="20" y="50" font-size="12" fill="#9fb0d9" class="lbl">${esc(headline)}</text>`,
    s.running.length === 0
      ? `<text x="${W / 2}" y="${H - 22}" font-size="12" fill="#8592b8" text-anchor="middle" class="lbl">No agents working. Towers appear here when Claude starts one.</text>`
      : '',
    '</svg>',
  ].join('')
}
