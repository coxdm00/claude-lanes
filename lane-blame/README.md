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
   or `install`, every written path under a source root is stored in `$.state` under
   `lane-blame.writes` against its writer, and with `testFolder` set every written path under the
   tests folder beside a root as well. Only the extensions the test suffixes imply are recorded,
   `.ts` and `.tsx` by default, so a test file records because it shares its source's extension and
   any `.ts` file under a root records too. A denied call records nothing.
2. **The trees.** A write under the worktree folder records against that worktree, so two trees
   never share a key. A subagent's relative Bash targets wait in `lane-blame.held` until its
   `SubagentStop` names the working directory they resolve against.
3. **The scoped run.** At `Stop` and `SubagentStop`, after the shell hooks answer, the mod runs the
   configured runner from the stopping tree's root over the test files of the recorded writes. A
   written test is its own. With `testFolder` empty a source runs the sibling tests that exist
   beside it. With `testFolder` set, any other write under a root or its tests folder runs every
   test file the folder holds, found by listing it. The run never takes the whole suite, and it
   gives up at the wait ceiling.
4. **The declared-red sentinel.** Off until `sentinelPrefix` is set. If a file at the sentinel
   prefix plus the first 16 hex characters of the SHA-256 of the tree's path holds a fresh epoch line followed by test paths, those tests
   are already known red and are subtracted before the verdict.
5. **The memo.** A stop with no new write and no new commit since the last judged stop reuses that
   result. A commit prunes recorded paths that git now reports clean.
6. **The log and the status.** One tab-separated line per stop, idle stops included, goes to the
   log path, `/tmp/suite-shadow-<repo folder>.log` by default, one file per repo, so nothing lands
   in your work tree. A stop the engine raises again while its own stop hook is still answering,
   with `stop_hook_active` set, is passed over and logs nothing. Set `logPath` to a repo path such
   as `.claude/state/suite-shadow.log` to keep it beside the code, and add that path to
   `.gitignore`. The status line shows `suite shadow: 1 red, agent_a` until a stop judges the
   record clean, a stop that finds every recorded path committed among them.

A log line reads as below, its nine fields split by tabs:

```
2026-10-15T19:02:11.000Z	stop=agent_a	failing=src/lib/a.test.ts	declared=none	writers=src/lib/a.ts:agent_a	would=block	shell=suite	load=3.10	run=vitest run src/lib/a.test.ts exit 1
```

`would` is `block`, `pass`, `unknown` when the run itself failed, `timeout`, `memo`, or `skip` when
nothing was armed. The failing files come from the runner's `FAIL` lines. A run that exits red
while its output names no failing file under a root reads `block`, names no owner, and draws no
status entry, unless `testFolder` is set: then every test file that ran counts as failing, so the red names every writer
recorded under each root whose tests ran. That is the case for a runner such as
`claude plugin test`, whose output names no file. `shell` is `pass` when no hook spoke. With
`gatePhrase` unset, any block or advisory reads `gate`. With it set, the column reads `suite` when
the hook's text holds the phrase and `other:` with its first five words otherwise.

## Install

```
claude plugin marketplace add coxdm00/claude-lanes
claude plugin install lane-blame@claude-lanes --scope project
```

Every option has a default, so a repo with vitest tests under `src/` needs no setup.

## Options

Each option is a row under `/config`, which writes `pluginConfigs["lane-blame@claude-lanes"].options`
in your user settings, or per repo as the next section says.

| option | default | what it sets |
| :- | :- | :- |
| `sourceRoot` | `src` | Space-separated folders inside each tree whose writes are recorded, one or more. Empty records writes anywhere. |
| `testFolder` | empty | A tests folder beside each source root, such as `tests`, for a repo that keeps tests apart from sources. Empty keeps the sibling rule below. Set, a write under a source root runs every test file under `<the root's parent>/<testFolder>/` whose name ends in a test suffix, a write under that folder is recorded too, and a red run names every writer recorded under that root. |
| `testSuffixes` | `.test.ts .test.tsx` | Space-separated test suffixes. A source's sibling test swaps its extension for the matching suffix, and only those extensions are recorded. |
| `runner` | `./node_modules/.bin/vitest run` | The command run from the tree's root with the test files appended. |
| `logPath` | `/tmp/suite-shadow.log` | Where the log lines go. The default is rewritten to `/tmp/suite-shadow-<repo folder>.log`, one file per repo, so nothing lands in your work tree and two repos never share a file; a hand-set value equal to the default is rewritten the same way. Any other absolute path lands as written, a relative one joins the main tree's root. |
| `worktreeDir` | `.claude/worktrees` | The folder holding one subfolder per worktree lane. |
| `runTimeoutSeconds` | `60` | How long a stop waits on the scoped run. |
| `sentinelPrefix` | empty | The declared-red sentinel's path prefix. Empty reads no sentinel. |
| `sentinelTtlSeconds` | `1800` | A sentinel this old or older declares nothing. |
| `gatePhrase` | empty | The phrase your shell test gate prints when the suite is red. Empty reads any block as `gate`. |

## Per-repo options

Claude Code reads `pluginConfigs` from your user settings, `~/.claude/settings.json`, so the
options above are machine-wide: every repo on one machine runs the same block. This mod also reads
the project's own settings through the engine, `.claude/settings.json` and then
`.claude/settings.local.json` at the session root, and takes its own block from each, the entry
under `pluginConfigs` whose key is `lane-blame@claude-lanes` or any key whose name before the `@` is
`lane-blame`. A field set there wins over the user value, the local file over the project file, field
by field. A field of the wrong type is ignored, as the engine ignores one, and a list option,
`sourceRoot`, `testSuffixes`, or `runner`, takes a JSON array of strings as well as its string form.
The read happens once per session, at the first write or stop the mod sees, so a change to either file takes effect at the next session. A missing block changes nothing, and a
block the engine cannot read leaves the user options standing. The block under "What this harness
sets" is this repo's project block, and it is the one that loads here.

## What this harness sets

The defaults are neutral. The repo this mod ships from keeps its three mods side by side, each
with its hooks under `<mod>/hooks/` and its tests under `<mod>/tests/`, and runs them with
`claude plugin test`. Its project `.claude/settings.json` carries the block below, and the
per-repo read above is what loads it here, with no user setting needed:

```json
{
  "pluginConfigs": {
    "lane-blame@claude-lanes": {
      "options": {
        "sourceRoot": "lane-pace/hooks lane-fence/hooks lane-blame/hooks",
        "testFolder": "tests",
        "testSuffixes": ".test.ts .test.tsx",
        "runner": "bash .claude/hooks/lib/suite-runner.sh",
        "logPath": ".claude/state/suite-shadow.log"
      }
    }
  }
}
```

## Checked on

Checked on Claude Code 2.1.301: `claude plugin validate lane-blame` and
`claude plugin test lane-blame` both exit 0 from the repo root.

## Footprint

What `claude plugin validate lane-blame` prints for the module:

```
./register.ts hooks: tool.call, classic.Stop, classic.SubagentStop, turn.complete
./register.ts calls: $.agent.list (via ioOf), $.clock.now (via ioOf), $.fs.exists (via ioOf), $.fs.list (via ioOf), $.fs.read (via ioOf), $.fs.write (via ioOf), $.process.run (via ioOf), $.session.cwd, $.session.root, $.settings.read (via overridesOf), $.state.get, $.state.set, $.ui.status
```

Where an organization manages Claude Code, the `classic.Stop` and `classic.SubagentStop` hooks run
only when the organization lists the plugin in managed settings. The write record still works
there, but no stop is judged.

## Threat model

- **Reads:** tool call inputs, `/proc/loadavg`, the sentinel file, the log, the live agent list,
  the session root and working directory, its own `lane-blame.*` keys in session state, whether
  each mapped test file and each other recorded worktree's root exists, and the listing of each
  tests folder when `testFolder` is set. Once per session it reads the project's
  `.claude/settings.json` and `.claude/settings.local.json` through the engine. The engine hands
  each file over whole, and the mod takes its own `pluginConfigs` block and nothing else from them.
- **Writes:** the one log file at `logPath`, the status line entry, and its own keys in session
  state: `lane-blame.writes`, `lane-blame.seq`, `lane-blame.memo`, `lane-blame.held`, and
  `lane-blame.last`.
- **Runs:** `git rev-parse HEAD`, `git status --porcelain --untracked-files=all` over the recorded
  paths, and the configured runner over the mapped test files, each in the stopping tree.
- **Refuses:** nothing. Every hook hands the event on, and a failure inside the shadow leaves the shell's answer as it came.
- **Never:** blocks a stop, rewrites a tool call or its result, touches the network, or edits a source file.

## Tests

`tests/suite.test.ts` runs under `claude plugin test lane-blame`: the write record by writer, the
worktree split and the held relative targets, the scoped file set, the memo and pruning, the
sentinel subtraction, the shell column, the never-blocks guarantee, the log shape and rotation,
the status redraw and its clearing, the per-repo read with its layers and its refusals, the list
of roots and the tests folder, and one default case and one non-default case per option.

## License

MIT, see `LICENSE`.
