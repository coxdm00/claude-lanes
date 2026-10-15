# claude-lanes

Three Claude Code mods for a session that hands work to subagents. Each one answers an engine
event in TypeScript, ships with its tests, and is installed from this marketplace.

| mod | what it does |
| :- | :- |
| [lane-pace](lane-pace/) | Caps the live subagent lanes against a pace word, refuses a reserved model on a nested spawn, holds every nested spawn one model tier below its parent, and refuses a lane brief that breaks its caps. |
| [lane-fence](lane-fence/) | Keeps a read-only agent's Bash writes inside its own record paths, the agent identified from the engine's live list, every target placed where it really lands. |
| [lane-blame](lane-blame/) | Records which agent wrote each source file, across worktrees, and runs the tests beside those writes at every stop, so a red suite names its writer. |

## Install

```
claude plugin marketplace add coxdm00/claude-lanes
claude plugin install lane-pace@claude-lanes --scope project
claude plugin install lane-fence@claude-lanes --scope project
claude plugin install lane-blame@claude-lanes --scope project
```

The marketplace also lists two of Anthropic's playground mods as `git-subdir` entries, since their
own marketplace sits in a subdirectory the `marketplace add` command cannot reach: `blast-radius`,
which holds a destructive command and shows what it would change, and `token-weather`, a context
forecast above the prompt. They install the same way, `blast-radius@claude-lanes` and
`token-weather@claude-lanes`, and their code stays Anthropic's.

Checked on Claude Code 2.1.300, where the function-hooks surface is current; a later build may
move it, and CI pins that version so a change is a commit, never a surprise.

## Why these three

They came out of four harnesses built on the same shape, each a hand-ported fork, and were the
three jobs no public mod did: a lane cap read from the engine's own agent list, a write fence by
agent type, and a suite verdict attributed to its writer.

## What you set

Each mod installs inert or permissive and does nothing it was not told to. The rows under
`/config` are where it learns your repo:

- **lane-pace**: write `quiet` to its pace file to cap live lanes; name a `seatAgent` to reserve the
  top model for one agent type; turn `ladder` on to hold nested spawns one tier down.
- **lane-fence**: name the `agentTypes` it fences and the `recordFolders` each may still write in.
- **lane-blame**: set `sourceRoot` and the runner if your tests are not vitest under `src/`.

Each README ends with the block one harness sets, as a worked example.

## Development

```
claude plugin validate <mod>
claude plugin test <mod>
```

MIT. Not affiliated with Anthropic.
