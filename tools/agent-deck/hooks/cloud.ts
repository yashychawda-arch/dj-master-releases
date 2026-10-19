// Cloud sessions: the same list `claude --teleport` reads (GET /v1/code/sessions, as the signed-in
// person), turned into what the pop-out window draws. Pure helpers here; the hooks module does the
// fetching, with the session's own claude.ai credential through `$.session.authorize()`.

export const CLOUD_URL = 'https://api.anthropic.com/v1/code/sessions'
/** How often the list is fetched, by whichever open session gets there first. */
export const CLOUD_MS = 20_000
/** Working cloud sessions whose recent history is read for their agents, per refresh. */
export const MAX_HISTORIES = 6
/** An agent with nothing new for this long, while its session has moved on, counts as finished. */
export const AGENT_QUIET_MS = 180_000

export type CloudState = 'working' | 'blocked' | 'failed' | 'done' | 'stopped'

export type CloudAgent = {
  id: string
  description: string
  type: string
  status: 'running' | 'done' | 'failed' | 'stopped'
  action?: string
  startedAt?: number
  endedAt?: number
  tools: number
}

export type CloudSession = {
  id: string
  title: string
  /** `local` is a session on someone's computer that is connected to claude.ai (Remote Control). */
  place: 'cloud' | 'local'
  offline: boolean
  state: CloudState
  repo?: string
  branch?: string
  updatedAt: number
  createdAt: number
  /** What it needs from you, when it is waiting. */
  needs?: string
  /** The last turn, in a line. */
  detail?: string
  /** What it is on now. */
  doing?: string
  agents?: CloudAgent[]
  /** Times something happened, newest last, for the window's timeline. */
  activity?: number[]
}

export type CloudBlock = {
  fetchedAt: number
  error?: string
  sessions: CloudSession[]
}

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.replace(/\s+/g, ' ').trim() : undefined)
const time = (...vs: unknown[]): number => {
  for (const v of vs) {
    const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN
    if (Number.isFinite(t)) return t
  }
  return 0
}
const lastPart = (s: string | undefined) => s?.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop()

/** The rows of a JSON list answer (`{ data: [...] }`), or none. */
export function parseRows(text: string): Raw[] {
  try {
    const body = JSON.parse(text) as unknown
    const rows = isObj(body) ? body.data : undefined
    return Array.isArray(rows) ? rows.filter(isObj) : []
  } catch {
    return []
  }
}

/** Where a session stands, read the way Claude Code's own session list reads it. */
export function cloudState(raw: Raw): CloudState | 'archived' {
  const status = str(raw.status)
  if (status === 'archived') return 'archived'
  const worker = str(raw.worker_status)
  const bucket = (str(raw.status_bucket) ?? '').replace(/^SESSION_STATUS_BUCKET_/, '').toLowerCase()
  // A pending permission prompt or question is something only you can answer.
  if (worker === 'requires_action') return 'blocked'
  if (worker === 'running' && raw.connection_status === 'disconnected') return 'stopped'
  if (worker === 'running') return 'working'
  switch (bucket) {
    case 'working':
      return 'working'
    case 'blocked':
      return 'blocked'
    case 'failed':
      return 'failed'
    case 'completed':
    case 'review_ready':
      return 'done'
  }
  return status === 'paused' && worker !== 'idle' ? 'stopped' : 'done'
}

/** One row of the list as the window wants it; undefined for archived or unreadable rows. */
export function cloudSession(raw: Raw): CloudSession | undefined {
  const id = str(raw.id)
  if (!id) return undefined
  const state = cloudState(raw)
  if (state === 'archived') return undefined
  const meta = isObj(raw.external_metadata) ? raw.external_metadata : {}
  const summary = isObj(raw.post_turn_summary) ? raw.post_turn_summary : isObj(meta.post_turn_summary) ? meta.post_turn_summary : {}
  const ctx = isObj(raw.session_context) ? raw.session_context : {}
  const config = isObj(raw.config) ? raw.config : {}
  const sources = [...(Array.isArray(config.sources) ? config.sources : []), ...(Array.isArray(ctx.sources) ? ctx.sources : [])].filter(isObj)
  const sourceUrl = sources
    .map(s => str(s.url) ?? (isObj(s.git_repository) ? str(s.git_repository.url) : undefined))
    .find(Boolean)
  const branches = isObj(meta.current_branches) ? meta.current_branches : {}
  const worktrees = isObj(meta.worktree_state) ? Object.keys(meta.worktree_state) : []
  const outcomes = Array.isArray(ctx.outcomes) ? ctx.outcomes.filter(isObj) : []
  const outcomeBranch = outcomes
    .map(o => (isObj(o.git_info) && Array.isArray(o.git_info.branches) ? str(o.git_info.branches[0]) : undefined))
    .find(Boolean)
  const pending = isObj(meta.pending_action) ? str(meta.pending_action.name) : undefined
  const place = raw.environment_kind === 'bridge' ? 'local' : 'cloud'

  return {
    id,
    title: str(raw.title) ?? 'Untitled session',
    place,
    offline: place === 'local' && raw.connection_status === 'disconnected',
    state,
    repo: lastPart(sourceUrl) ?? lastPart(worktrees[0]) ?? lastPart(Object.keys(branches).find(Boolean)),
    branch: outcomeBranch ?? str(Object.values(branches)[0]),
    updatedAt: time(raw.last_event_at, raw.updated_at, raw.created_at),
    createdAt: time(raw.created_at),
    needs: str(summary.needs_action) ?? (state === 'blocked' && pending ? `Answer its ${pending} request` : undefined),
    detail: str(summary.recent_action) ?? str(summary.status_detail),
    doing: str(raw.task_summary) ?? str(meta.task_summary),
  }
}

/** The list, newest first, archived rows left out. */
export function cloudSessions(text: string): CloudSession[] {
  return parseRows(text)
    .map(cloudSession)
    .filter((s): s is CloudSession => s !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** A tool call in words, short enough for one line. */
export function describeUse(name: string, input: Raw): string {
  const file = (k: string) => str(input[k])?.split(/[\\/]/).pop() ?? 'a file'
  const cut = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? '')
  switch (name) {
    case 'Bash':
      return cut(str(input.description) ?? str(input.command) ?? 'Running a command', 80)
    case 'Read':
      return `Reading ${file('file_path')}`
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${file('file_path')}`
    case 'Write':
      return `Writing ${file('file_path')}`
    case 'Grep':
      return `Searching for "${cut(str(input.pattern), 40)}"`
    case 'Glob':
      return `Finding files ${cut(str(input.pattern), 40)}`
    case 'WebSearch':
      return `Searching the web: ${cut(str(input.query), 50)}`
    case 'WebFetch':
      return 'Reading a web page'
    case 'Agent':
    case 'Task':
      return `Starting an agent: ${cut(str(input.description), 50)}`
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'Updating its task list'
  }
  if (name.startsWith('mcp__')) return `Using ${(name.split('__')[2] ?? name).replace(/_/g, ' ')}`
  return name.replace(/([a-z])([A-Z])/g, '$1 $2') || 'Working'
}

/**
 * One event's message, whichever way the history spells it: `{ payload: {...} }` from the events
 * route, or `{ assistant: { internal_anthropic_catchall: {...} } }` as the session tools show it.
 */
function unpack(ev: Raw): { p: Raw; at: number } | undefined {
  if (isObj(ev.payload)) return { p: ev.payload, at: time(ev.created_at, ev.payload.timestamp) }
  const kind = Object.keys(ev).find(k => k !== 'created_at' && k !== 'id')
  const body = kind && isObj(ev[kind]) ? (ev[kind] as Raw) : undefined
  if (!kind || !body) return undefined
  const inner = isObj(body.internal_anthropic_catchall) ? body.internal_anthropic_catchall : body
  return { p: { ...inner, type: inner.type ?? kind }, at: time(ev.created_at, inner.timestamp) }
}

/**
 * The agents a working session has started, from its recent history: who they are (the Agent call,
 * or the `task_started` / `task_progress` notes), what each did last (calls marked with the Agent
 * call's id as their parent), and how each ended (`task_notification`).
 */
export function cloudAgents(events: Raw[], now: number): { agents: CloudAgent[]; doing?: string; activity: number[] } {
  type Acc = CloudAgent & { lastAt: number; actionAt: number; final?: CloudAgent['status'] }
  const byId = new Map<string, Acc>()
  const taskToTool = new Map<string, string>()
  const activity: number[] = []
  let doing: string | undefined
  let doingAt = -1
  let mainAt = 0

  const get = (id: string, at: number): Acc => {
    let a = byId.get(id)
    if (!a) {
      a = { id, description: 'Agent', type: 'agent', status: 'running', tools: 0, lastAt: at, actionAt: -1, startedAt: at }
      byId.set(id, a)
    }
    if (at) {
      a.startedAt = a.startedAt ? Math.min(a.startedAt, at) : at
      a.lastAt = Math.max(a.lastAt, at)
    }
    return a
  }

  for (const ev of events) {
    const u = unpack(ev)
    if (!u) continue
    const { p, at } = u
    if (at) activity.push(at)
    const type = str(p.type)
    const parent = str(p.parent_tool_use_id)
    if (type === 'assistant') {
      const msg = isObj(p.message) ? p.message : {}
      const blocks = Array.isArray(msg.content) ? msg.content.filter(isObj) : []
      for (const b of blocks) {
        if (b.type !== 'tool_use') continue
        const name = str(b.name) ?? ''
        const input = isObj(b.input) ? b.input : {}
        const id = str(b.id)
        if (!parent && (name === 'Agent' || name === 'Task') && id) {
          const a = get(id, at)
          a.description = str(input.description) ?? a.description
          a.type = str(input.subagent_type) ?? (a.type === 'agent' ? 'general-purpose' : a.type)
        }
        if (parent) {
          const a = get(parent, at)
          a.tools += 1
          if (at >= a.actionAt) {
            a.action = describeUse(name, input)
            a.actionAt = at
          }
        } else {
          mainAt = Math.max(mainAt, at)
          if (at >= doingAt) {
            doing = describeUse(name, input)
            doingAt = at
          }
        }
      }
    } else if (type === 'system') {
      const sub = str(p.subtype) ?? ''
      const task = str(p.task_id)
      const tool = str(p.tool_use_id) ?? (task ? taskToTool.get(task) : undefined)
      if (task && tool) taskToTool.set(task, tool)
      if (!tool || !/^task_/.test(sub)) continue
      const a = get(tool, sub === 'task_notification' ? 0 : at)
      a.description = str(p.description) ?? a.description
      a.type = str(p.subagent_type) ?? a.type
      const usage = isObj(p.usage) ? p.usage : {}
      if (typeof usage.tool_uses === 'number') a.tools = Math.max(a.tools, usage.tool_uses)
      if (sub === 'task_notification') {
        const s = (str(p.status) ?? '').toLowerCase()
        a.final = /fail|error/.test(s) ? 'failed' : /stop|kill|cancel/.test(s) ? 'stopped' : 'done'
        a.endedAt = at || a.lastAt
      }
    }
  }

  const agents = [...byId.values()].map(({ lastAt, actionAt: _actionAt, final, ...a }): CloudAgent => {
    const quiet = now - lastAt >= AGENT_QUIET_MS && mainAt > lastAt
    const status = final ?? (quiet ? 'done' : 'running')
    return { ...a, status, endedAt: status === 'running' ? undefined : a.endedAt ?? lastAt }
  })
  agents.sort((x, y) => (x.status === 'running' ? 0 : 1) - (y.status === 'running' ? 0 : 1) || (x.startedAt ?? 0) - (y.startedAt ?? 0))

  return {
    agents: agents.filter(a => a.status === 'running').concat(agents.filter(a => a.status !== 'running').slice(0, 6)),
    doing,
    activity: activity.filter(t => now - t < 3_600_000).sort((x, y) => x - y).slice(-120),
  }
}

/** Words for a list request claude.ai turned down. */
export function cloudError(status: number): string {
  if (status === 401) return 'claude.ai says the sign-in has expired. Run /login in a Claude session.'
  if (status === 403) return 'claude.ai refused the session list (HTTP 403).'
  if (status === 404) return 'claude.ai does not offer the session list here (HTTP 404).'
  if (status === 429) return 'claude.ai asked to slow down (HTTP 429); trying again shortly.'
  return `claude.ai answered HTTP ${status}.`
}
