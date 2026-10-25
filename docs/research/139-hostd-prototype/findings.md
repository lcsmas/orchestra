# #139 prototype: a windowless orchestra-hostd with the app attached as a client

**Verdict: the host moves out of the window without touching its code.** The prototype is the same packaged Electron binary
started with `ORCHESTRA_ROLE=hostd` and no `BrowserWindow`. It ran today's host services unchanged: the hooks socket and CLI,
the bus wake loop, keepers and the events spool. It woke a member as fast as the in-app host did (warm median 239 ms against
300 ms; cold 2.5 s against 2.9 s).

An app started while the hostd is up becomes a **client**. It forwards the 153-method `api-handlers` table over one NDJSON
Unix socket (`hostd-proto.ts`, 176 lines) and replays every `platform.broadcast` into its window. The sidebar and the live
status dot work: the renderer saw `pc-w1` go idle → running → idle during a wake.

Keepers belong to the hostd. They survive an app quit and a hostd stop with the same pid and start time. A row sent while no
host runs is delivered by the next hostd 967 ms after the send, to the same keeper.

**What breaks** is everything that is not in the table:
- the six `ipcMain` registrars: the bus pane says "bus not open", and the Pause banner says « état illisible »;
- frontend-local methods forwarded to a windowless host: `browserNavigate` fails with "main window not ready";
- toasts and focus;
- a dead hostd leaves an orphaned client (no reconnect) and a stale lock and attach socket.

Branch `prototype/139-hostd-spike`, **INTENTIONALLY UNMERGED**. Ticket
[#139](https://github.com/lcsmas/orchestra/issues/139), map [#136](https://github.com/lcsmas/orchestra/issues/136), feeds
[#140](https://github.com/lcsmas/orchestra/issues/140).

## What was built (throwaway)

- `src/main/hostd-proto.ts`. `decideRole()` runs at module load and returns one of:
  - `hostd` when `ORCHESTRA_ROLE=hostd`;
  - `client` when `<home>/hostd.lock` names a live pid and `<home>/hostd-attach.sock` exists;
  - `host` otherwise.

  It also holds the attach server (NDJSON: `{id,method,args}` → `{id,result|error}`, pushes `{push,args}`) and the client.
- `src/main/index.ts`. `createMainWindow()` is split into `loadHostState` / `startHostServices` / `hostBootSweeps` /
  `startRepoSync`.
  - **hostd** runs them all with no window, behind a platform wrapper. `broadcast` goes through the existing `onBroadcast` tap
    to clients. `broadcastPtyData` and `notify` are pushed. `hasAttachedUi()` returns `true`, because #137 §4.6 says the gate
    would freeze the spool. SIGTERM means `setAppQuitting()` plus shutdown, which detaches the keepers.
  - **client** loads no store, opens no bus or socket, and does not take the Electron single-instance lock. Every
    `METHOD_IPC_CHANNELS` handler becomes `remoteInvoke`. Quit touches nothing host-side.
- `scripts/hostd-proto/run.mjs` is the rig. It reuses the pause-canary rig: the packaged app in a contained headless sway;
  scratch HOME, `ORCHESTRA_HOME` and `CLAUDE_CONFIG_DIR`; LEAD ⊃ OPS ⊃ w1 seeded in the store and the bus with every switch ON;
  the real keeper and the real `claude` CLI against a scripted fake API (zero tokens).
- **Wake latency** runs from the row's own `messages.created_at` to the fake API receiving w1's request whose new tail carries
  `lot pending`. It is not timed from the CLI's exit, because `orchestra cli send` writes the row about 0.5 s in but exits only
  after about 10.5 s. The first instrument read `null` in both arms (wrong field), so the instrument has been seen saying "no
  wake".

Raw lines: `hp-lines.txt` (runs 4 and 5, 2026-10-25). Screenshot: `client-attached.png`.

## Claims, each with its must-FAIL arm

| # | Claim | Evidence (HP line) | must-FAIL arm (it read FAIL as expected) |
|---|---|---|---|
| 1 | The hostd runs the host with no window | `hostd.role` "hostd ready (pid …, no window)"; `hostd.swayWindowsOfHostdPid 0`; `hostd.cliWhoami rc 0` (the CLI found it through the `sock` pointer) | `forcehost`: see 5 |
| 2 | Wake latency is the same as in-app | `inapp.wake` cold 2897 / warm [259,348,300] ms; `hostd.wake` cold 2503 / warm [265,239,208] ms; with a client attached 206 ms; after the app quit 247 ms | `wakeoff`: the same hostd and instrument with the run's frozen `wake=false` → `latencyMs null`, no w1 request |
| 3 | The attached app shows the HOSTD's state, live | `client.role` "role=client … attached in 2 ms"; `client.listWorkspaces` 3 rows; the sidebar DOM shows pc-lead/ops/w1; `client.pushesSeenByRenderer` idle→running→idle within 1 s of the wake | `hostdgone`: SIGKILL the hostd under the client → `listWorkspaces` "ERR … not attached" (it was "OK 3" before). The client loaded no store, so nothing else could have produced the rows |
| 4 | Keepers are the hostd's, not the app's | `keeper.afterAppQuit` sameKeeper true (`1497364@46542074`); `keeper.afterHostdStop` sameKeeper true, procs [] (no host at all); `keeper.deliveredByNextHostd` 967 ms from send, sameKeeper true | Identity is pid plus `/proc` start ticks, so a respawned keeper would read `sameKeeper false`. **No arm forced a respawn (NOT RUN).** |
| 5 | Today's Electron single-instance lock already fences a second HOST while an Electron hostd runs | `forcehost.secondHost`: an app with `ORCHESTRA_PROTO_FORCE_HOST=1` exited 0 and never logged `role=`. The hooks `sock` pointer is unchanged | Control: the `inapp` arm is the same binary with no hostd → it reaches `role=host` and serves wakes |
| 6 | The `hasAttachedUi()` spool gate must not survive into a daemon (#137 §4.6) | `spoolgate.off`: the w1 spool has a `.cursor` (consumed) | `spoolgate.attached` (today's gate, no client): **no `.cursor`**, so the 1763-byte spool was never drained. Activity and liveness's idle clock would freeze with the app closed |

## What breaks with the host remote (input for #140 (c) and (f))

1. **The registrars are not in the table.** The bus pane snapshot reads `available:false` "The fleet bus is not open", and the
   Pause banner shows « Pause : état illisible » (screenshot). The six registrars in #137 §2 (`bus-pane`, `pause-ui-host`,
   `memory-banner-host`, `watchers-host`, `app-update-host`, `voice`) plus `bus:setSwitches` / `bus:resolveHumanGate` need to
   move onto the transport. The spike's generic forwarder proves a table-driven transport carries them unchanged.
2. **Frontend-local methods must not be forwarded.** `browserNavigate` reaches the hostd's `browser-panel` and fails with "main
   window not ready". `revealLogs` "works" but opens the file manager from the daemon's side. `getAppVersion` answers the
   HOSTD's version, which is the version-skew question in a nutshell. The table needs a host / frontend split (#137 §5.7).
3. **Pushes that a client cannot act on.**
   - `hostd:notify` is pushed but not rendered.
   - `isFocused()` is constant `false` in the hostd, so every finish reads "unseen".
   - The repo sync on window focus is skipped in the client.

   All three need a client→host "focus / active workspace" call (#137 §4.5).
4. **No reconnect, and stale-lock hazards.** After a hostd SIGKILL the client stays up but is orphaned (`hostdgone.after`), and
   `hostd.lock` and `hostd-attach.sock` are left behind. The next app reads the lock's pid as dead and becomes a host, which is
   correct here. But a reused pid would make it a client of nothing. Use the orca record (pid, start ticks, bootId) from #138
   §1.2, not a bare pid.
5. **A clean stop is clean.** SIGTERM removed both the lock and the attach socket (`keeper.afterHostdStop`).

## For the #140 grilling

- **(a) Launch.** The hostd needs no display only with `--ozone-platform=headless`. This rig ran it inside sway, so the
  no-display case is #404's evidence, not mine.
- **(b) Ownership.** Keeper ownership needed NO change. Keepers already outlive their host, and any host that boots reattaches
  them. The real ownership rule is "one host at a time". With an Electron hostd that rule is free (claim 5).
- **(c) Attach.** Forwarding the existing table plus the `onBroadcast` tap is enough for the sidebar, the agent view's data path
  and the status dot. Add registrars, a PTY stream with replay, and client UI state.
- **(e) Shadow.** The spike did not run one. The fence in claim 5 makes "app-host + hostd" impossible with an Electron hostd,
  so a shadow would need its own read-only role.

## Verified (command: the rig, `hp-lines.txt`)

Claims 1–3, 5 and 6 with their must-FAIL arms, plus claim 4's identity reads. The client screenshot was looked at. The
typecheck (`npx tsc --noEmit`) passed on the prototype tree, and the packaged build (`pnpm run build`) completed.

## NOT verified

- One sample per arm for the must-FAIL arms. Wake latency is 4 samples per arm on a loaded host, with no interleaving, so read
  "same order of magnitude", not a ranking.
- The keeper must-FAIL arm (a forced respawn) was not run.
- PTY panes (Run script / nvim / login) through the client.
- The agent view's streaming `agent:event` volume over the socket, and permission prompts or AskUserQuestion answered from the
  client.
- A Node hostd (out per #404). The hostd under systemd or with no display (#404 covers this). More than one client attached.
- Whether `orchestra cli send`'s ~10 s exit linger also happens on master. It was measured only on this build.
