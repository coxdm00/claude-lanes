# claude-lanes

Mods for Claude Code sessions that hand work to subagents. Call each subagent a lane: one agent
working its own piece of the task while the main session coordinates. One lane is easy to follow.
Run several at once and a few questions stop answering themselves. How many lanes are live right
now, and on which models? Did the reviewer touch code it was only meant to read? Whose edit turned
the suite red? Each mod here answers one of those from the engine's own events, in TypeScript, with
its tests beside it.

| mod | the question it answers |
| :- | :- |
| [lane-pace](lane-pace/) | How many lanes are live, on which models, and may this one start? |
| [lane-fence](lane-fence/) | Did a read-only agent write somewhere it should not have? |
| [lane-blame](lane-blame/) | Who wrote the file behind this red test? |

## Install

```
claude plugin marketplace add coxdm00/claude-lanes
claude plugin install lane-pace@claude-lanes --scope project
claude plugin install lane-fence@claude-lanes --scope project
claude plugin install lane-blame@claude-lanes --scope project
```

Checked on Claude Code 2.1.301, where the function-hooks surface is current; a later build may
move it, and CI pins that version so a change is a commit, never a surprise.

Every mod installs inert or permissive. Out of the box nothing is capped, no seat rule or ladder
runs, no agent type is fenced, and the blame log goes to the system tmp folder. You turn on what
you want, and every hook fails open: if a mod throws, your session carries on as if it were absent.

## Where they came from

I run Claude Code inside a harness of my own, a set of hooks, skills, and agents that works in
bundles. A bundle is a plan, a fan-out of build lanes, a review that sends blind reviewer lanes
and refuters over the diff, fix lanes, and a closeout. It runs on autopilot, sometimes overnight,
over a web app whose suite holds thousands of tests. That shape gets a lot done and leaves you
asking afterwards what happened in it.

Each mod began there as a shell hook, was rebuilt as a function-hook
mod once Claude Code shipped that surface, and was published here on 2026-10-15 because nothing
public did the same job.

## lane-pace

A single review in that harness could open eight cold-read lanes, two refuter lanes, and a run of
fix lanes. On autopilot that is the point. With me at the keyboard on
the same laptop it was a problem: full-suite reds turned out to be machine load, proven by quiet
reruns on either side of the fixes, and finished lane worktrees piled up until one cleanup found 78
of them holding 9.7 GB. Claude Code's own `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` is one fixed
number per session. The cap I needed depended on whether I was sitting there.

So the cap is a word in a file. `quiet` allows two live subagents and `wide` lifts the cap.
lane-pace answers the engine's `agent.spawn` event, counts live lanes from the engine's own agent
list, and refuses the spawn that would go over, naming every lane that still holds a slot so you
can see who has them. The status line reads `pace quiet, 1 of 2 lanes`. Since 1.1.0 the `paces`
option adds words of your own, each with its own cap, so `calm=1 busy=4` gives one lane, two, or
four, with `wide` above them all.

Two more rules came from the model bill. The top model draws up to half the weekly pool at twice
the per-token rate, and in July its quota cut fan-outs off mid-run, so for a while no subagent ran
on it at all. The ban lifted once the work had the right shape: a critic that reads one bounded
input and writes one verdict spends a few thousand tokens, and that seat is where the widest taste
pays. `seatAgent` names that one agent type, and any other subagent headed for the seat model,
Fable by default, is refused. The ladder followed a ruling I made on 2026-10-14: "when
a sub agent spins up its own sub sub agent it should go one level lower." With `ladder` on, a
spawn made from inside a lane runs one tier below its parent. Opus spawns Sonnet or Haiku, Sonnet
spawns Haiku, and Haiku may spawn Haiku. The mod judges the model the child will actually run,
resolved the way the engine resolves it, because the first build never read the model environment
and a review showed that a forced `CLAUDE_CODE_SUBAGENT_MODEL` would have let every spawn through.

What you set: write `quiet` to `.claude/state/pace` to turn the cap on, and `wide` to lift it. Set
`quietCap` or `paces` for other caps, `seatAgent` to reserve the seat model, `ladder` to hold
nested spawns a tier down, and `briefScript` to run your own check on any lane brief a spawn
prompt names, refusing the spawn when the script exits 1.

```sh
mkdir -p .claude/state && echo quiet > .claude/state/pace
```

## lane-fence

The review stage sends reviewer agents over a diff, blind to each other and each cut to its own
files, and then fix lanes work in the same tree. A reviewer needs Bash to run tests, read
`git diff`, and grep. A permission rule can take Write and Edit away from it, but Bash is one tool,
and `sed -i`, a redirect, or `git commit -a` edits code as well as any of them. A reviewer that
fixes what it reviews leaves a diff nobody asked for, can land in a file another lane owns, and
hands back a review that grades its own work. The harness's first answer was a shell guard that
opened one record folder per bundle to its reviewers. It became a mod so the agent's type could
come from the engine's live list and each write could be placed by its real path, since a `..` or
a symbolic link spelled inside a record folder can land anywhere.

On every Bash call from an agent type you named, lane-fence reads what the command writes:
redirects, `tee`, `sed -i`, `cp`, `mv`, `rm`, git subcommands that move the index or a branch, and
inline scripts that carry a file write call. Each target is placed where it lands on disk. A write
outside the agent's record folders, its own memory folder, and tmp is refused before it runs, and
the refusal starts with `fence:` and tells the agent where it may write instead. The main loop and
every agent type you did not name pass untouched.

What you set: `agentTypes`, empty by default so the fence binds nobody, and `recordFolders`,
`.claude/reviews/` by default, where a fenced agent may still write its report. Pair it with a
permission rule that denies Write, Edit, and NotebookEdit to the same agent types.

## lane-blame

The harness ran a test gate at every stop. With one agent writing, a red has one suspect. With a
four-agent test wave in one tree and more lanes in worktrees, the gate blocked whoever stopped
next and made every agent answer for every red. A watch entry named "the stop-suite
gate blaming the wrong lane" stayed open for 26 sightings, and every red it logged was a timeout
or a wall-clock ratio under sibling load, none of them a failing assertion. A declared-red
sentinel let a lane mark tests already known red, and live waves broke its first shape twice
inside the bundle that built it. The gate still could not say who wrote the file.

lane-blame keeps that record. After every Edit, Write, or Bash write under a source root, it stores
the path against the agent that wrote it, keyed per worktree. At each stop, after your own hooks
answer, it runs only the tests beside those writes, maps each failure to whoever wrote the test or
its source, and logs one line: who stopped, what failed, who wrote it, what it would have decided,
and what your real gate said. The status line shows `suite shadow: 1 red, agent_a`. It never
blocks a stop. It runs as a shadow beside the gate you already have, so you can watch where the two
disagree before you trust either one.

What you set: `sourceRoot`, a space-separated list of folders, `src` by default; `testFolder` if
your tests live in a folder beside each source root instead of next to each file; and `runner` if
vitest does not run your tests. The log lands at `/tmp/suite-shadow-<repo folder>.log` unless
`logPath` says otherwise.

## Options per repo

Claude Code hands a plugin its `pluginConfigs` from user settings, so one block in
`~/.claude/settings.json` holds for every repo on the machine. That bit me twice: the first cut of
these mods wrote its options into a project's settings and they never loaded, and one machine
could not run two harnesses with different values. Since 1.1.0 each mod also reads its own block
from the project's `.claude/settings.json` and then `.claude/settings.local.json`, once per
session, and lays it over your user options field by field, the local file over the project file.
A field of the wrong type is ignored and the user value stands. A repo with no block sees nothing
change.

```json
{
  "pluginConfigs": {
    "lane-fence@claude-lanes": {
      "options": {
        "agentTypes": "code-reviewer,security-auditor",
        "recordFolders": ".claude/reviews/"
      }
    }
  }
}
```

Each mod's README carries, under "What this harness sets", the block this repo's own harness sets,
as a worked example. Every option, its default, and what the mod reads, writes, and refuses are in
those READMEs.

## Development

```
claude plugin validate <mod>
claude plugin test <mod>
```

MIT. Not affiliated with Anthropic.
