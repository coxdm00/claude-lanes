# Changelog

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
