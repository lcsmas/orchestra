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
- Lessons diff: `parseLessonBullets(content)` / `diffLessons(before, after)`
  `:224` — bullet-set diff of LESSONS.md around the fold (exact-text identity:
  a reworded bullet = removed + added), stored on the run as
  `SelfTuneRun.lessons` (`LessonsDiff` `:48`: added/removed/total);
  `summarizeLessonsDiff(diff)` is the run-summary fallback when the fold never
  printed its marker line.
- `ensureLessonsImport(claudeMd)` `:203` — returns the global CLAUDE.md content
  to write so it `@LESSONS.md`-imports lessons (creates-from-scratch on null,
  appends when missing), or null when already present. `LESSONS_BOOTSTRAP`
  `:130` is the canonical header for a fresh LESSONS.md.
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
- After the fold: LESSONS.md is snapshotted just before the fold spawn (post
  `ensureFoldTargets` so a fresh bootstrap isn't a "change") and re-read after;
  `diffLessons` fills `run.lessons`, and `summarizeLessonsDiff` supplies
  `run.summary` when no `SELF-TUNE-RESULT:` marker was printed on an ok run.
- **Bootstrap on bare machines**: `ensureFoldTargets(home)` `:161` runs just
  before the fold spawn — creates `~/.claude/LESSONS.md` (canonical header),
  the `usage-data/` dir, and ensures the global `~/.claude/CLAUDE.md`
  `@LESSONS.md` import exists (creating CLAUDE.md if absent). Without that
  import the fold would write lessons no session ever loads; the fold prompt
  forbids the agent itself from touching CLAUDE.md, so main does it.
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
  The shown run's `lessons` diff renders as a "LESSONS.md changes" block
  (+added / −removed bullets); the LESSONS.md panel header counts bullets and
  flags "N new since the last run", highlighting those bullets in the text
  (matched by exact bullet text against the newest run's `lessons.added`).
- Store: `selfTuneRuns` (hydrated on load, upserted by `selfTune:update`,
  newest first) + `insightsOpen`; `setActive` closes the pane.

## Tests
`shared/self-tune.test.ts` covers due-date math (same/different month & year),
`lastSuccessAt`, login enumeration (expansion, dedupe, empty skip),
`newestReport` ordering + fallbacks, the fold prompt contract (report list,
cross-login dedupe wording, marker), `parseFoldSummary`, and the lessons diff
(`parseLessonBullets`, `diffLessons`, `summarizeLessonsDiff`).

## Native GTK4 port (M2-B5)

`native/orchestra-gtk/src/overlays/insights.rs` reimplements both surfaces:

- `InsightsSection` — the sidebar entry (idle summary row / per-step spinner
  rows while running). Mounted from `app.rs` into the sidebar's `insights-slot`
  (found by widget name, the same shell-glue pattern as the accounts usage
  strip), seeded on launch/reconnect via `App::refresh_insights_section`,
  refreshed on `selfTuneUpdate`, and highlighted by `App::sync_insights_active`
  while its overlay is open. Clicking the row toggles the overlay.
- `InsightsOverlay` — the full pane: run history (click → `picked_run_id`),
  the selected run's step list + lessons diff + live transcript (seeded from
  `getSelfTuneOutput`, appended from `selfTuneOutput` events via a `TextView`
  with tail-follow scroll), Run-now (`startSelfTune`, in-flight rejection
  surfaced through a dialog), per-login report buttons (`openSelfTuneReport`),
  and a read-only LESSONS.md panel that counts bullets, flags "N new since the
  last run", and bolds/accent-colors the added bullets via a `TextTag`.
- Wire contracts the call sites honour (both live-verified against a daemon):
  `startSelfTune` resolves a **bare** `SelfTuneRun` and **rejects** when a run
  is in flight (the rejection arrives as `Err`, never an `{ok:false}` value);
  `openSelfTuneReport` resolves a **bare bool** — `false` means "no report yet"
  and must be surfaced, since it is NOT an error.
- Event routing follows the coordinator's single-consumer rule: `App` owns the
  one `backend.events()` pump and fans out via `Msg::BackendEvent`; the overlay
  consumes `selfTuneUpdate`/`selfTuneOutput` through `Overlays::dispatch`, never
  its own `events()` receiver.
- Mock fixtures: `backend_fixtures.rs` (`self_tune_runs`, `self_tune_output`,
  `lessons_md`, and `fake_run_script` — a streaming in-flight run replayed off
  a thread through the mock's event sender by `startSelfTune`).
