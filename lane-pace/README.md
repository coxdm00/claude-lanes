# lane-pace

A Claude Code mod that keeps subagents from running away with your machine and your model budget.
It sits on the engine's `agent.spawn` event and judges every subagent before it starts.

Claude Code's own `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` is a fixed cap per session. The pace
word, the model ladder, the judgment seat, and the brief check below have no built-in.

- **A cap on live lanes.** A one-word file says `quiet` or `wide`. Under `quiet`, a third live
  subagent is refused, and the refusal names every lane still running so you can see who holds the
  slots. Under `wide` there is no cap. The file lifts the cap only when it reads exactly `wide`
  once spaces and newlines are trimmed; any other content, an empty file and `Wide` included, reads
  `quiet`. A missing file, or one that cannot be read, reads `wide`, so a fresh install caps nothing
  until you write `quiet` to it.
- **One judgment seat on the top model.** Once you name a seat agent, any subagent that would run on
  the seat model, Fable by default, is refused unless it is that one agent type. This holds under
  `wide` too, and for the main session's spawns as well as nested ones. With no seat agent named,
  the default, the rule is off. With `ladder` also on, the seat agent itself is refused when a
  subagent spawns it on the seat model, since the seat is the main session's to spawn.
- **A model ladder, opt-in.** With `ladder` on, a spawn made from inside a subagent must run one
  tier below its parent: Opus spawns Sonnet or Haiku, Sonnet spawns Haiku, and Haiku may spawn
  Haiku. The main session's own spawns are never judged. A built-in agent type with no agent file
  is left unchecked by the ladder, since its own model cannot be read.
- **A brief-size check.** When a spawn prompt names a lane brief file, the mod runs your script on
  it first. Exit 1 refuses the spawn with the script's lines, exit 2 refuses it as a brief nobody
  could count. A crash, a timeout, or a missing file fails open. Leave the script option empty and
  the check is off.
- **Resume is a wake.** A SendMessage that wakes a finished subagent skips the model and brief
  checks, since a resume cannot change them, and meets only the lane cap, its own slot left out.
- **A verdict record.** Each verdict bumps one store key, `lane-pace.verdict.<kind>`, holding the
  session id, the time, and a running count, so you can tell the mod has acted. The kinds are
  `fable`, `ladder`, `brief`, `brief-open`, `brief-unchecked`, `resume`, `cap`, `wide`, and `quiet`.
  The `fable` key keeps that name whatever `seatModel` is set to. One spawn can bump two keys: a
  resume writes `resume` and then the pace key it meets, and a brief check that fails open writes
  `brief-unchecked` and then the pace key.
- **A status entry.** The status line shows the lane count, `pace quiet, 1 of 2 lanes`, redrawn at
  every turn end so a refusal never outlives its turn.

Anything the mod cannot judge, it lets through: every hook fails open.

## Install

From a shell:

```sh
claude plugin marketplace add coxdm00/claude-lanes
claude plugin install lane-pace@claude-lanes --scope project
```

To turn the lane cap on, write `quiet` to the pace file, and `wide` to lift it:

```sh
mkdir -p .claude/state && echo quiet > .claude/state/pace
```

## Options

Set in `/config`, which writes `pluginConfigs["lane-pace@claude-lanes"].options` in your user
settings, or per repo as the next section says. Relative paths read under the session root.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `paceFile` | string | `.claude/state/pace` | File holding the pace word, `quiet` or `wide`. Missing reads `wide`. A cap refusal tells the model to write `wide` to this file. |
| `quietCap` | number | `2` | Live subagents allowed at once under `quiet`. `0` refuses every spawn under `quiet`. A fraction rounds down, and a negative number falls back to `2`. |
| `seatAgent` | string | empty | The one subagent type allowed on the seat model. Empty turns the seat rule off. |
| `seatModel` | `sonnet`, `opus`, `fable` | `fable` | The model refused to every subagent but the seat. Any other value, `haiku` included, falls back to `fable`. |
| `agentsDir` | string | `.claude/agents` | Folder of project agent files whose frontmatter `model:` pin the mod reads. `~/.claude/agents` is read after it. |
| `ladder` | boolean | `false` | Opt-in. Refuse a nested spawn at or above its parent's tier, Haiku to Haiku the one same-tier pass. |
| `briefScript` | string | empty | Script run with `bash` on each lane brief a prompt names. Exit 1 refuses, exit 2 refuses as a brief the script could not parse. Empty turns the check off. |
| `briefTimeoutMs` | number | `10000` | How long the script may run before the check fails open. Below `1` falls back to `10000`. |
| `bundleDir` | string | `.claude/features` | Folder holding the numbered bundle folders briefs sit in. |
| `bundlePrefix` | string | `CC` | Bundle folder prefix, as in `CC-148`. Matched in any case, spelled this way on disk. |
| `briefPattern` | string | empty | A regular expression that replaces the brief path pattern built from `bundlePrefix`. Empty keeps the built one. A pattern that will not compile matches nothing, so the check never runs and no status note says so. |

With `briefScript` set and the other brief options on their defaults, a lane brief is any `.md` whose name holds `brief`, sitting straight under a
`CC-<N>/` folder or its `briefs/` folder. A bare `features/` path reads beside `bundleDir`'s last
folder, a bare `CC-<N>/` path under `bundleDir`, and a leading `~/` from `HOME`.

## Per-repo options

Claude Code reads `pluginConfigs` from your user settings, `~/.claude/settings.json`, so the
options above are machine-wide: every repo on one machine runs the same block. This mod also reads
the project's own settings through the engine, `.claude/settings.json` and then
`.claude/settings.local.json`, and takes its own block from each: the first entry under
`pluginConfigs`, in file order, whose key is `lane-pace@claude-lanes` or whose name before the `@`
is `lane-pace`. A field set there wins over the user value, the local file over the project
file, field by field. A field of the wrong type is ignored, as the engine ignores one, and so is a
`seatModel` outside its three choices; the user value stands for either. The read happens once per
session, at the mod's first event, so a change to either file takes effect after a restart. A
missing block changes nothing, and a read the engine refuses leaves the user options standing.

## What this harness sets

The defaults suit a stranger's repo: no cap until the pace file says `quiet`, no seat rule, no
ladder, and no brief check. The repo that publishes this mod runs it on its own harness, and this
is that harness's project block, from the repo's `.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "lane-pace@claude-lanes": {
      "options": {
        "paceFile": ".claude/state/pace",
        "seatAgent": "",
        "ladder": true,
        "briefScript": ".claude/hooks/lib/check-brief-size.sh",
        "bundlePrefix": "LN"
      }
    }
  }
}
```

It loads through the per-repo read above, so it holds for this repo alone and wins over any user
block on the same machine. The ladder is on. The brief-size script counts each lane brief, and
`bundlePrefix` is `LN` so a brief under an `LN-001/` folder is the one it matches. `seatAgent` is
empty because this harness names no seat agent, which keeps the seat rule off here even where a
user block names one. `paceFile` stays on its default, and the harness writes the word into it with
its own script.

## Resolution order

The ladder and the seat rule judge the model a child will actually run, resolved as the 2.1.300
engine resolves it. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is a flag, read on for `1`, `true`, or `yes`
in any case. With it on, the engine drops the call's `model` and the agent file's pin, keeping
only a call's `inherit`, and forces the plain `CLAUDE_CODE_SUBAGENT_MODEL`, or the parent's model
when that is unset or `inherit`. In full: a fork runs the parent's model whatever it asks; a call's
`model: "inherit"` runs the parent's, flag on or off; with the flag on, the forced model wins over
every other pin; else the call's `model`; else the agent file's frontmatter `model:`, an `inherit`
there meaning the parent's, the project folder read before `~/.claude/agents`; else the plain `CLAUDE_CODE_SUBAGENT_MODEL`; else the parent's. Tiers
are read by whole word and case-blind, so `opus`, `opus[1m]`, and `claude-opus-5-5` all place.

For the ladder, a model naming no tier, or two, cannot be placed and fails open with a status note,
as does a plugin's agent, whose definition the mod cannot read, and a built-in with no agent file
in either folder. The seat rule reads that built-in differently: it runs the plain
`CLAUDE_CODE_SUBAGENT_MODEL` or the parent's model, so under a parent on the seat model it is
refused. A seat refusal inside a subagent names only models below both the parent and the seat,
so the respawn it advises clears the ladder too.

## Status line

The mod writes one entry to the status line. Under `quiet` it reads `pace quiet, 1 of 2 lanes`, or
`pace quiet, 2 of 2 lanes, spawn refused` on a cap refusal; under `wide` it reads `pace wide`. A
refusal by another rule writes its own text: `fable subagent refused`, with the seat model's name
in place of `fable`, `model ladder, spawn refused`, `brief over its caps, spawn refused`, or
`brief the size check could not parse, spawn refused`. A check that fails open puts its reason in
front of the pace entry, so the next status write cannot erase it. At every turn end the entry is
redrawn from the live count: `wide`, or `quiet` with no lane live, clears it, so `pace wide` lasts
only until the turn ends.

## Checked on

Checked on Claude Code 2.1.301. The function-hook surface is early access, so rerun
`claude plugin validate` and `claude plugin test` on this folder after every upgrade.

## Footprint

What `claude plugin validate` prints for the module, run on this folder:

```
hooks: agent.spawn, turn.complete
gating hook with .catch: agent.spawn
calls: $.agent.list, $.clock.now, $.env.get, $.fs.exists, $.fs.read, $.process.run, $.session.id, $.session.root, $.settings.read, $.store.get, $.store.set, $.ui.status
env writes: nothing
env reads: CLAUDE_CODE_SUBAGENT_MODEL, CLAUDE_CODE_SUBAGENT_MODEL_FORCE, HOME
```

## Threat model

1. It reads the pace file, agent files under `agentsDir` and `~/.claude/agents`, three environment
   variables, the engine's list of running subagents, its own store keys, the session id, the
   session root, and the clock. It asks whether each lane brief a prompt names exists, and a brief
   spelled as an absolute path, a `~/` path, or a leading `../` sits outside the session root. It
   reads the project's `.claude/settings.json` and `.claude/settings.local.json` through the
   engine, once per session. The engine hands back each whole file, `env` and helper commands
   included; the mod takes its own `pluginConfigs` block from them and nothing else.
2. It writes only its own store keys, `lane-pace.verdict.<kind>`, and its status line entry.
3. It refuses subagent spawns and nothing else: no tool call, prompt, or file edit is touched.
4. It runs `bash <briefScript> <brief>` once for each distinct brief a prompt names, one after
   another, each from the session root with its own timeout, and only when the option is set.
5. It never sends anything over the network, never edits a file, and never rewrites a spawn. The
   script you name in `briefScript` runs with your permissions and is held to none of this.

## Tests

`tests/pace.test.ts`, run by `claude plugin test` on this folder. Each option has a pair, one on
its default and one set. The cases that judge the seat, the ladder, and the brief check run on the
options of the harness this mod was lifted from, the seat for `design-critic`, the ladder, and the
brief-size script.

## License

MIT, Dave Cox.
