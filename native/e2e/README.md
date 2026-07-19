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
| `coexistence-live-update` | ⏭️ skipped | Electron+GTK live mirroring (1 s update, PTY roundtrip) — needs the persistent `RpcBackend` transport (sibling workstream). Harness is ready; lights up when it lands. |

## Why a custom harness (not CDP/Playwright)

Headless sway advertises no seat input, so compositor-level clicks never reach
the client — that's exactly why the GTK app ships an in-process remote-control
harness that synthesizes events GTK-side and renders screenshots offscreen via
`WidgetPaintable → GSK render_texture` (works with no visible frame). See
`docs/gtk4-port-plan.md` §8.4.
