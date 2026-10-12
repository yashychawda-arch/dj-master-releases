# Agent Deck (live)

A page on claude.ai that shows every Claude Code session on your account, cloud and local, and the agents each
one is running. It replaces the 3D "buildings" window from `tools/agent-deck` (branch
`claude/beautiful-dijkstra-xijgme`), which could only see sessions on the computer it was installed on.

Open it: https://claude.ai/artifact/6gXLsgR2MfJWfgfpR6f5rh

## Layouts

- **Orbit** (`1`): you in the middle, working sessions on the inner ring, sessions waiting for you on the middle
  ring, recent ones on the outer ring. Running agents circle their session. Cloud sessions are round, local ones
  square; a hollow square means that computer is offline.
- **Board** (`2`): Working / Needs you / Recent columns, one card per session with its agents.
- **Lanes** (`3`): one row per session across the last hour, with agent runs drawn as bars.

`T` cycles layouts, `F` fullscreen, `R` refresh, `Esc` closes the detail panel. Click a session for its details and
an "Open session" link.

## How it gets the data

The page uses the built-in **Claude Code Remote** connector, as you: `list_sessions` every 30 seconds, and
`list_events` (assistant and system events, newest 60) for each session that is working. Nothing is stored.

- Local sessions appear when they are connected to claude.ai (the desktop app's sessions, or `claude remote-control`
  in a terminal). A plain terminal `claude` session with no Remote Control is not visible to claude.ai, so it is
  not visible here either.
- Agent status is read from session history: an agent counts as running while its session is working and it has
  done something in the last 3 minutes, or the main session has not moved on since it last did.
- Opened outside claude.ai (for example as a local file), the page shows labelled example data.

## Updating

Edit `index.html`, then republish it to the same artifact URL from a Claude Code session.
