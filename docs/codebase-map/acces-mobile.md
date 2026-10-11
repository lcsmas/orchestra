# Accès mobile — the phone talks to the workspaces through a sidecar behind `tailscale serve` (#333)

The human's phone lists every workspace (every repo, every Claude account) from a PWA. **ADR 0006** fixes the shape: a
**separate server process spawned by main** owns everything network-facing; it listens on **127.0.0.1 only**; HTTPS and tailnet
exposure come from `tailscale serve`, configured ONCE by hand (Orchestra never runs `tailscale`); every request needs the
`Tailscale-User-Login` identity (serve sets it and strips client copies — tailscale.com/kb/1312/serve) **and**, for `/api/*`, the
current token. **Main opens no port**: the server reaches main only over the 0600 hooks socket (`/mobile/*` routes). Spec #333;
tracer #334 (list). Pending: pairing/QR/install #336, conversation #337, send #338, AskUserQuestion #339, design #340.

## Files
| File | Role |
|---|---|
| `src/shared/acces-mobile.ts` | PURE: settings (`normalizeAccesMobileSettings` `:30`, default OFF + empty login = fail closed; `patchAccesMobileSettings` `:44` refuses enabling without a login), `tailscaleServeCommand` (`:83`), `sameLogin` (`:88`, case-insensitive exact), the phone list `projectMobileWorkspaces` (`:124`: non-archived, every account via `resolveWorkspaceAccountId`, sorted by `attentionRank` `:115` = en attente < non lu < rest, then group, then name), the `AccesMobileView`/`Health` types |
| `src/acces-mobile/server.ts` | the ONLY network code. `createAccesMobileServer` (`:52`): identity on EVERY request (shell included) → GET only → static shell (identity is enough: no data in it) → `/api/*` needs `Authorization: Bearer` == the token file read at EVERY request (`tokenMatches` `:38`, sha256 + `timingSafeEqual`); never from the query string. Refusals: bare 401/403, empty body, one log line `refused <code> <reason> <method> <path>` (no header value). `socketUpstream` (`:113`) = POST JSON to the hooks socket |
| `src/acces-mobile/page.ts` | the unstyled phone shell: reads `#t=<token>` once → `localStorage`, strips the fragment (`history.replaceState`), polls `/api/workspaces` every 5 s; a « Pour toi » section (en attente + non lu, any repo) first, then repo groups — grouping must never break attention order |
| `src/acces-mobile/index.ts` | entry. Env-only config (`ACCES_MOBILE_PORT/LOGIN/TOKEN_FILE`, `ORCHESTRA_SOCK`); `server.listen(port, '127.0.0.1')` (`:30`); prints `listening <port>`; **exits when its stdin pipe ends** — main holds it, so an app crash cannot leave an orphan listening |
| `src/main/acces-mobile-host.ts` | main's side. Token file `$ORCHESTRA_HOME/acces-mobile/token` (0600 in a 0700 dir, atomic rename, `generateAccesMobileToken` `:48`); `installServer` copies `dist-electron/acces-mobile.js` to `$ORCHESTRA_HOME/bin/` (ELECTRON_RUN_AS_NODE must not read from the asar — same reason as `installKeeper`); `startChild` spawns `process.execPath` with an **allowlisted env** (`:124`: the six keys, never `...process.env`); supervision: exit while enabled ⇒ restart with backoff 1 s→30 s (reset after 60 s up); `applyAccesMobile` (`:181`) reconciles to the settings; `accesMobileView`/`setAccesMobileSettings` back the IPC |
| `src/main/hooks-server.ts` | route `/mobile/workspaces` (`:625`) → `projectMobileWorkspaces(store.workspaces, store.repos, store.accounts)` |
| `src/main/index.ts` | `startAccesMobileHost()` right after `startHooksServer()` (`:459`, needs the socket + loaded store); `stopAccesMobileHost()` before `stopHooksServer()` (`:930`) |
| `src/main/store.ts` | `accesMobile?` field (raw), `getAccesMobileSettings` (`:476`) / `setAccesMobileSettings`. The token is NOT in store.json |
| `src/renderer/components/AccesMobileSettings.tsx` | the dialog (header phone icon in `Sidebar.tsx`, `[data-am-open]`): login, two ports, on/off with live health, the serve command, « Copy pairing fragment ». IPC `settings:accesMobile` / `settings:setAccesMobile` |
| `vite.acces-mobile.config.ts` | `pnpm run build:acces-mobile` → `dist-electron/acces-mobile.js`; part of `build:bundles` (CI) |

## Tests and rigs
- `src/acces-mobile/server.test.ts` — every security arm beside a passing control; each refusal names its own reason; the REAL entry
  (`index.ts` under node) binds loopback only (non-loopback IPv4 refused), reaches a fake main socket, exits when its pipe closes.
- `scripts/acces-mobile-mutants.py` — removes each auth/bind clause in place, requires RED, restores byte-exact; prints CLEAN/DIRTY.
  One documented equivalent mutant (`M6`: the empty-expected guard in `tokenMatches` is shadowed by sha256 inequality).
- `src/shared/acces-mobile.test.ts` (settings, ordering, accounts), `src/main/acces-mobile-wiring.test.ts` (boot/shutdown order,
  route, no `.listen` in main, env allowlist, token file modes, `build:bundles`).
- `scripts/e2e-acces-mobile.sh <app-dir>` — built app in the contained rig's headless sway + headless Chromium in iPhone emulation
  (serve's header injected): server process identity + allowlisted environ, token 0600/0700, the must-FAIL arms on the live port,
  pairing + fragment stripped, the list, the Settings toggle off/on (trusted clicks), SIGKILL ⇒ restarted, app SIGKILL ⇒ server gone.

## Traps
- A seeded `waiting` is rewritten to `idle` + non lu at store load (`store.ts`, « no live process can still be asking »): an e2e
  en attente row needs a live AskUserQuestion, not a seed.
- The identity header is only trustworthy because `serve` strips client copies; a LOCAL process can forge it — the token is what
  stops it. Never drop the token on the grounds that serve authenticates.
