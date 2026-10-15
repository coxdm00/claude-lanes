# Changelog

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
- The `vo-` prefix is gone: the plugin is `pace`, and the verdict record keys are
  `pace.verdict.<kind>` where they were `verdict:<kind>`.
- Refusal text names no person and no ruling file.
- Tests: 94 in all, the inherited cases on the old harness's options, the option pairs, and the
  stranger's defaults.
