# Changelog

## 1.0.0 (2026-10-15)

- First standalone release, a repo-agnostic copy of a fence first built for one project.
- A read-only agent type's Bash writes are refused outside its record paths, the agent identified from the engine's live agent list.
- Every target is placed where it lands, so no `..` or link climbs out, with the device rule, worktree anchoring, and a shared stat deadline.
- Seven `userConfig` options replace the hardcoded values: `agentTypes`, `recordFolders`, `memoryRoot`, `worktreesDir`, `rootTmp`, `systemTmp`, and `statDeadlineMs`, with neutral defaults: `agentTypes` empty, so the fence binds nothing until set, and `recordFolders` at `.claude/reviews/`.
- Deny text and status entries lead with `fence:`.
