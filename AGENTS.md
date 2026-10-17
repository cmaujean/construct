# Working on construct

General rules, operator calibration, active Personality ROM (`~/.config/opencode/active-rom.md`), and
global gotchas are managed by `construct` itself and loaded through `~/.config/opencode/AGENTS.md`.

- **Run tests** with `npm test` (`node --test "test/*.test.js"`) after every change and report the
  pass/fail counts.
- **Never test or probe against `~/.config/opencode/construct.db`**, which holds live sequential
  memory across every project. Always point `CONSTRUCT_DB`, `CONSTRUCT_ROM_FILE`, and
  `CONSTRUCT_IDENTITY_FILE` at temporary paths when experimenting or running tests.
- **Keep this repository 100% generic.** Never commit personal usernames, local machine paths, or
  project-specific data into `src/` or `test/`.
- **Zero external dependencies.** Keep `construct` built purely on Node's built-in `node:sqlite`,
  `node:crypto`, and `WebSocket` (`Node >= 22.5`).
