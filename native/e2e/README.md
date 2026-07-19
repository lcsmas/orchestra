# Native GTK E2E scenarios

End-to-end scenarios that drive the **real** `orchestra-gtk` binary through its
`--remote-control` debug socket (`src/remote_control.rs`) inside a **private
headless sway** compositor — the same isolation the repo's `verify` skill uses
for the Electron app, so nothing touches the user's desktop. Dependency-free
Node (`net`/`child_process`/`fs`); no install step.

```bash
# build the binary first (rootless dev box: `source native/env.sh` beforehand)
(cd native && cargo build -p orchestra-gtk)

node native/e2e/run.mjs                 # all scenarios
node native/e2e/run.mjs <name> <name>   # only the named ones
E2E_SHOT_DIR=/tmp/shots node native/e2e/run.mjs   # keep screenshots
```

Exit code is 0 iff every non-skipped scenario passed. A scenario that depends on
an unmerged workstream **skips with a reason** instead of failing.

## Files

| File | Role |
|---|---|
| `harness.mjs` | headless-sway bring-up, `orchestra-gtk` launch, remote-control client, wait helpers |
| `fake-backend.mjs` | minimal ui-rpc server — just the hello/helloOk handshake (configurable proto / appVersion / backendKind) |
| `run.mjs` | the scenario registry + runner |

## Scenarios

| Scenario | Status | What it proves |
|---|---|---|
| `version-mismatch-refusal` | ✅ runs | proto ≠ 1 backend → refusal dialog, no attach, footer stays `backend: none` (plan §1.1 rule 5 / protocol §3) |
| `appversion-warning-nonfatal` | ✅ runs | proto = 1 but appVersion differs → **warning** dialog, attach still proceeds |
| `daemon-auto-spawn` | ✅ runs | no socket → `$ORCHESTRA_DAEMON_CMD` spawn → wait for ui-sock → attach; spawn log lands under the isolated `ORCHESTRA_HOME` |
| `backend-lock-mutual-exclusion` | ✅ runs (needs `dist-electron/daemon.js`) | a second backend refuses the home with "already owns" and exits non-zero; skips if the daemon bundle isn't built (`pnpm run build:daemon`) |
| `coexistence-live-update` | ⏭️ skipped | Electron+GTK live mirroring (1 s update, PTY roundtrip) — a placeholder kept as a marker. The **live-daemon scripts below** already cover the single-consumer fan-out end to end against a real daemon; full Electron+GTK simultaneous mirroring is future work. |

The fake backend answers the hello/helloOk handshake **and** every subsequent
`req` with a benign empty `res`, so a scenario that ATTACHES (not just probes)
doesn't block on init-time hydration (`listWorkspaces`, the accounts bootstrap).
Override individual methods via `startFakeBackend(sock, { methods: {…} })`.

## Live-daemon fan-out scripts (B1)

Two bash drives under `native/orchestra-gtk/scripts/` exercise the real
single-consumer fan-out against an actual `dist-electron/daemon.js` (no mock, no
fake) in headless sway — they seed a throwaway `ORCHESTRA_HOME`, boot the
daemon, drive the app via remote-control, mutate **through** the daemon, and
assert the sidebar re-renders. Prereq: `pnpm run build:daemon`.

| Script | Proves |
|---|---|
| `sidebar_live_drive.sh` | App launched WITH the daemon up → footer `backend: rpc/daemon`, seeded row renders, a through-daemon `setUnread` re-renders the dot via App→forward→sidebar (the events() fan-out delivers live frames). |
| `sidebar_late_attach.sh` | App launched with NO backend → banner/`backend: none` → daemon appears → the 3 s `RetryDiscover` loop discovers it → `Msg::Attach` hydrates the sidebar (`refresh_snapshot`), then a through-daemon mutation still re-renders. Covers the discovery/auto-attach path. |

Run: `bash native/orchestra-gtk/scripts/sidebar_live_drive.sh` (artifacts under
`native/target/{live-drive,late-attach}/`).

## Why a custom harness (not CDP/Playwright)

Headless sway advertises no seat input, so compositor-level clicks never reach
the client — that's exactly why the GTK app ships an in-process remote-control
harness that synthesizes events GTK-side and renders screenshots offscreen via
`WidgetPaintable → GSK render_texture` (works with no visible frame). See
`docs/gtk4-port-plan.md` §8.4.
