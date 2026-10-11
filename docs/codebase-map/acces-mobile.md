# Accès mobile — the phone talks to the workspaces through a sidecar behind `tailscale serve` (#333)

The human's phone lists every workspace (every repo, every Claude account) from a PWA. **ADR 0006** fixes the shape: a
**separate server process spawned by main** owns everything network-facing; it listens on a **0600 Unix socket in a 0700 dir —
no TCP port** (a free loopback port can be squatted and the phone's token harvested — #334 review); HTTPS and tailnet exposure
come from `tailscale serve --https=<port> unix:<socket>`, configured ONCE by hand (Orchestra never runs `tailscale`); every request needs the
`Tailscale-User-Login` identity (serve sets it and strips client copies — tailscale.com/kb/1312/serve) **and**, for `/api/*`, the
current token. **Main opens no port**: the server reaches main only over the 0600 hooks socket (`/mobile/*` routes). Spec #333;
tracer #334 (list). Pending: pairing/QR/install #336, conversation #337, send #338, AskUserQuestion #339, design #340.

## Files
| File | Role |
|---|---|
| `src/shared/acces-mobile.ts` | PURE: settings (`normalizeAccesMobileSettings`, default OFF + empty login = fail closed; a pre-review `port` key is dropped; `patchAccesMobileSettings` refuses enabling without a login), `tailscaleServeCommand(socketPath, servePort)` (`unix:` target), `accesMobileSocketPath`, `sameLogin` (case-insensitive exact), the phone list `projectMobileWorkspaces` (`:124`: non-archived, every account via `resolveWorkspaceAccountId`, sorted by `attentionRank` `:115` = en attente < non lu < rest, then group, then name), the `AccesMobileView`/`Health` types |
| `src/acces-mobile/server.ts` | the ONLY network code. `createAccesMobileServer` (`:52`): identity on EVERY request (shell included) → GET only → static shell (identity is enough: no data in it) → `/api/*` needs `Authorization: Bearer` == the token file read at EVERY request (`tokenMatches` `:38`, sha256 + `timingSafeEqual`); never from the query string. Refusals: bare 401/403, empty body, one log line `refused <code> <reason> <method> <path>` (no header value), **rate-limited** to `REFUSAL_LOG_BURST` (20) per minute + one « N more suppressed » line — a colleague's flood must not evict main's log. `socketUpstream` (`:113`) = POST JSON to the hooks socket |
| `src/acces-mobile/page.ts` | the unstyled phone shell: reads `#t=<token>` once → `localStorage`, strips the fragment (`history.replaceState`), refreshes the list on the live stream (30 s poll as fallback); hash-routes `#w=<id>` to the conversation screen; a « Pour toi » section (en attente + non lu, any repo) first, then repo groups — grouping must never break attention order |
| `src/acces-mobile/index.ts` | entry. Env-only config (`ACCES_MOBILE_SOCKET/LOGIN/TOKEN_FILE`, `ORCHESTRA_SOCK`); refuses a socket dir not owned by us or not 0700; removes a stale SOCKET (never a regular file); `process.umask(0o177)` then `server.listen(sockPath)` (no window where the socket is wider than 0600); prints `listening <path>`; **exits (and unlinks) when its stdin pipe ends** — main holds it, so an app crash cannot leave an orphan |
| `src/main/acces-mobile-host.ts` | main's side. Token file `$ORCHESTRA_HOME/acces-mobile/token` (0600 in a 0700 dir, atomic rename, `generateAccesMobileToken` `:48`); `installServer` copies `dist-electron/acces-mobile.js` to `$ORCHESTRA_HOME/bin/` (ELECTRON_RUN_AS_NODE must not read from the asar — same reason as `installKeeper`); `accesMobileSocketPath()` = `$XDG_RUNTIME_DIR/orchestra-acces-mobile-<sha256(ORCHESTRA_HOME)[:12]>.sock` when that dir is ours and 0700, else our own 0700 dir — stable, since the serve config points at it; `startChild` execs via `/bin/bash -c CLOSE_INHERITED_FDS` (closes every fd > 2: Chromium leaves some sockets without CLOEXEC — the rig caught main's DevTools LISTEN socket in the server) with an **allowlisted env** (six keys, never `...process.env`); **never throws** (`startChildSafe`, `startAccesMobileHost` try): a failure of this optional feature is a `failed` health + retry, never a blocked boot; supervision: exit while enabled ⇒ restart with backoff 1 s→30 s (reset after 60 s up); `applyAccesMobile` reconciles to the settings; `accesMobileView`/`setAccesMobileSettings` back the IPC |
| `src/main/hooks-server.ts` | routes `/mobile/workspaces` → `projectMobileWorkspaces(store.workspaces, store.repos, store.accounts)`; `/mobile/conversation` {id} → `getMobileConversation` (unknown / archived ⇒ `{ok:false}`); `/mobile/seen` {id} → `markWorkspaceSeen`; `/mobile/stream` → a long-lived NDJSON response fed by `subscribeMobileFeed`, unsubscribed on `close` |
| `src/acces-mobile/conversation.ts` | (#337) the phone's conversation screen + the ONE live stream per page, read with `fetch()` (EventSource cannot send the bearer; the token never goes in a URL); SSE `data:` blocks → handlers; reconnect with backoff 1→15 s and on `visibilitychange`; a `conv` announcement ⇒ refetch the projection (≥1 s apart, coalesced); textContent only. Asks are shown (AskUserQuestion options disabled until #339; others « À traiter sur le bureau ») |
| `src/shared/acces-mobile-conversation.ts` | (#337) PURE `projectConversation(id, session, version)`: the desktop's folded `AgentSession` → `PhoneLine[]` (user / assistant text clipped to 4000, ONE line per tool via `toolLabel`, `!command`, notices), the last `MAX_PHONE_LINES` (200) + a `truncated` count, and `asks` from `pendingAnswerables`+`pendingPermissions` (AskUserQuestion ⇒ `askUser` with questions/options; anything else ⇒ `desktop`); `validWorkspaceId` |
| `src/main/acces-mobile-feed-core.ts` | (#337) `createMobileFeed({loadHistory, onBroadcast})`: per opened workspace a folded session (history once via the injected loader, then every `agent:event` folded with the SAME `foldEvent`), LRU `MAX_CACHED` 6, idle drop 10 min when no stream; change announcements coalesced to 400 ms; `workspace:update`/`removed` ⇒ `{t:'workspaces'}`; an event that arrives WHILE the history loads is not folded but recorded (`missedWhileLoading`) and the next `turn-end` makes the next read re-fold from disk — never a reload per turn (a disk read can lag the live fold). The tap is armed only while something is cached or streamed (zero cost otherwise) |
| `src/main/acces-mobile-feed.ts` | the binding: `sdkHistory` (account-aware transcript read) + `platform.onBroadcast` |
| `src/main/platform/index.ts` | `onBroadcast(tap)`: every UI push (`platform.broadcast`) also reaches in-process taps — the feed's live source |
| `src/main/mark-seen.ts` | `markWorkspaceSeen`: the ONE « seen » (desktop `markSeen` IPC + the phone) |
| `src/main/index.ts` | `startAccesMobileHost()` right after `startHooksServer()` (`:459`, needs the socket + loaded store); `stopAccesMobileHost()` before `stopHooksServer()` (`:930`) |
| `src/main/store.ts` | `accesMobile?` field (raw), `getAccesMobileSettings` (`:476`) / `setAccesMobileSettings`. The token is NOT in store.json |
| `src/renderer/components/AccesMobileSettings.tsx` | the dialog (header phone icon in `Sidebar.tsx`, `[data-am-open]`): login, two ports, on/off with live health, the serve command, « Copy pairing fragment ». IPC `settings:accesMobile` / `settings:setAccesMobile` |
| `vite.acces-mobile.config.ts` | `pnpm run build:acces-mobile` → `dist-electron/acces-mobile.js`; part of `build:bundles` (CI) |

## Tests and rigs
- `src/acces-mobile/server.test.ts` — every security arm beside a passing control; each refusal names its own reason; refusal log
  rate limit; hardening headers; the REAL entry (`index.ts` under node): 0600 socket, zero TCP listeners (its fd table vs
  /proc/net/tcp), a real stale socket replaced, token rotation applies at once, exits + unlinks when its pipe closes; a 0755 socket
  dir is refused (control: 0700 starts). Every entry child is SIGKILLed after each test, so a mutant fails instead of hanging.
- `scripts/acces-mobile-mutants.py` — removes each auth/bind clause in place, requires RED, restores byte-exact; prints CLEAN/DIRTY.
  28 mutants (auth clauses, socket mode, TCP listener, open dir, exit-with-parent, cached token, rate limit, CSP, token dir chmod,
  unguarded boot, non-socket unlink, no/empty fd wrapper, retry catch, dir owner, unlink-by-path, server.close on exit, trusted XDG, shared log budget); one documented equivalent (`M6`: the empty-expected guard in `tokenMatches` is shadowed by sha256 inequality).
  A suite that HANGS under a mutant is reported SURVIVED, never killed.
- `src/shared/acces-mobile-conversation.test.ts` + `src/main/acces-mobile-feed-core.test.ts` (#337): driven by a transcript CAPTURED
  from the real CLI (`scripts/fixtures/payloads/acces-mobile-transcript.sample.jsonl`, structure untouched, texts replaced) through
  the real `transcriptToEvents` → `foldEvents`; history+live, heal after a mid-load miss, LRU, zero-cost disarm.
- `src/shared/acces-mobile.test.ts` (settings, ordering, accounts), `src/main/acces-mobile-wiring.test.ts` (boot/shutdown order,
  route, no `.listen` in main, env allowlist, token file modes, `build:bundles`).
- `scripts/e2e-acces-mobile.sh <app-dir>` — built app in the contained rig's headless sway + headless Chromium in iPhone emulation
  behind a `tailscale serve` STAND-IN (TCP→the socket, strips client `Tailscale-User-*`, sets the device's identity; owner /
  colleague / tagged proxies): socket 0600 in a 0700 dir, a pre-review `port` ignored, server identity + allowlisted environ + ZERO
  TCP listeners, token 0600/0700, the must-FAIL arms (incl. a colleague and a tagged device forging the owner's header), pairing +
  fragment stripped, the list, Settings toggle off/on (trusted clicks; phone gets 502 while off), SIGKILL ⇒ restarted over the
  stale socket, app SIGKILL ⇒ server gone; (#337) the phone opens a workspace whose history is a captured transcript in ITS account's
  project dir (user / tool / assistant) and the desktop's bell clears; then a REAL turn — the real `claude` CLI against the LOCAL FAKE
  Anthropic API of the session-budget suite (zero tokens; the rig account's `env` carries `${ANTHROPIC_*}` because a pinned account
  drops the inherited ones) — streams onto the open phone page without a reload; idle CPU with the phone streaming. 35 clauses.

## Traps
- A seeded `waiting` is rewritten to `idle` + non lu at store load (`store.ts`, « no live process can still be asking »): an e2e
  en attente row needs a live AskUserQuestion, not a seed.
- The identity header is only trustworthy because `serve` strips client copies; a LOCAL process can forge it — the token is what
  stops it. Never drop the token on the grounds that serve authenticates.
- Never go back to a TCP port "for simplicity": the squat window is every moment the app is off or restarting.
- A child spawned from Electron's main inherits Chromium fds that lack CLOEXEC (seen: the DevTools LISTEN socket); a process that
  must hold nothing of main's has to close them itself (here: the bash exec wrapper).
- No Host check: with an HTTPS-only serve entry, a DNS-rebinding origin fails TLS (cert is for the ts.net name) and loopback has
  no TCP port to rebind to.
- MEASURED 2026-10-11 through the REAL `tailscale serve` (1.98.9, SELinux enforcing, tailscaled root `unconfined_service_t`), built
  server on a 0600 socket in /run/user/1000: token ⇒ 200 (tailscaled connects; serve sets the owner's login); no / bad / query
  token ⇒ 401; a forged colleague `Tailscale-User-Login` + token ⇒ 200 (serve overwrote it with the real login); with the allowed
  login set to someone else ⇒ 403, also when forging that login (the forged header never reaches the server); server off ⇒ 502.
- A Unix-socket target needs `sudo tailscale serve` — an operator alone gets « must be root … to serve a path or Unix socket ».
  Hence the `sudo` in the printed command. Not measured: a real colleague's or a tagged device (no second device).

- A pinned account DROPS inherited `ANTHROPIC_API_KEY/BASE_URL` (workspaces.ts `accountAgentEnv`): a rig that wants the fake API
  must put `${ANTHROPIC_*}` templates in the account's `env` — else « Not logged in » and nothing reaches the fake.
- A seeded transcript must live under the workspace's ACCOUNT config dir (`projects/<worktree path with every non-alnum → '-'>/<sdkSessionId>.jsonl`).
- Re-review (#334, 2026-10-11): a predecessor exiting LATE deleted its successor's socket (server alive, unreachable, health
  `listening`). Fix: the entry remembers `ino:ctimeNs` of the socket it bound and unlinks only that; it never calls
  `server.close()`, because libuv unlinks the bound PATH on close, whatever is there now. Refusal-log budgets are per reason on a
  monotonic clock (a colleague's flood hid an owner-identity bad token; a wall-clock step back froze the window).
- Measuring fds: a shell pipeline's own pipes are fds — `ls /proc/$$/fd | sort` reported 3/4 as "inherited" 7/10 runs. The wrapper
  test lists the target's fds from a fork-free reader and waits for `close`, not `exit`.
