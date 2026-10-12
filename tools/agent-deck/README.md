# Agent deck

A live 3D pane inside Claude Code that shows, for the session it runs in:

- **Main session**: in the middle of the stage, lit while Claude is working, grey while it waits for you.
- **Working agents**: glass towers around it. Each tower fills as the agent gets through its step list,
  and pulses when there is nothing to measure progress by. Underneath: what it is doing right now
  (its latest tool call, in words), how long it has run, and an estimate of the time left.
- **Ready to start**: the agent types Claude can hand work to (`general-purpose`, `Explore`, `Plan`,
  your own), on the rim.
- **Finished**: small blocks, green for done, red for failed, grey for stopped.

`◀ Turn` / `Turn ▶` rotate the camera. `/agent-deck` reopens the pane if you close it.

## About "time left"

Claude does not report progress or a finish time, so the deck estimates, and says how:

1. If the agent keeps a step list, it uses the average time per finished step × the steps left.
2. Otherwise, after three finished runs of the same agent type, it uses how long that type usually takes.
3. Otherwise it says there is no estimate yet, rather than make one up.

## Install (on the computer where your sessions run)

PowerShell:

```powershell
git clone --branch claude/beautiful-dijkstra-xijgme --depth 1 https://github.com/yashychawda-arch/dj-master-releases "$HOME\agent-deck-src"
claude plugin marketplace add "$HOME\agent-deck-src\tools\agent-deck"
claude plugin install agent-deck@agent-deck
```

New sessions open the deck by themselves. In a session that is already running, type `/reload-plugins`
and then `/agent-deck`.

It sees the agents of the session it is loaded in. Agents a session started before the deck loaded
appear too, with no start time.

## Develop

```sh
claude plugin validate tools/agent-deck
claude plugin test tools/agent-deck
```
