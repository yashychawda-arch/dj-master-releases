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

## Pop it out into its own window

Press **Pop out ⧉** in the pane, or type `/agent-deck-window`. The deck opens as its own window (an Edge or
Chrome app window, falling back to your default browser), so you can drag it to another screen and press **F** to
fill it.

The window shows every session on your account, in six layouts. The first three are 3D scenes; they show one
session at a time, large: the one you click in the list, or else each session that is working or waiting on you
in turn, every 20 seconds (`[` `]` or the arrows at the bottom step through them).

- **Decks** (`1`): a DJ booth. Each working agent is a turntable: the record spins while it works and the tonearm
  crosses the record as it gets through its steps. The main session is the mixer, its meters moving while it works;
  finished agents and the agent types ready to start are record crates either side.
- **Circuit** (`2`): a synthwave racetrack under a striped sun. Each agent races its own lane; its pod sits as far
  round the lap as it has got, the glowing trail behind it the distance covered. With nothing to measure, the pod
  keeps lapping with a short comet tail.
- **Workshop** (`3`): a floating island of little robots. Each working agent hammers at its bench under a ring that
  fills as it goes; the agent types that could start sit waiting on a bench; finished work is stacked in crates.
  The main session is the foreman in the hard hat.
- **Orbit** (`4`): you in the middle; working sessions on the inner ring, sessions waiting for you on the middle
  ring, recent ones on the outer ring. Running agents circle their session. Cloud sessions are round, local ones
  square; a hollow square is a computer that is offline.
- **Board** (`5`): Working / Needs you / Recent columns, one card per session with its agents.
- **Lanes** (`6`): one row per session across the last hour, agent runs drawn as bars.

Click a session (or its name in a 3D scene) for its details and, for one claude.ai knows, an **Open on claude.ai**
link. `L` shows or hides the list, `F` fullscreen, `R` the 3D camera moving or still (drag to turn it, scroll to
zoom), `Esc` closes the details, **Today / This week** sets how far back finished sessions go. The 3D layouts load
three.js from the internet when the window opens; the other three work without it. Add `#demo` to the window's
address to try the layouts on made-up sessions.

Where the sessions come from:

- **Sessions on this computer with the deck**: live, every couple of seconds, each agent with its current step and
  time left.
- **Everything else on your account**: cloud sessions, and sessions on other computers that are connected to
  claude.ai. One of the open sessions fetches claude.ai's session list (the one `claude --teleport` shows) every
  20 seconds, signed in as you, and the recent history of up to six working ones for their agents.
- A session on this computer that claude.ai also lists shows once, matched by its folder name.
- If the list cannot be fetched (signed out, no network), the window says why and keeps showing this computer's
  sessions.
- The window reads a small file the sessions write: `~/.claude/agent-deck/deck-data.js`.
  `/agent-deck-window off` stops the sessions writing it, and the cloud fetching with it.

## About "time left"

Claude does not report progress or a finish time, so the deck estimates, and says how:

1. If the agent keeps a step list, it uses the average time per finished step × the steps left.
2. Otherwise, after three finished runs of the same agent type, it uses how long that type usually takes.
3. Otherwise it says there is no estimate yet, rather than make one up.

## Install (on the computer where your sessions run)

PowerShell (no Administrator needed):

```powershell
git clone --branch claude/beautiful-dijkstra-xijgme --depth 1 https://github.com/yashychawda-arch/dj-master-releases "$HOME\agent-deck-src"
claude plugin marketplace add "$HOME\agent-deck-src\tools\agent-deck"
claude plugin install agent-deck@agent-deck
```

If PowerShell says `claude` is not recognized, you only have the desktop app, which runs its own copy of
Claude Code that the terminal can't see. Install the terminal command once (it shares settings with the
app), then run the two plugin lines by its full path so you don't need a new window:

```powershell
irm https://claude.ai/install.ps1 | iex
& "$HOME\.local\bin\claude.exe" plugin marketplace add "$HOME\agent-deck-src\tools\agent-deck"
& "$HOME\.local\bin\claude.exe" plugin install agent-deck@agent-deck
```

New sessions open the deck by themselves. In a session that is already running, type `/reload-plugins`
and then `/agent-deck`.

To update later:

```powershell
git -C "$HOME\agent-deck-src" pull
claude plugin marketplace update agent-deck
claude plugin update agent-deck@agent-deck
```

Then start a new session (or type `/reload-plugins` in an open one) and press **Pop out** again: the window page is
copied out each time you pop it out, so an open window keeps the old page until then.

It sees the agents of the session it is loaded in. Agents a session started before the deck loaded
appear too, with no start time.

## Develop

```sh
claude plugin validate tools/agent-deck
claude plugin test tools/agent-deck
```
