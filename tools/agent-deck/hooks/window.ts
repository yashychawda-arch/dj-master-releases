import type { DeckAgent, DeckMain, DeckType } from '../types'
import type { CloudBlock } from './cloud'
import { type Estimate, estimate } from './scene'

// The pop-out window: a page in the browser that reads `deck-data.js` beside it
// every second. Every session with the deck writes its own entry into that one
// file, so one window shows them all. Pure helpers here; the hooks module does
// the reading, writing and launching.

export type WindowAgent = {
  id: string
  n: number
  description: string
  type: string
  status: DeckAgent['status']
  action?: string
  startedAt?: number
  endedAt?: number
  tools: number
  est: Estimate
}

export type WindowSession = {
  id: string
  name: string
  updatedAt: number
  main: { isWorking: boolean; action?: string }
  types: string[]
  agents: WindowAgent[]
}

export type Sessions = Record<string, WindowSession>

/** The whole data file: each open session's own entry, and the account's cloud list when fetched. */
export type DeckFile = { sessions: Sessions; cloud?: CloudBlock }

/** A session's entry stops showing once it has not been written for this long. */
export const STALE_MS = 60_000
/** An unchanged session still writes this often, so the window knows it is alive. */
export const HEARTBEAT_MS = 10_000

const PREFIX = 'window.__deckData && window.__deckData('
const SUFFIX = ')\n'

const isLive = (a: DeckAgent) => a.status === 'running' || a.status === 'idle'

export function sessionEntry(input: {
  id: string
  name: string
  now: number
  agents: DeckAgent[]
  types: DeckType[]
  main: DeckMain
  history: Record<string, number[]>
}): WindowSession {
  const live = input.agents.filter(isLive).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  const finished = input.agents.filter(a => !isLive(a)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const row = (a: DeckAgent, n: number): WindowAgent => ({
    id: a.id,
    n,
    description: a.description,
    type: a.type,
    status: a.status,
    action: a.action,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    tools: a.tools,
    est: estimate(a, input.now, input.history[a.type]),
  })

  return {
    id: input.id,
    name: input.name,
    updatedAt: input.now,
    main: { isWorking: input.main.isWorking, action: input.main.action },
    types: input.types.map(t => t.name),
    agents: [...live.map((a, i) => row(a, i + 1)), ...finished.map((a, i) => row(a, i + 1))],
  }
}

export function encode(sessions: Sessions, cloud?: CloudBlock): string {
  return `${PREFIX}${JSON.stringify(cloud ? { v: 2, sessions, cloud } : { v: 2, sessions })}${SUFFIX}`
}

export function decodeFile(text: string): DeckFile {
  const start = text.indexOf('(')
  const end = text.lastIndexOf(')')
  if (start < 0 || end <= start) return { sessions: {} }
  try {
    const parsed = JSON.parse(text.slice(start + 1, end)) as { sessions?: Sessions; cloud?: CloudBlock }
    const sessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
    const cloud = parsed.cloud && typeof parsed.cloud === 'object' && Array.isArray(parsed.cloud.sessions) ? parsed.cloud : undefined
    return cloud ? { sessions, cloud } : { sessions }
  } catch {
    return { sessions: {} }
  }
}

export function decode(text: string): Sessions {
  return decodeFile(text).sessions
}

/** The file's sessions with this one's entry put in (or taken out, with no entry), stale ones dropped. */
export function merge(existing: Sessions, id: string, entry: WindowSession | undefined, now: number): Sessions {
  const out: Sessions = {}
  for (const [key, s] of Object.entries(existing)) {
    if (key !== id && now - (s?.updatedAt ?? 0) < STALE_MS) out[key] = s
  }
  if (entry) out[id] = entry

  return out
}

/** What the change test compares: the entry without its timestamp. */
export function signature(entry: WindowSession): string {
  return JSON.stringify({ ...entry, updatedAt: 0 })
}

export type Os = 'windows' | 'mac' | 'linux'

export function fileUrl(path: string): string {
  const p = path.replace(/\\/g, '/')
  return encodeURI(p.startsWith('/') ? `file://${p}` : `file:///${p}`)
}

/**
 * Ways to open the page, best first: a browser "app" window (no tabs or address
 * bar, easy to put on another screen and fullscreen), then the default browser.
 */
export function openCommands(os: Os, path: string): string[][] {
  const url = fileUrl(path)
  if (os === 'windows') {
    const ps = (exe: string) => [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process ${exe} -ArgumentList '--app=${url.replace(/'/g, "''")}','--window-size=1600,900'`,
    ]
    return [ps('msedge'), ps('chrome'), ['explorer.exe', path.replace(/\//g, '\\')]]
  }
  if (os === 'mac') {
    return [
      ['open', '-na', 'Google Chrome', '--args', `--app=${url}`],
      ['open', '-na', 'Microsoft Edge', '--args', `--app=${url}`],
      ['open', path],
    ]
  }

  return [['xdg-open', path]]
}
