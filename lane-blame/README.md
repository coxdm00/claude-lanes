# lane-blame

A Claude Code mod that remembers which agent wrote each source file and, every time the main loop
or a subagent stops, runs only the tests beside those writes. When a test is red, the log and the
status line name who wrote it. It never blocks a stop and never changes what another hook
answered. It sits beside whatever test gate you already run and writes down what that gate could
not see.

## Why attribution matters

With one agent writing code, a red suite has one suspect. Hand work to three subagents in
parallel, some of them in their own git worktrees, and a red suite at the end of the turn could
belong to any of them, to the main loop, or to nobody in this session at all. A plain test gate
sees a red tree and blocks whoever happens to stop next, which is often the wrong agent. That
agent then burns its turn fixing someone else's file, or the fix lands twice.

This mod keeps a record of every write by its writer. At a stop it maps each failing test back to
whoever wrote the test or the source file beside it. A red whose writer is another subagent still
running would be excused, since that lane has not finished. A red written by the agent that is
stopping, or by nobody, would block. The mod logs that verdict next to the one your shell gate
actually gave, so you can see where they disagree before you trust either one.

## What it does

1. **The write record.** After an Edit, Write, MultiEdit, or NotebookEdit call succeeds, and after
   a Bash call that writes through a redirect, `tee`, `touch`, `rm`, `sed -i`, `perl -i`, `cp`, `mv`,
   or `install`, every written path under the source root with a test extension is stored in
   `$.state` under `lane-blame.writes` against its writer. A denied call records nothing.
2. **The trees.** A write under the worktree folder records against that worktree, so two trees
   never share a key. A subagent's relative Bash targets wait in `lane-blame.held` until its
   `SubagentStop` names the working directory they resolve against.
3. **The scoped run.** At `Stop` and `SubagentStop`, after the shell hooks answer, the mod runs the
   configured runner from the stopping tree's root over the test files beside the recorded writes.
   It never runs the whole suite, and it gives up at the wait ceiling.
4. **The declared-red sentinel.** Off until `sentinelPrefix` is set. If a file at the sentinel prefix plus the first 16 hex characters
   of the SHA-256 of the tree's path holds a fresh epoch line followed by test paths, those tests
   are already known red and are subtracted before the verdict.
5. **The memo.** A stop with no new write and no new commit since the last judged stop reuses that
   result. A commit prunes recorded paths that git now reports clean.
6. **The log and the status.** One tab-separated line per stop, idle stops included, goes to the
   log path, `/tmp/suite-shadow-<repo folder>.log` by default, one file per repo, so nothing lands in your work tree. Set `logPath`
   to a repo path such as `.claude/state/suite-shadow.log` to keep it beside the code, and add that
   path to `.gitignore`. The status line shows `suite shadow: 1 red, agent_a` until a stop judges the record clean.

A log line reads:

```
2026-10-15T19:02:11.000Z  stop=agent_a  failing=src/lib/a.test.ts  declared=none  writers=src/lib/a.ts:agent_a  would=block  shell=suite  load=3.10  run=vitest run src/lib/a.test.ts exit 1
```

`would` is `block`, `pass`, `unknown` when the run itself failed, `timeout`, `memo`, or `skip` when
nothing was armed. `shell` is `pass` when no hook spoke. With `gatePhrase` unset, any block or advisory reads
`gate`. With it set, the column reads `suite` when the hook's text holds the phrase and `other:`
with its first five words otherwise.

## Install

```
claude plugin marketplace add coxdm00/claude-lanes
claude plugin install lane-blame@claude-lanes --scope project
```

At a terminal session's prompt, `/plugin install lane-blame --marketplace coxdm00/claude-lanes` does the
same. Every option has a default, so a repo with vitest tests under `src/` needs no setup.

## Options

Each option is a row under `/config`, stored in settings under `pluginConfigs.suite.options`.

| option | default | what it sets |
| :- | :- | :- |
| `sourceRoot` | `src` | The folder inside each tree whose writes are recorded. Empty records writes anywhere. |
| `testSuffixes` | `.test.ts .test.tsx` | Space-separated test suffixes. A source's sibling test swaps its extension for the matching suffix, and only those extensions are recorded. |
| `runner` | `./node_modules/.bin/vitest run` | The command run from the tree's root with the test files appended. |
| `logPath` | `/tmp/suite-shadow-<repo folder>.log` | Where the log lines go. An absolute path lands as written, a relative one joins the main tree's root. |
| `worktreeDir` | `.claude/worktrees` | The folder holding one subfolder per worktree lane. |
| `runTimeoutSeconds` | `60` | How long a stop waits on the scoped run. |
| `sentinelPrefix` | empty | The declared-red sentinel's path prefix. Empty reads no sentinel. |
| `sentinelTtlSeconds` | `1800` | A sentinel this old or older declares nothing. |
| `gatePhrase` | empty | The phrase your shell test gate prints when the suite is red. Empty reads any block as `gate`. |

## What this harness sets

The defaults are neutral. The harness this mod was first built for sets three options, which
restore its old behaviour:

```json
{
  "pluginConfigs": {
    "lane-blame@claude-lanes": {
      "options": {
        "sentinelPrefix": "/tmp/canon-declared-red-",
        "gatePhrase": "red before ending the turn",
        "logPath": ".claude/state/suite-shadow.log"
      }
    }
  }
}
```

## Checked builds

Checked on Claude Code 2.1.300: `claude plugin validate .` passes and `claude plugin test .` runs 44
tests green.

## Footprint

What `claude plugin validate .` prints for the module:

```
./register.ts hooks: tool.call, classic.Stop, classic.SubagentStop, turn.complete
./register.ts calls: $.agent.list (via ioOf), $.clock.now (via ioOf), $.fs.exists (via ioOf), $.fs.read (via ioOf), $.fs.write (via ioOf), $.process.run (via ioOf), $.session.cwd, $.session.root, $.state.get, $.state.set, $.ui.status
```

Where an organization manages Claude Code, the `classic.Stop` and `classic.SubagentStop` hooks run
only when the organization lists the plugin in managed settings. The write record still works
there, but no stop is judged.

## Threat model

- **Reads:** tool call inputs, `/proc/loadavg`, the sentinel file, the log, and the live agent list.
- **Writes:** the one log file at `logPath` and its own `suite.*` keys in session state.
- **Runs:** `git rev-parse HEAD`, `git status --porcelain` over recorded paths, and the configured runner over recorded test files, each in the stopping tree.
- **Refuses:** nothing. Every hook hands the event on, and a failure inside the shadow leaves the shell's answer as it came.
- **Never:** blocks a stop, rewrites a tool call or its result, touches the network, or edits a source file.

## Tests

`tests/suite.test.ts` holds 44 cases under `claude plugin test .`: the write record by writer, the
worktree split and the held relative targets, the scoped file set, the memo and pruning, the
sentinel subtraction, the shell column, the never-blocks guarantee, the log shape and rotation,
the status redraw, and one default case and one non-default case per option.

## License

MIT, see `LICENSE`.
