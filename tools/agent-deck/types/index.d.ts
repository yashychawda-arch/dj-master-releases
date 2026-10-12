export type DeckStatus = 'running' | 'done' | 'failed' | 'stopped' | 'idle'

export type DeckAgent = {
  id: string
  type: string
  description: string
  status: DeckStatus
  /** Undefined when the agent was already running as the deck loaded. */
  startedAt?: number
  endedAt?: number
  /** One line on its latest tool call. */
  action?: string
  tools: number
  stepsDone: number
  stepsTotal: number
  doneTaskIds: string[]
  /** Seen in `$.agent.list()` at least once. */
  isListed: boolean
}

export type DeckType = { name: string; description: string; source: string }

export type DeckMain = { isWorking: boolean; action?: string; since: number }

declare module 'claude-code' {
  interface PluginState {
    'agent-deck': {
      agents: Record<string, DeckAgent>
      types: DeckType[]
      yaw: number
      now: number
      history: Record<string, number[]>
      main: DeckMain
    }
  }
}
