# lane-pace

A Claude Code mod that keeps subagents from running away with your machine and your model budget.
It sits on the engine's `agent.spawn` event and judges every subagent before it starts.

- **A cap on live lanes.** A one-word file says `quiet` or `wide`. Under `quiet`, a third live
  subagent is refused, and the refusal names every lane still running so you can see who holds the
  slots. Under `wide` there is no cap. A missing file reads `wide`, so a fresh install caps nothing
  until you write `quiet` to it.
- **One judgment seat on the top model.** Once you name a seat agent, any subagent that would run on
  the seat model, Fable by default, is refused unless it is that one agent type. This holds under
  `wide` too. With no seat agent named, the default, the rule is off.
- **A model ladder, opt-in.** With `ladder` on, a spawn made from inside a subagent must run one
  tier below its parent: Opus spawns Sonnet or Haiku, Sonnet spawns Haiku, and Haiku may spawn
  Haiku. The main session's own spawns are never judged. A built-in agent type with no agent file
  is left unchecked, since its own model cannot be read.
- **A brief-size check.** When a spawn prompt names a lane brief file, the mod runs your script on
  it first. Exit 1 refuses the spawn with the script's lines, exit 2 refuses it as a brief nobody
  could count. A crash, a timeout, or a missing file fails open. Leave the script option empty and
  the check is off.
- **Resume is a wake.** A SendMessage that wakes a finished subagent skips the model and brief
  checks, since a resume cannot change them, and meets only the lane cap, its own slot left out.
- **A verdict record.** Every judged spawn bumps one store key, `lane-pace.verdict.<kind>`, holding the
  session id, the time, and a running count, so you can tell the mod has acted.
- **A status entry.** The status line shows the lane count, `pace quiet, 1 of 2 lanes`, redrawn at
  every turn end so a refusal never outlives its turn.

Anything the mod cannot judge, it lets through: every hook fails open.

## Install

At the prompt of a Claude Code session:

```
/plugin install lane-pace --marketplace coxdm00/claude-lanes
```

From a shell:

```sh
claude plugin install lane-pace --marketplace coxdm00/claude-lanes
```

Replace `coxdm00/claude-lanes` with the GitHub repository that holds this folder. To install from a local
checkout instead, add the repository root, the folder above `pace/` that holds the marketplace
file, then install from the marketplace it names:

```sh
claude plugin marketplace add /path/to/repo
claude plugin install lane-pace@claude-lanes
```

Replace `<marketplace>` with the `name` in the root `.claude-plugin/marketplace.json`.

To turn the lane cap on, write `quiet` to the pace file, and `wide` to lift it:

```sh
mkdir -p .claude/state && echo quiet > .claude/state/pace
```

## Options

Set in `/config` or in settings under `pluginConfigs.pace.options`. Relative paths read under the
session root.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `paceFile` | string | `.claude/state/pace` | File holding the pace word, `quiet` or `wide`. Missing reads `wide`. A cap refusal tells the model to write `wide` to this file. |
| `quietCap` | number | `2` | Live subagents allowed at once under `quiet`. `0` refuses every spawn under `quiet`. |
| `seatAgent` | string | empty | The one subagent type allowed on the seat model. Empty turns the seat rule off. |
| `seatModel` | `sonnet`, `opus`, `fable` | `fable` | The model refused to every subagent but the seat. |
| `agentsDir` | string | `.claude/agents` | Folder of project agent files whose frontmatter `model:` pin the mod reads. `~/.claude/agents` is read after it. |
| `ladder` | boolean | `false` | Opt-in. Refuse a nested spawn at or above its parent's tier. |
| `briefScript` | string | empty | Script run with `bash` on each lane brief a prompt names. Empty turns the check off. |
| `briefTimeoutMs` | number | `10000` | How long the script may run before the check fails open. |
| `bundleDir` | string | `.claude/features` | Folder holding the numbered bundle folders briefs sit in. |
| `bundlePrefix` | string | `CC` | Bundle folder prefix, as in `CC-148`. Matched in any case, spelled this way on disk. |
| `briefPattern` | string | empty | A regular expression that replaces the brief path pattern built from `bundlePrefix`. |

With `briefScript` set and the other brief options on their defaults, a lane brief is any `.md` whose name holds `brief`, sitting straight under a
`CC-<N>/` folder or its `briefs/` folder. A bare `features/` path reads beside `bundleDir`'s last
folder, a bare `CC-<N>/` path under `bundleDir`, and a leading `~/` from `HOME`.

## What this harness sets

The defaults suit a stranger's repo: no cap until the pace file says `quiet`, no seat rule, no
ladder, and no brief check. The harness this mod was lifted from sets four options to get its old
behaviour back, the Fable seat for `design-critic`, the ladder, and the brief-size script:

```json
{
  "pluginConfigs": {
    "lane-pace@claude-lanes": {
      "options": {
        "seatAgent": "design-critic",
        "ladder": true,
        "briefScript": ".claude/hooks/lib/check-brief-size.sh",
        "paceFile": ".claude/state/pace"
      }
    }
  }
}
```

One difference stays: a missing pace file now reads `wide`, so that harness keeps the file present.

## Resolution order

The ladder and the seat rule judge the model a child will actually run, resolved as the 2.1.300
engine resolves it. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is a flag, read on for `1`, `true`, or `yes`
in any case. With it on, the engine drops the call's `model` and the agent file's pin, keeping
only a call's `inherit`, and forces the plain `CLAUDE_CODE_SUBAGENT_MODEL`, or the parent's model
when that is unset or `inherit`. In full: a fork runs the parent's model whatever it asks; a call's
`model: "inherit"` runs the parent's, flag on or off; with the flag on, the forced model wins over
every other pin; else the call's `model`; else the agent file's frontmatter `model:`, an `inherit`
there meaning the parent's, the project folder read before `~/.claude/agents`; else the plain `CLAUDE_CODE_SUBAGENT_MODEL`; else the parent's. Tiers
are read by whole word and case-blind, so `opus`, `opus[1m]`, and `claude-opus-5-5` all place. A
model naming no tier, or two, cannot be placed and fails open with a status note, as does a
plugin's agent, whose definition the mod cannot read, and a built-in with no agent file in either
folder.

## Checked build range

Written and tested against Claude Code `2.1.300`. The function-hook surface is early access, so
rerun `claude plugin validate .` and `claude plugin test .` after every upgrade.

## Footprint

What `claude plugin validate .` prints for the module:

```
hooks: agent.spawn, turn.complete
gating hook with .catch: agent.spawn
calls: $.agent.list, $.clock.now, $.env.get, $.fs.exists, $.fs.read, $.process.run, $.session.id, $.session.root, $.store.get, $.store.set, $.ui.status
env writes: nothing
env reads: CLAUDE_CODE_SUBAGENT_MODEL, CLAUDE_CODE_SUBAGENT_MODEL_FORCE, HOME
```

## Threat model

1. It reads the pace file, agent files under `agentsDir` and `~/.claude/agents`, three environment variables, and the
   engine's list of running subagents.
2. It writes only its own store keys, `lane-pace.verdict.<kind>`, and its status line entry.
3. It refuses subagent spawns and nothing else: no tool call, prompt, or file edit is touched.
4. It runs one process, `bash <briefScript> <brief>`, only when a prompt names a brief and the
   option is set, with a timeout.
5. It never sends anything over the network, never edits a file, and never rewrites a spawn.

## Tests

`tests/pace.test.ts`, 94 cases, run by `claude plugin test .`. Each option has a pair, one on its
default and one set, and the cases that judge the old harness's rules run on the options above.

## License

MIT, Dave Cox.
