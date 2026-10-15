# Changelog

## 1.1.0, 2026-10-15

- Options can now be set per repo. The mod reads its own `pluginConfigs` block from the project's
  `.claude/settings.json` and then `.claude/settings.local.json`, once per session, and lays it
  over your user options field by field, the local file over the project file over the user
  value. A field of the wrong type is ignored, a list option takes a JSON array as well as its
  string form, and a repo with no block runs exactly as before. A change to either file takes
  effect at the next session.
- `sourceRoot` takes a space-separated list of folders, one or more, and records and tests under
  each of them. Its default stays `src`.
- A new option, `testFolder`, empty by default, for a repo that keeps its tests in a folder beside
  each source root. Set to `tests`, a write under `lane-pace/hooks` runs every test file under
  `lane-pace/tests/`, an edit to a test there is recorded and runs itself, and a red run names
  every writer recorded under that root. A runner whose output names no failing file, such as
  `claude plugin test`, still gets its red attributed. Left empty, the sibling rule is unchanged.
- The red status entry now clears when a stop finds every recorded path committed clean. Before,
  it stayed drawn until some later stop ran the tests again.
- Where the log lands, said plainly: with `logPath` left at its default, the file you find is
  `/tmp/suite-shadow-<repo folder>.log`, one per repo, for example
  `/tmp/suite-shadow-my-app.log`. The manifest still lists `/tmp/suite-shadow.log` as the default,
  and that value is rewritten to the per-repo name. The 1.0.0 entry below named the unrewritten
  path.
- Checked on Claude Code 2.1.301.

## 1.0.0, 2026-10-15

First standalone release.

- Records every write under the source root against its writer, the main loop as `coordinator`
  and each subagent by its agent id, across Edit, Write, MultiEdit, NotebookEdit, and a best-effort
  read of writing Bash commands.
- Keys a worktree lane's writes by its tree, holds a lane's relative Bash targets until the
  `SubagentStop` that names its working directory, and drops the records of a removed worktree.
- Runs the tests beside the recorded writes at every `Stop` and `SubagentStop`, in the stopping
  tree, under a wait ceiling, with one memo per tree keyed on the paths, the write count, and HEAD.
- Subtracts a declared-red sentinel, logs one tab-separated line per stop beside the shell gate's
  answer, and pins a status entry naming the owners of any undeclared red. Never blocks.
- Every repo-specific value is a `userConfig` option: `sourceRoot`, `testSuffixes`, `runner`,
  `logPath`, `worktreeDir`, `runTimeoutSeconds`, `sentinelPrefix`, `sentinelTtlSeconds`, and
  `gatePhrase`. The sentinel and the gate phrase default to empty, and the log defaults to
  `/tmp/suite-shadow.log`, outside the work tree.
- 44 tests under `claude plugin test`, one default case and one non-default case per option.
- Checked on Claude Code 2.1.300.
