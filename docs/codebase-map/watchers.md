# Directory watchers — one resilient watcher, a registry, and what the app says when one is down (#330)

Every directory watch of the main process goes through **`createWatcher()`** (`src/main/watchers.ts:109`). A watch that cannot be armed (`EMFILE` / `ENOSPC` / a missing directory) or that dies later is **retried with backoff until it is back**; the subsystem's own fallback (sweep, poll, pull) keeps working meanwhile; **one catch-up pass** runs on recovery; the state of every watcher is readable (`bus-status`, the `watchers:update` push). Wave H, ledger #329, ticket #330.

## The incident this ends
2026-10-08, app v0.5.316 relaunched at 12:53:48Z while the per-user inotify limit (128 instances) was exhausted by leaked headless Chromium. All six boot watchers failed `EMFILE`, each hand-rolled `fs.watch` block logged ONE warning and never tried again: the Réveil engine rode its 60 s sweep, the Pause UI overview was never pushed, the host trap was sweep-only — the sidebar kept « en pause 33/33 » after the 12:56Z automatic Reprise, for as long as the app ran, with no sign anything was degraded.

## Files
| File | Role |
|---|---|
| `src/shared/resilient-watch.ts` | the PURE state machine: `createResilientWatcher(spec, deps)` (`:110`). Injected `watch` primitive, `setTimer`/`clearTimer`, `now`, `mkdirp`, `inodeOf`, `healthMs`, `warn`/`info`. `WATCH_BACKOFF_MS` (`:89`) = 1, 2, 5, 15, 30, 60 s then every 60 s; `WATCH_HEALTH_MS` (`:91`) = 30 s; `WATCH_STABLE_MS` (`:93`) = 60 s |
| `src/shared/watcher-status.ts` | what is SAID: `formatWatchersLines` (`:46`, the `bus-status` block), `watchersStripCopy` (the sidebar strip's French words) + `newerWatchers` (the renderer keeps the later of the boot pull and a push), `degradedKey` (`:14`, the edge identity of the degraded set) |
| `src/main/watchers.ts` | production binding + the REGISTRY: `realWatch` (the one `fs.watch`), `watchersStatus` (`:81`), `onWatchersChange` (`:100`), `stopAllWatchers` (`:137`), `pushWatchersToRenderer` (`:143`, idempotent), env fault injection (`faultFileFrom` `:24`), test seams `__setWatchPrimitiveForTests` / `__setWatchHealthMsForTests` |
| `src/main/watchers-host.ts` | Electron-bound half: the PULL channel `watchers:status` (`registerWatchersIpc`, module scope in `index.ts`). Kept apart so `watchers.ts` imports no Electron and a rig can load it |

## State machine (what the unit file pins — `src/shared/resilient-watch.test.ts`)
- `ok` ⇄ `degraded`. A failed arm (the primitive throws) or a runtime `error` event → `degraded`, the watch is CLOSED, a retry is scheduled (`attempts` counts up; the delay is `WATCH_BACKOFF_MS[min(attempts-1, last)]`, so the cap is 60 s and it never stops). A successful arm after a degradation → `ok`, `recoveries++`, `onRecover()` (the catch-up). The FIRST arm never runs `onRecover`.
- Edge-triggered: ONE `warn` on entering `degraded` (it names « system watch limit reached (EMFILE|ENOSPC) » for those two codes, and the site's fallback), ONE `info` on recovery; failed retries are silent. `onTransition` fires only on ok→degraded, degraded→ok and `stop()`. `since` is the start of the degradation (stable across failed retries).
- A callback of a CLOSED watch must never act (`gen` token): a late event or a late `error` of the replaced watch is ignored.
- **Flap guard** (`failStreak`, `WATCH_STABLE_MS`): the backoff index is NOT reset by a successful re-arm — only after the watch stayed up 60 s. A watch that dies right after every arm climbs 1, 2, 5, 15 … s instead of re-arming (and logging, and running its catch-up) every second forever.
- Re-entrancy: `stop()` from inside `onTransition` schedules no retry; `stop()` from inside `onArmed` runs no catch-up.
- **Silent detach** (`inodeOf` + `healthMs`): an inotify watch on a directory that is deleted and recreated never says so. Every 30 s a healthy watch is compared with its directory's inode; a changed inode (`ESTALE`) or a missing directory (`ENOENT`) degrades it, and it re-arms on the new directory. The inode is sampled BEFORE the watch is armed (a swap in between fails safe: one spurious re-arm). LIMIT of the inode check alone: a delete+recreate that reuses the same inode number (ext4 often does) is not detected by it, and a swap inside the 30 s window is seen only at the next check. THE DIRECTORY'S OWN REMOVAL/RENAME is therefore also caught by the kernel's event (#330 review m1): `fs.watch` emits a `rename` named like the watched directory (measured on btrfs and tmpfs; twice), the watch is dead from then on — the module re-arms at once (`ESTALE`), BEFORE the site's filter, without waiting for the 30 s check; a child entry sharing the directory's name costs one spurious re-arm. A RENAMED PARENT is the pure inode-check case (no event about the directory).
- `stop()` cancels every retry and the health timer and closes the watch; idempotent; `start()` after `stop()` is a no-op.

## The seven sites (each keeps its OWN fallback; the registry lists a watcher only from `start()` to `stop()`)
| name | label (the human's word) | file | fallback while degraded | catch-up on recovery |
|---|---|---|---|---|
| `bus-wake` | Réveils | `bus-wake.ts:1014` | 60 s sweep | `sweepBusWake()` |
| `pause-ui` | Vue Pause | `pause-ui-host.ts:144` | the UI's own writes and pull | `reconcilePauseUi` (forced overview push) |
| `pause-trap` | Pause dure | `pause-trap.ts:985` | 15 s sweep | `sweepPauseTrap(activeDeps)` |
| `human-gates` | Questions | `human-gates.ts:218` | resolve-time broadcast + mount-time read | `reconcileHumanGates` |
| `inbox-tray` | Inbox | `inbox-tray.ts:315` | counts sent on each mutation and at mount | `broadcastInbox` for every live workspace |
| `events-spool` | Activité des agents | `events-spool.ts:396` | the 1 s poll | `drainAll` |
| `login-watch` | Détection de connexion | `account-usage.ts:140` | 1.5 s poll (`persistent:false`; registered only while a login is watched) | `check` |

`ensureDir` (mkdir before EVERY arm, retries included — a deleted directory is recreated and the watch heals) only where the old block did it at start: pause-ui, human-gates, inbox-tray. The bus-wake / pause-trap watches never CREATE the bus directory — a missing one is `ENOENT` → degraded → recovers when the bus opens.

## What is told, and to whom
- **`orchestra bus-status`** — `/busStatus` carries `watchers: WatchersStatus` (`hooks-server.ts`, next to `members`); the CLI prints `formatWatchersLines` (`src/cli/index.ts`): `watchers: N ok` when healthy, `watchers: 4/6 ok · 2 DEGRADED — Réveils, Pause view (system watch limit reached); the app re-arms by itself` + one indented line per degraded watcher (since, age, error, attempts, `meanwhile: <fallback>`). `none armed` when nothing is registered. Absent from an older app → no line.
- **Renderer push** — `watchers:update` (the WHOLE `WatchersStatus`) ONLY when the degraded set changes (`degradedKey`: `name@since`), plus the pull `watchers:status` for the initial paint. Preload: `watchersStatus` / `onWatchersUpdate` (typed in `src/shared/ipc.ts`, excluded from the generic served table in `api-handlers.ts`). `pushWatchersToRenderer()` is called in `index.ts` before the first watch is armed, but the renderer page is NOT loaded yet at boot: a boot-time EMFILE reaches the UI only by the PULL (`watchers:status`, read on mount); the push carries every LATER change. **The warning (D-Q8 = A)**: `src/renderer/components/WatchersStrip.tsx`, a strip in the sidebar footer slot RIGHT AFTER `PauseUnreadableStrip` (same `.pause-unreadable` look, `role="status"`, hook `data-watchers-chip`, tooltip = one line per degraded watcher), French copy « Mises à jour en retard — Réveils, Vue Pause — limite de surveillance de fichiers atteinte. Nouvel essai automatique. » from `watchersStripCopy`. It renders NOTHING while every watcher is ok (no chrome on a healthy app) and has no button — it goes away by itself when the last watcher is back. State = the store slice `watchers` (`src/renderer/store.ts`): the boot PULL `watchersStatus()` in `load()` + `onWatchersUpdate`, both through `newerWatchers` (the later registry clock wins, so a late-answered pull never rolls a push back). Proof: `scripts/watchers-strip-render-smoke.mjs` (SSR, in `pnpm run test:render`) + the built-app drive `scripts/watchers-app/e2e-watchers-app.sh` (chip clauses G4).
- **Log** — see Edge-triggered above.
- Shutdown: `stopAllWatchers()` first in `shutdownSubsystems()`; each subsystem's own stop then stops its watcher again (idempotent).

## Fault injection (never real exhaustion)
`ORCHESTRA_WATCH_FAULT_FILE=<path>`: while that file EXISTS every arm throws `EMFILE` ("injected"); read at each arm. Create it before launch to degrade a built app, delete it to let it recover. Precedent: `ORCHESTRA_BUS_WATCHER=off`. A real inotify exhaustion (sysctl / namespace) is out of scope (#330).

## Proof
- Unit: `resilient-watch.test.ts` (fake clock + scripted primitive), `watcher-status.test.ts`, `watchers.test.ts` (registry over real timers + a real directory watch), `watchers-wiring.test.ts` (text pins: no `fs.watch` outside `watchers.ts`, each site's catch-up/stop/ensureDir, index.ts order, `/busStatus` + CLI + preload).
- Composition rig `scripts/e2e-resilient-watchers.mjs` (arms: control, degraded, recovery, `catchup_<site>` ×7, midlife, silent_detach, silent_detach_event, shutdown — each site's catch-up is pinned by ONE-site isolation arms, because in the all-sites arm one site's bus write cascades into another's re-armed watch and hid a removed `onRecover`; events-spool and login-watch clear their own poll in their arm) — real bus + the six boot subsystems + the real hooks server + the BUILT CLI `bus-status`; the instrument is `fs.watch` itself, patched to throw EMFILE, so the SAME rig runs on master (`RIG_REPO=<tree>`): arms `control`, `degraded`, `recovery`, `midlife`, `silent_detach`, `shutdown`. `RIG_VERBOSE=1` lists every check.
- Mutants `scripts/resilient-watchers-mutants.mjs` (`--check-anchors`, `--only`, `--no-rig`).

## Traps (learned building the rig)
- The events spool keeps its 1 s poll, so « the event was applied » proves nothing: the rig measures LATENCY (six events at scattered phases must all land < 250 ms; a poll manages that 0.02 % of the time).
- The Réveil engine does not re-wake a reader whose earlier mail is unread: a rig that wants a SECOND wake must `check` + `ack` first.
- A debounce armed by a write BEFORE a watch dies still fires AFTER it — settle > 150 ms before killing a watch or the « dead » watch seems to serve the next write.
- On master an `error` event on the pause-ui / human-gates / inbox watchers has NO listener, so it would throw in the Electron main process (the rig counts it: `error_event_has_a_listener`).
- A restore re-stamps a file: any mutant under `src/shared` / `src/cli` makes `dist-electron/cli.js` stale for the next rig arm — the harness rebuilds around it.
