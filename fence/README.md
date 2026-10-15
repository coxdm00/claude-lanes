# fence

A Claude Code mod that keeps a read-only subagent read-only when it runs Bash. You name the agent
types that should never change your code, such as a code reviewer or a security auditor, and the
folders each one may still write in, such as a review record and its own notes. Any Bash call from
one of those agents that would write anywhere else is refused before it runs, with a message that
tells the agent where it may write instead. The main loop and every other agent are untouched.

## Why a read-only reviewer needs a Bash fence

A reviewer agent usually needs Bash for real work: running the test suite, reading `git diff`,
grepping the tree. Tool permissions can take Write and Edit away from it, but Bash is one tool, and
`echo fix > src/app.ts`, `sed -i`, `git commit -a`, or a `python3 -c` one-liner can all edit the
code it was only meant to read. A reviewer that quietly fixes what it reviews leaves a diff nobody
asked for and a review that grades its own work. This mod closes that gap by reading what each
Bash command writes and judging every target where it actually lands on disk.

This mod judges Bash alone. Pair it with a permission rule or a settings hook that denies Write,
Edit, and NotebookEdit to the same agent types.

## What it judges

1. **Who.** A call with no agent id is the main loop and passes. Otherwise the agent's type comes
   from the engine's live agent list, the row whose id matches the call, never from a name in a
   prompt. An id the list does not hold passes, and so does any type you did not name.
2. **Where a write may land.** Each record folder pattern, the agent's own memory folder and never
   a sibling's, the session root's tmp folder, and the system tmp folder. Record and memory paths
   are anchored at the session root or at one of its own worktrees, so a lookalike deeper in the
   tree or in another repo is refused. A device such as `/dev/null` writes no file and passes.
3. **The write shapes.** Redirections `>`, `>>`, `>|`, `&>`, `2>`, and `>&file`, while `>&2`,
   `2>&1`, and `>&-` only point a stream. `tee`, `touch`, `mkdir`, `truncate`, `sed -i`,
   `perl -i`, `dd of=`, `rm`, `mv`, `cp`, `install`, a `-t` target folder, a `sh -c` or `eval`
   payload, an inline `python -c`, `node -e`, `bun -e`, or `deno -e` script carrying a file write,
   and a heredoc or here-string fed to an interpreter reading stdin. Wrappers such as `sudo`,
   `env`, `timeout`, `nice`, `xargs`, and `uv run` are seen through. Git subcommands that move the
   index, the work tree, or a ref are refused; `git add` and `git commit` pass only with pathspecs
   inside the record paths.
4. **Placement.** Every target is placed through the file system's real path, one `..` at a time
   the way the shell follows it, so neither a `..` nor a symbolic link climbs out of a record
   folder. A path that cannot be placed is refused, never judged by its spelling.
5. **Links.** A hard link maker, `ln` without `-s`, `cp -l`, or `link`, is refused outright. A
   symbolic link maker, or a copy or extraction that keeps links, `cp -P`, `-a`, `-R`,
   `rsync -a`, and `tar x`, is judged as a write to its destination and refused when another write
   in the same call reaches under it, since the shell would write through a link the fence placed
   too early.
6. **Directory changes.** A `cd` to a literal absolute folder moves the base for relative targets.
   Any other `cd`, `pushd`, or a subshell leaves the base unknown, and a relative write after it is
   refused with the reason.
7. **The stat deadline.** Every file system check a call makes shares one deadline, so a stuck
   mount refuses the write instead of holding the session.
8. **Fail open.** If the fence itself throws, the call goes on. A broken fence never blocks work.

## Install

At the prompt of a terminal session:

```
/plugin install fence --marketplace <owner>/<repo>
```

From a shell:

```
claude plugin install fence --marketplace <owner>/<repo>
```

Answer `y` to add the marketplace, then pick a scope. The options screen comes next. To try it
from a local checkout, start a session with `claude --plugin-dir /path/to/fence`.

## Options

Every option is a `userConfig` field, set on install or later in `/config`. Out of the box the
fence binds nothing: `agentTypes` is empty until you name the agent types to fence. A fenced agent
may then write its records under `.claude/reviews/`, the neutral default for `recordFolders`;
point that option at wherever your reviewers keep their output.

| Option | Default | What it does |
| --- | --- | --- |
| `agentTypes` | empty | Comma-separated subagent types the fence binds. Empty binds none. |
| `recordFolders` | `.claude/reviews/` | Comma-separated folder patterns under the session root a fenced agent may write in. A `*` matches one or more characters inside one path segment. |
| `memoryRoot` | `.claude/agent-memory` | Folder holding one memory folder per agent type. Each fenced agent may write only its own. Empty turns this off. |
| `worktreesDir` | `.claude/worktrees` | Folder of the repo's own worktrees, where a record path counts too. Empty anchors at the session root alone. |
| `rootTmp` | `tmp` | Scratch folder under the session root. Empty turns it off. |
| `systemTmp` | `/tmp` | Absolute scratch folder. Empty turns it off. |
| `statDeadlineMs` | `2000` | The longest one call waits on the file system before a stalled check is refused. |

## What this harness sets

The defaults are neutral. The harness this mod was first built for fences five reviewer types and
keeps each bundle's records under `.claude/features/CC-NNN/`, so it sets two options:

```json
{
  "pluginConfigs": {
    "fence": {
      "options": {
        "agentTypes": "code-reviewer,performance-reviewer,security-auditor,voice-reviewer,design-critic",
        "recordFolders": ".claude/features/CC-*/"
      }
    }
  }
}
```

## Checked builds

Validated and tested against Claude Code 2.1.300.

## Footprint

What `claude plugin validate .` prints for the module:

```
❯ ./register.ts hooks: tool.call{tool=Bash}, turn.complete
❯ ./register.ts gating hook with .catch: tool.call{tool=Bash}
❯ ./register.ts calls: $.agent.list, $.clock.sleep, $.fs.stat, $.session.cwd, $.session.root, $.ui.status
```

## Threat model

- **Reads:** the Bash command text, the live agent list, the session root and working folder, and file metadata through `$.fs.stat`.
- **Writes:** nothing to disk; it sets one status line entry on a refusal and clears it at the main loop's turn end.
- **Refuses:** a fenced agent's Bash call whose write would land outside its record paths, or that it cannot place.
- **Never:** reads file contents, touches the network, spawns processes, or judges the main loop or an unnamed agent type.
- **Limits:** a static reading of shell text, so a script run from a file or a command built at run time can still write; it narrows a reviewer's reach and does not replace a sandbox.

## Tests

`claude plugin validate . && claude plugin test .` runs the suite: every write shape, the record
paths, placement through links and `..`, the link makers, the stat deadline, and each option at its
default and at a value of its own.

## License

MIT, see `LICENSE`.
