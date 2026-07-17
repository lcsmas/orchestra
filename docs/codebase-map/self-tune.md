# Insights & Improvements (monthly self-tune)

Orchestra-native monthly Claude Code self-tuning (replaces the user's old
systemd timer): for every login run a headless `claude -p "/insights"` to
regenerate that login's usage report, then ONE fold pass that distills new
friction lessons into `~/.claude/LESSONS.md` and appends a summary to
`~/.claude/usage-data/self-tune.log`.
Files: `src/shared/self-tune.ts` (+ `.test.ts`, pure logic),
`src/main/self-tune.ts` (pipeline), `src/renderer/components/Insights.tsx` (UI).

## Pure logic — shared/self-tune.ts
Dependency-free (testable under `node --test`):
- `enumerateSelfTuneLogins(accounts, home, env)` `:93` — default login
  (`~/.claude`) always first, then each account whose `configDir` template
  expands non-empty (via `expandConfigDir`), deduped. Existence-on-disk is
  filtered later in main (`usableLogins`).
- `isSelfTuneDue(lastSuccessAt, now)` `:69` — due iff no successful run in the
  current calendar month (local time). `lastSuccessAt(runs)` `:78` feeds it.
- `newestReport(fileNames)` `:110` — reports are `report-YYYY-MM-DD-HHMMSS.html`
  so a lexicographic sort is chronological; bare `report.html` is a fallback.
- `buildFoldPrompt(reports, home)` `:145` — the fold-pass prompt: lists every
  login's newest report explicitly, dedupes lessons ACROSS logins, follows
  LESSONS.md's own rules, and asks for a final `SELF-TUNE-RESULT: <outcome>`
  marker line; `parseFoldSummary(output)` `:129` extracts it (last marker wins)
  for the UI's "Jul 18 · 2 lessons added" row.
- Types: `SelfTuneRun` (id/trigger/status/steps/summary), `SelfTuneStep`
  (`insights:<loginId>` per login + one `fold`), `SelfTuneReport`.

## Pipeline — main/self-tune.ts
- `startSelfTuneRun(trigger)` `:239` — one run at a time (throws while one is
  in flight). Sequentially spawns `claude -p "/insights"
  --dangerously-skip-permissions` per login (`executeRun` `:180`), then the one
  fold pass under the default login. `CLAUDE_CONFIG_DIR` is deliberately
  *deleted* from the env for the default login and the fold, and set to the
  login dir for alternate accounts (`runStep` `:158`). A failed insights step
  is tolerated (fold reads the newest *existing* report); the run's status is
  the fold's status.
- **Test seam**: `ORCHESTRA_SELF_TUNE_CMD` overrides the `claude` executable
  (`claudeCmd` `:41`) so tests/e2e drive the full pipeline with a fast fake.
- **Transcript**: per-run in-memory ring buffer (512 KB tail) mirrored to
  `<userData>/orchestra/self-tune/<runId>.log`; chunks stream to the renderer
  as `selfTune:output` events, `getSelfTuneOutput(runId)` `:82` falls back to
  the file after a restart.
- **Persistence**: runs upsert into `store.selfTuneRuns` on every step
  transition (`store.ts saveSelfTuneRun`, bounded to 24) and broadcast as
  `selfTune:update`; a `running` run found at startup is swept to `failed`
  (child processes don't survive restarts).
- **Scheduler**: `startSelfTuneScheduler(window)` `:295` — 15s after startup
  and every 6h, auto-start iff `isSelfTuneDue` against the persisted history.
- IPC (registered in `index.ts` next to `usage:get`): `selfTune:list` / `run` /
  `output` / `reports` / `openReport` (shell.openPath on the newest report) /
  `lessons` (reads `~/.claude/LESSONS.md`); push events `selfTune:update`,
  `selfTune:output`.

## UI — renderer/components/Insights.tsx
- `InsightsSection` — sidebar entry between the workspace list and the usage
  bars (sparkle icon): idle → one row with the last outcome ("Jul 18 · 2
  lessons added"); running → one status row per step (spinner/✓/✕).
- `InsightsView` — main-pane view opened by the row. Rendered as an *overlay*
  (`.insights-view`, absolute over `.main`) rather than a route swap so the
  kept-alive TerminalViews' xterm scrollback survives. Shows the selected
  run's steps + live transcript (seed via `getSelfTuneOutput`, then
  `onSelfTuneOutput` appends), a Run-now button, per-login "open report"
  buttons, click-to-select run history, and a read-only LESSONS.md panel.
- Store: `selfTuneRuns` (hydrated on load, upserted by `selfTune:update`,
  newest first) + `insightsOpen`; `setActive` closes the pane.

## Tests
`shared/self-tune.test.ts` covers due-date math (same/different month & year),
`lastSuccessAt`, login enumeration (expansion, dedupe, empty skip),
`newestReport` ordering + fallbacks, the fold prompt contract (report list,
cross-login dedupe wording, marker), and `parseFoldSummary`.
