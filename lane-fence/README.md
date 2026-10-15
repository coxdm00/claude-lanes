# lane-fence

A Claude Code mod that keeps a read-only subagent read-only when it runs Bash. You name the agent
types that should never change your code, such as a code reviewer or a security auditor, and the
folders each one may still write in, such as a review record and its own notes. A Bash call from
one of those agents that writes anywhere else, by any of the write shapes listed below, is refused
before it runs, with a message that tells the agent where it may write instead. An inline script
that carries a file write call is refused wherever it writes, the record folders included, since
the fence cannot place a path a script builds. The main loop and every other agent are untouched.

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
   `perl -i`, `dd of=`, `rm`, `mv`, `cp`, `install`, `rsync`, a `-t` target folder, and a `sh -c`
   or `eval` payload. An inline `python -c`, `node -e`, `bun -e`, or `deno eval` script, or a
   heredoc or here-string fed to one of those interpreters reading stdin, is refused when it
   carries a file write call, wherever that write lands. Wrappers such as `sudo`, `env`,
   `timeout`, `nice`, `xargs`, and `uv run` are seen through. Git subcommands that move the index,
   the work tree, or a local branch or tag are refused, and `git branch` and `git tag` pass only as
   a listing; `git add` and `git commit` pass only with pathspecs inside the record paths.
4. **Placement.** Every target is placed through the file system's real path, one `..` at a time
   the way the shell follows it, so neither a `..` nor a symbolic link climbs out of a record
   folder. A path that cannot be placed is refused, never judged by its spelling. That includes a
   target the shell builds at run time, such as `~/notes.md`, `$OUT`, or `$(pwd)/x.ts`.
5. **Links.** A hard link maker, `ln` without `-s`, `cp -l`, or `link`, is refused outright. A
   symbolic link maker, or a copy or extraction that keeps links, `cp -P`, `-a`, `-R`,
   `rsync -a`, and `tar x`, is judged as a write to its destination and refused when another write
   in the same call reaches under it, since the shell would write through a link the fence placed
   too early. A `mv` of a link is refused, since the link carries its target wherever it arrives.
6. **Directory changes.** A `cd` to a literal absolute folder moves the base for relative targets.
   Any other `cd`, `pushd`, `popd`, or a subshell leaves the base unknown, and a relative write
   after it is refused with the reason.
7. **The stat deadline.** Every file system check a call makes shares one deadline, so a stuck
   mount refuses the write instead of holding the session.
8. **Fail open.** If the fence itself throws, the call goes on. A broken fence never blocks work.

Every refusal is a deny text that starts with `fence:`, says why, and tells the agent what it may
do instead. The status line shows the same refusal as `fence refused <type>: <what>` until the main
loop's turn ends.

## Install

```
claude plugin marketplace add coxdm00/claude-lanes
claude plugin install lane-fence@claude-lanes --scope project
```

Then set the options under `/config`, or in the project block described under "Per-repo options".
To try it from a local checkout instead, start a session with
`claude --plugin-dir /path/to/claude-lanes/lane-fence`.

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

## Per-repo options

Claude Code reads `pluginConfigs` from your user settings, `~/.claude/settings.json`, so the
options above are machine-wide: every repo on one machine runs the same block. This mod also reads
the project's own settings through the engine, `.claude/settings.json` and then
`.claude/settings.local.json`, and takes its own block from each, the entry under `pluginConfigs`
whose key is `lane-fence@claude-lanes` or any key whose name before the `@` is `lane-fence`, the
first one in the file. A field set there wins over the user value, the local file over the project
file, field by field. A field of the wrong type is ignored, as the engine ignores one, and a list
option, `agentTypes` or `recordFolders`, takes a JSON array as well as its comma string. The read
happens once per session, at the first Bash call a subagent makes, so a change to either file takes
effect at the next session. A missing block changes nothing, and a file the engine cannot read
leaves the options beneath it standing.

## What this harness sets

The repo this mod ships from runs it on its own work. Its project `.claude/settings.json` carries
the block below, and it loads here through the per-repo read above. It fences the three reviewer
agent types that harness defines, and opens each bundle's folder under `.claude/features/` as a
record path:

```json
{
  "pluginConfigs": {
    "lane-fence@claude-lanes": {
      "options": {
        "agentTypes": "code-reviewer,performance-reviewer,security-auditor",
        "recordFolders": ".claude/features/LN-*/"
      }
    }
  }
}
```

## Checked on

Checked on Claude Code 2.1.301.

## Footprint

What `claude plugin validate` prints for the module:

```
  ❯ ./register.ts hooks: tool.call{tool=Bash}, turn.complete
  ❯ ./register.ts gating hook with .catch: tool.call{tool=Bash}
  ❯ ./register.ts calls: $.agent.list, $.clock.sleep, $.fs.stat, $.session.cwd, $.session.root, $.settings.read, $.ui.status
```

## Threat model

- **Reads:** the Bash command text, the live agent list, the session root and working folder, file metadata through `$.fs.stat`, the hook's remaining time budget, and a timer through `$.clock.sleep` for the stat deadline. Once per session it reads the project's `.claude/settings.json` and `.claude/settings.local.json` through `$.settings.read`; the engine hands each file whole, and the mod takes its own `lane-fence` block from it and nothing else.
- **Writes:** nothing to disk; it sets one status line entry on a refusal and clears it at the main loop's turn end.
- **Runs:** nothing. It spawns no process.
- **Refuses:** a fenced agent's Bash call whose write lands outside its record paths or cannot be placed, a git subcommand that moves the index, the work tree, or a local branch or tag, a hard link, a link made in the same call as a write through it, a moved link, a relative write after a `cd` it cannot follow, and any inline script that carries a file write call.
- **Never:** reads file contents, touches the network, or judges the main loop or an unnamed agent type.
- **Limits:** a static reading of shell text. A script run from a file, a heredoc or here-string fed to a shell such as `bash <<EOF`, a command the shell builds at run time, and a writer this mod does not list, such as `patch`, `curl -o`, `wget -O`, or `unzip`, can still write. `git fetch`, `git notes`, and `git config` write inside `.git` and pass. It narrows a reviewer's reach and does not replace a sandbox.

## Tests

`claude plugin validate .` and then `claude plugin test .` run the suite: every write shape, the
record paths, placement through links and `..`, the link makers, the stat deadline, each option at
its default and at a value of its own, and the per-repo block over the user options.

## License

MIT, see `LICENSE`.
