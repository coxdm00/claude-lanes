# claude-lanes

Three Claude Code mods for a session that hands work to subagents. Each one answers an engine
event in TypeScript, ships with its tests, and is installed from this marketplace.

| mod | what it does |
| :- | :- |
| [lane-pace](lane-pace/) | Judges every subagent spawn and shows the live lane count in the status line. At its defaults it caps nothing until its pace file reads `quiet`, then refuses a third live lane. `seatAgent` reserves the top model for one agent type, `ladder` holds a nested spawn one model tier below its parent, and `briefScript` refuses a lane brief your script rejects. |
| [lane-fence](lane-fence/) | Keeps a read-only agent's Bash writes inside its own record paths, the agent identified from the engine's live list, every target placed where it really lands. |
| [lane-blame](lane-blame/) | Records which agent wrote each source file, across worktrees, and runs the tests beside those writes at every stop, so a red suite names its writer. |

## Install

```
claude plugin marketplace add coxdm00/claude-lanes
claude plugin install lane-pace@claude-lanes --scope project
claude plugin install lane-fence@claude-lanes --scope project
claude plugin install lane-blame@claude-lanes --scope project
```

Checked on Claude Code 2.1.301, where the function-hooks surface is current; a later build may
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
- **lane-blame**: set `sourceRoot` if your source is not under `src/`, `testFolder` if your tests
  sit in a folder beside each source root, and `runner` if your tests are not run by vitest.

Each README carries, under "What this harness sets", the block this repo's own harness sets, as a
worked example. It loads through each mod's per-repo read of the project `.claude/settings.json`,
so the repo needs no user setting.

## Development

```
claude plugin validate <mod>
claude plugin test <mod>
```

MIT. Not affiliated with Anthropic.
