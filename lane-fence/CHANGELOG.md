# Changelog

## 1.1.0 (2026-10-15)

- Per-repo options: the mod now reads its own `lane-fence` block from the project's `.claude/settings.json` and `.claude/settings.local.json`, once per session, and lays it over your `/config` values field by field, the local file winning over the project file. A field of the wrong type is ignored, and `agentTypes` and `recordFolders` take a JSON array as well as a comma string. With no block, nothing changes.
- A write target the shell builds at run time, such as `~/notes.md`, `$OUT`, or `$(pwd)/x.ts`, is now refused as unplaceable instead of passing.
- `git branch` and `git tag` that create, move, or delete a ref are now refused, and so is `git update-ref`; a listing such as `git branch -a` or `git tag -l` still passes.
- A plain `rsync` is now judged as a write to its destination; before, only `rsync -a` and `-l` were seen.
- `deno eval` is now read as deno's inline script form, and `Deno.writeTextFile` and `Deno.remove` count as write calls.
- The README's worked example is now the block this repo's own project settings carry, and it loads through the per-repo read. The README also says what the status entry reads, `fence refused <type>: <what>`, since only the deny texts lead with `fence:`.

## 1.0.0 (2026-10-15)

- First standalone release, a repo-agnostic copy of a fence first built for one project.
- A read-only agent type's Bash writes are refused outside its record paths, the agent identified from the engine's live agent list.
- Every target is placed where it lands, so no `..` or link climbs out, with the device rule, worktree anchoring, and a shared stat deadline.
- Seven `userConfig` options replace the hardcoded values: `agentTypes`, `recordFolders`, `memoryRoot`, `worktreesDir`, `rootTmp`, `systemTmp`, and `statDeadlineMs`, with neutral defaults: `agentTypes` empty, so the fence binds nothing until set, and `recordFolders` at `.claude/reviews/`.
- Deny text and status entries lead with `fence:`.
