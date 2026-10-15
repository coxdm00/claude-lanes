# Changelog

## 1.1.0, 2026-10-15

- A repo can now set its own options. The mod reads the `lane-pace` block under `pluginConfigs` in
  the project's `.claude/settings.json` and `.claude/settings.local.json`, once per session, and
  lays it over your user options field by field, the local file over the project file. A field of
  the wrong type is ignored and your user value stands. A repo with no block sees no change.
- With `seatModel` set to `opus` or `sonnet`, a seat refusal inside a subagent no longer tells it to
  respawn on the model it was just refused for. It names only the models below both its parent and
  the seat.
- The README's "What this harness sets" block is now the project block of the repo that publishes
  the mod, and it loads there through the per-repo read. It sets the ladder, the brief-size script,
  and the `LN` bundle prefix, and leaves the seat rule off.
- The README says what Claude Code's own subagent cap already does, names every verdict key and
  status line text, says the seat rule refuses a built-in with no agent file under a parent on the
  seat model, and installs with one form at project scope. Its threat model names the two project
  settings files the mod now reads.
- Checked on Claude Code 2.1.301.
- The 1.0.0 entry below named the plugin `pace`. It shipped as `lane-pace` in the `claude-lanes`
  marketplace, with keys `lane-pace.verdict.<kind>`, and that line now says so.

## 1.0.0, 2026-10-15

First standalone release, lifted out of the Video Oasis harness where it ran as `vo-pace` 0.4.2.

- Every repo-specific value is a `userConfig` option: the pace file, the quiet cap, the judgment
  seat agent and model, the agents folder, the ladder switch, the brief-size script, its timeout,
  the bundle folder, the bundle prefix, and an override brief pattern.
- The defaults suit a stranger: `seatAgent` empty turns the seat rule off, `ladder` is opt-in,
  `briefScript` is empty, and a missing pace file reads `wide`. The README's "What this harness
  sets" block reproduces the old behaviour.
- The lift hint option is gone: a cap refusal says to write `wide` to the configured pace file.
- Agent pins are read from `~/.claude/agents` after the project folder, and a built-in with no
  agent file is left unchecked by the ladder.
- `seatModel` drops `haiku`, which left a refused spawn no lower model to name, and `quietCap: 0`
  is a cap of zero.
- The brief-size check turns off when `briefScript` is empty.
- The `vo-` prefix is gone: the plugin is `lane-pace` in the `claude-lanes` marketplace, and the
  verdict record keys are `lane-pace.verdict.<kind>` where they were `verdict:<kind>`.
- Refusal text names no person and no ruling file.
- Tests: 94 in all, the inherited cases on the old harness's options, the option pairs, and the
  stranger's defaults.
