# Accounts & usage metering

Multi-account Claude login, usage bars, and the usage-limit prompt queue.
Files: `src/shared/accounts.ts` (+ `.test.ts`, pure logic),
`src/main/account-inherit.ts`, `account-usage.ts`, `usage.ts`,
`prompt-queue.ts`. UI: `AccountBadge.tsx`, `AccountsSettings.tsx`,
`AccountLoginModal.tsx`, `UsageBars.tsx`, `PromptQueueBanner.tsx`.
(Linear issue badges live in [linear.md](linear.md).)

## Accounts model
An "account" is a separate Claude Code **`CLAUDE_CONFIG_DIR`** with its own
`.credentials.json` OAuth token and conversation history. Orchestra runs agents
under different accounts by injecting that dir into the spawned `claude` PTY.
**Orchestra never mints/refreshes tokens** — Claude Code does; Orchestra only
reads them transiently to query usage.

`Account = {id, label, configDir, scratchDefault?, inherit?, env?}` (`accounts.ts:18`).
`configDir` supports templates (`~`, `${VAR}`) expanded by
`expandConfigDir(template, home, source)` `:230`.

- **Per-account env + auth ownership:** `env` is `{KEY: template}` (same `~`/`${VAR}`
  expansion, so store.json holds `${ANTHROPIC_API_KEY}`, never the secret;
  `sanitizeAccountEnv` / `expandAccountEnv` / `accountAgentEnv` in `accounts.ts`,
  `## per-account env`). `accountAgentEnv(account, home, process.env)` returns
  `{set, strip}`: `set` is injected right after `CLAUDE_CONFIG_DIR`, `strip` is the
  subset of `ACCOUNT_AUTH_ENV_VARS` (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`) the account does NOT re-supply — deleted from the inherited
  env for every PINNED account. Why: Orchestra merges the login shell's exports at
  boot (`shellEnvSync`, `index.ts`), and Claude Code sends `x-api-key` over an
  existing OAuth login whenever `ANTHROPIC_API_KEY` is in its env (measured
  2026-09-09 with a capture proxy) — an rc export would silently hijack every
  login-dir account. Unpinned (default-login) sessions keep the ambient env
  untouched. Applied on all three spawn paths: terminal PTYs via
  `resolveRepoAgentEnv` + `resolveRepoAgentStripEnv` → `startPty({extraEnv, stripEnv})`
  (`workspaces.ts`, `pty.ts`), SDK sessions in `buildSdkEnv` (`agent-sdk.ts`).
  NOT applied to self-tune runs (`self-tune.ts` passes only `configDirEnv`).
  UI: the "Extra env" textarea in `AccountsSettings` (`KEY=value` lines,
  `parseEnvLines`/`formatEnvLines`).

- **Pinning:** a workspace snapshots its repo's `accountId` at creation and keeps
  it for life (else `claude --continue` finds no session). `resolveWorkspaceAccountId(pinned,
  known)` `:245` → `null` falls back to the default `~/.claude` login. Changing a
  repo's account only affects *new* workspaces.
- **Scratch default:** scratch/orchestrator sessions have no repo to take an
  account from, so creation pins the one account flagged `scratchDefault: true`
  (`scratchDefaultAccountId(accounts)`, pure; `createScratchLikeWorkspace` in
  `workspaces.ts`). `store.setAccounts` keeps the flag on at most one account
  (first wins); the AccountsSettings checkbox ("Default for scratch sessions")
  behaves radio-like. No flag → default login, as before.
- **Migration** (existing workspace → another account): re-pinning alone breaks
  `--continue` (its transcript lives in the *old* config dir), so migration
  relocates the conversation too. `dispatchMigrateAccountRequest` (`workspaces.ts`)
  auto-stops the agent — `sdkStopIfLive` (always, so a detached keeper's CLI dies too), `killKeeper`
  (awaits the CLI/keeper death; `sdkStop` does not after a `result`) and `stopPtyAndWait` (`pty.ts`: awaits the PTY child's
  exit for 10 s, then SIGKILLs it — only if pid + /proc start-time still match, re-read at signal time — and waits 3 s more;
  a child that survives even that is LATCHED (`stuckPtyWriter`) and `dispatchMigrateAccountRequest` refuses every migration of
  that workspace, `ok:false` naming the pid, until it really exits — `stopPty` already dropped the session, so `isRunning()`
  no longer says so). The whole call runs under a per-workspace FENCE (`migration-fence.ts`, a leaf module): a 2nd overlapping
  migration → `ok:false "already in progress"`, and `startPty` / `ensureSessionInner` refuse to start an agent for that
  workspace (it would run on the OLD account and write into the dir being moved); the fence drops right after the
  re-pin (so the resume below works) and always in a `finally`. Then `moveWorkspaceTranscripts` moves
  `<old>/projects/<mangled-worktree>/` → the new account's config dir via `moveProjectTranscripts`
  (`transcript-move.ts`, #240): a no-op when source and destination are the SAME dir by identity (`sameDir`,
  `same-dir.ts`: resolved path, realpath or dev+ino — trailing `/`, `..`, symlink alias, a shared `projects/`, a bind
  mount; NEVER the raw config-dir strings, which used to `rm -r` the history; a FS reporting inode 0 is refused). Same
  filesystem: plain per-entry `rename` (atomic, a writer holding the fd follows the inode; a mid-way failure renames
  back what was moved). Cross-filesystem (EXDEV): `fs.cp` to a tmp name (mtimes kept) → verify (size + sha256) → rename
  into place → re-stat the source entry and remove it only if unchanged (else kept + warning). A destination entry of the
  same name is NEVER overwritten: identical = the source duplicate is dropped, different = kept in the source + a
  warning; a leftover `<name>.orchestra-mv-*` temp copy of an interrupted move is never carried onward (kept + warning); files
  created in the source after the listing are reported. Failures surface: `moveProjectTranscripts` returns `{warnings}`
  (unreadable source dir, entries kept, an unremovable duplicate, stranded new files; a mid-way failure's rollback trouble rides
  on the thrown error's message) → logged and returned as `MigrateAccountResult.warnings` (the CLI prints them to stderr; the
  renderer does not show them, D5). Then re-pins `ws.accountId`,
  `syncAccountInheritance(target)`, then resumes via `startAgentPty` if it was
  running — at the winsize the PTY had before the stop (`getPtySize`, pty.ts),
  not a blind 80×24: an already-visible terminal never re-asserts its size
  after a main-initiated respawn, so a default geometry would leave Claude's
  TUI drawing at half the pane width. Pure decision `planAccountMigration(current, rawTarget, known)`
  (`accounts.ts`) returns `error`/`noop`/`migrate` (empty target = default login).
  Works for git workspaces AND scratch/orchestrator sessions (the pin drives
  `CLAUDE_CONFIG_DIR` identically; a never-run session just has no transcript to
  move); refuses only an archived workspace. Reached from the socket
  `/migrateAccount` route, the `workspaces:migrateAccount` IPC, and the CLI
  `orchestra migrate-account`. UI: clicking the sidebar `WorkspaceAccountBadge`
  (`migratable` prop) opens `WorkspaceAccountMenu` — pick an account or "default
  login" to migrate that one workspace. The menu popover is `createPortal`'d to
  `document.body` and fixed-positioned from the trigger's rect (clamped to the
  viewport) so the sidebar's `overflow:hidden` can't clip it.
- **Inheritance** (`account-inherit.ts`): alternate logins inherit selected
  pieces of global `~/.claude` so they behave like the default. Files & skills →
  **symlink**; MCP servers → **merge** into the login dir's `.claude.json`
  (can't symlink — holds per-project trust). Manifest `.orchestra-inherited.json`
  tracks injections for clean removal and stamps `source` (the `~/.claude` the
  links were built from). Key fns: `listInheritables` `:128`,
  `defaultInheritForAccount` `:155`, `seedAccountInheritDefaults` `:176`,
  `syncAccountInheritance(account, opts)` `:576` (idempotent; run on account changes &
  each spawn). **A sync never strips because of its source (#235):** (1) `~/.claude`
  not a readable dir (`isReadableDir` `:190`) ⇒ return before ANY write (mkdir,
  dangling-link drop, prune, MCP removal, manifest) + one WARN; (2) PROVENANCE
  (D10, `builtFromElsewhere` `:245`): a manifest whose `source` differs from the
  current `~/.claude` (`sameDir`, now shared in `same-dir.ts`: same path, realpath or dev+ino) — or, legacy manifest
  without `source`, a link resolving outside it — ⇒ refused, no write, one WARN
  naming the OTHER source dir and the manifest to delete to re-home it. A source /
  link target that is definitely GONE (`isGone` `:232`: ENOENT/ENOTDIR, so a moved
  HOME, a poisoned stamp whose scratch HOME was deleted, a dangling link) is no
  evidence ⇒ re-home like master; ELOOP/EACCES stay refused. This protects a live
  config dir from a fake-HOME app whose readable-but-skeletal `~/.claude`
  (self-tune `ensureFoldTargets`, `claude -p`) a "source has entries?" test cannot
  tell apart; a first sync on a fresh account still writes + stamps. (3)
  `syncMcpServers` (`:489`) keeps injected servers + manifest list when
  `~/.claude.json` is missing/unparseable. (4) FULL PRUNE (#235 residual/C10,
  incident #3), keyed on EFFECT not selection shape: when the dir HOLDS inherited state
  (`heldInherited` `:274` — manifest links still symlinks + manifest MCP keys still in the login
  `.claude.json`, by presence; FAILS CLOSED — only ENOENT/ENOTDIR is "not held", a torn/unreadable
  `.claude.json` or an unreadable lstat (`linkState` `:260`) counts as held) and the sync would
  leave NO inherited item (`alive === 0`: empty/absent `inherit`, or a selection naming only
  missing sources, invalid names, an MCP server the global config lacks, or a slot holding the
  user's real dir — `linkWouldBeLive` `:291`; an unreadable MCP source keeps the held servers)
  ⇒ no write + ONE WARN naming the dir, held counts and `[caller= pid= HOME= ORCHESTRA_HOME=]`,
  unless `opts.userDeselected`. A swap to other existing items still applies. Only the Accounts UI
  setter grants that flag, PER ACCOUNT AND DIR: `apiHandlers.setAccounts` (`api-handlers.ts:534`, the
  only writer that can take a selection to empty — `seedAccountInheritDefaults` also writes
  `inherit`, absent → non-empty only) captures `store.accounts` BEFORE the save and
  `syncAfterAccountsSave` (`:697`) grants `deselectedAccountIds(before, saved, sameDir)`
  (`shared/accounts.ts:118`: non-empty → empty on an UNCHANGED resolved `configDir`, so an unrelated save
  of an already-empty account, a new account, or a save that also repoints `configDir` is NOT a
  de-selection of the dir it names). Runs after the D10 guard (a foreign-source dir is refused first,
  even for a UI de-selection). Every
  caller tags itself (`caller`: `boot` / `ui-save` / `spawn-sdk` / `spawn-pty` / `migrate` /
  `sandbox-import` / `login`) so a stray blocked sync is attributable from the WARN; a
  successful sync logs NOTHING, so "the live app logged no sync" is not evidence.
  Pre-existing: boot's seed re-seeds an account whose `inherit` is ABSENT (a UI
  de-select-all does not survive a restart); only `inherit: {}` reaches boot's sync empty. Known
  gaps (safe direction): a UI de-select whose sync is skipped (unreadable/foreign source) burns the
  grant — re-select then de-select; two accounts on one dir. Out of scope: an account whose
  `configDir` IS `~/.claude` (no `sameDir(loginDir, globalDir)` guard).
  (5) TORN-SAFE LOGIN `.claude.json` (#238/C11; `syncMcpServers` is its only writer). Premise, measured on claude
  2.1.284 (inotify): the CLI writes it as `mkdir <file>.lock` → tmp in the same dir → rename → `rmdir`, so THAT CLI
  never leaves a torn file — the producer of the field tear is UNEXPLAINED (the old in-place `writeFileSync` here is
  one candidate); fail-closed is right regardless. `viewFile` `:389` reads bytes + mtime through one fd — ONLY
  ENOENT/ENOTDIR is "absent" (start from `{}`); an empty/torn/non-JSON/non-object file (`parseJsonObject` `:413`;
  a leading UTF-8 BOM is stripped, the CLI tolerates one) or any other read error (EACCES…: rename would replace an
  unreadable file) ⇒ ONE WARN, file byte-identical, `prevKeys` returned so the manifest never claims servers it
  did not write and still owns the ones the file holds (a skip never orphans them), the link half of the sync still
  runs, the NEXT sync retries. A write is `replaceIfUnchanged` `:450`: tmp in the SAME dir (`.claude.json.orchestra-tmp-*`,
  created at the target's mode — 0600 for a fresh file, like the CLI — then fsync) → take the CLI's own lock
  (`mkdir <realpath>.lock`; EEXIST ⇒ `locked`: skip + WARN, retried next sync; a lock we did not create is NEVER broken,
  so a lock left by a crashed CLI blocks MCP writes for that dir — one WARN per sync — until the CLI's own next write
  clears it or the user removes it) → fresh re-read → replace only if bytes AND mtime still equal what was read (else
  `stale`) → `rename` → `rmdir` (always, in `finally`). An absent file is created by `link` (EEXIST ⇒ stale); on a
  filesystem WITHOUT hard links (EPERM…) it falls back to `rename`, which can overwrite a file created in that gap
  (accepted: the lock already keeps a lock-honouring CLI out). A symlinked `.claude.json` is written through
  (`resolveWriteTarget` `:426`; the lock sits next to the real file; dangling ⇒ skipped) — a symlink into a READ-ONLY
  dir with a writable file now fails to write (tmp cannot be created there; one "failed to write" WARN per sync;
  in-place writing used to work — accepted-gap). A merge that already equals the file writes NOTHING. Measured
  (`~/.orchestra/ops-wave-c/reviewer-c11/p4.mjs` shape, lock-honouring writer, 8 s): without our lock the sync lost
  166/867 CLI increments (writer 108/s) and 363/103096 (writer flat out); with it 0/843 and 0/76170. Residual: a
  writer that does NOT take the lock can still land between the re-read and the rename (sub-ms). Arms:
  `account-inherit.test.ts` "#238 …" (torn table ×12 incl. BOM-only, interleave ×6 via `hookOnce` on the write seam,
  link-gap, rename-fail, re-read-fail, 000-mode, symlink/dangling, mode incl. 0664, idempotent, literal normal file,
  BOM, link→EPERM, F1 lock held / lock held-and-released, F3 manifest retention at each of the 5 skip sites, F2 INFO
  counts) and rig arms `torn_json_boot` / `torn_json_ui_save`. A UI de-select-all that lands on a torn/locked file
  is never completed (MCP prune skipped, then every later plain sync is blocked by (4)) — accepted, safe direction,
  same class as the burnt UI grant above.
  ALIASED ENTRIES (#241/C14): a login `skills/` symlinked to the source's `skills/` makes every `skills/<n>` slot one of
  the SOURCE's own links (often dotfile links) — the sync used to `unlink`/repoint them as "ours" (`ensureSymlink` `:300`
  repoint, stale-drop, `removeOurSymlink` `:376`), destroying the source's. `slotOwner` `:362` realpaths the slot's PARENT and
  decides 'source' by IDENTITY — `sameDir` (`src/main/same-dir.ts`, the ONE shared definition: path | realpath | dev+ino) of that
  parent and `<source>/dirname(rel)` — so a source `skills/` folded OUTSIDE `~/.claude` (stow/dotfiles), a bind-mounted `skills/`
  and an ANCESTOR login dir (`configDir=~`, `~/skills` -> the source's) are recognised; failing that, a slot inside the real
  source but outside the real login dir (an alias onto ANY source dir) is 'source' too. 'ok' = the login dir's own slot (a
  child account inside the source, a not-yet-existing parent); 'unknown' = unresolvable (ELOOP…), fail closed. Those rels
  (wanted now OR listed in the manifest) form `untouchable` `:524`: ONE WARN per sync, skipped in the apply and prune loops, out of
  the C10 alive count AND out of `held` (the source's links seen through the alias are not "held": no bogus block, the UI log
  reports what was actually pruned). Manifest: a 'source' slot is shed (never ours); an 'unknown' one that the previous manifest
  listed is RETAINED verbatim, so a transient ELOOP cannot orphan our own links (the next sync prunes them). Accepted gaps: an alias
  into ANOTHER account's login dir is managed as that account's dir (its links are claimed, and pruned on de-selection until
  its next sync re-creates them); a legacy (unstamped) manifest + alias is refused by D10 first ("built from <dotfiles>",
  safe direction); aliasing of the MCP `.claude.json` file is C12's same-file guard.
  Rig: `scripts/e2e-inherit-empty-no-prune.mjs all` (REAL `setAccounts` + store + logger,
  scratch HOME, live-dir `find` canary). Same-source partial prune/de-selection is
  unchanged. Rig traps: a fake-HOME boot pinned to a LIVE configDir stripped
  `~/.claude-mc` twice (2026-09-29) — never point a rig's configDir at a live
  `~/.claude*` (`account-inherit.test.ts` scratch-only harness refuses one).
  Accepted gaps: links present but an empty/absent/torn manifest (unattributable
  until the first same-source sync stamps it; also invisible to (4)); the MCP source `~/.claude.json` is
  not stamped (needs a fake HOME whose `~/.claude` symlinks the live one).
- **Login flow:** interactive `claude /login` in a dedicated PTY
  (`account-login:<accountId>`); `armLoginWatch` (`account-usage.ts:284`) +
  `watchForLogin` `:101` watch `.credentials.json` for a new token via `fs.watch`
  + 1.5s poll, then fire `onLoggedIn` → refresh. UI: `AccountLoginModal.tsx`
  hosts the xterm; on PTY exit it calls `refreshAccounts()`.
- **Per-account OAuth browser** (`src/main/login-browser.ts`): the browser half
  of `/login` must NOT land in the system browser — its one claude.ai cookie
  jar is already the user's main account, so a secondary account's login would
  silently authorize the wrong account. Each account instead gets its own
  **isolated Chromium profile**: `openLoginChromium` spawns a real
  Chromium-family browser (`CHROMIUM_CANDIDATES`, resolved by an explicit
  PATH probe in `findChromium` — on Fedora `chromium` is a shell alias with no
  executable, so a bare spawn ENOENTs) against
  `<orchestraHome>/login-profiles/login-<accountId>`. `--user-data-dir` is the
  load-bearing flag: `--profile-directory` would attach to the user's RUNNING
  browser and inherit the main account's session. Pure helpers live in
  `src/shared/login-chromium.ts` (`isLaunchableUrl` refuses a leading `-`, so a
  crafted URL can't smuggle Chromium switches into argv).
  *Why a real browser:* Electron cannot run a Manifest V3 extension's service
  worker (measured on Electron 33 vs 1Password 8.12 — `chrome.action` /
  `offscreen` / `privacy` / `windows` are all missing, the worker throws at
  startup and never registers), so password managers are inert inside a
  `BrowserWindow`. Isolation was only ever a cookie-jar requirement, and a
  dedicated user-data-dir satisfies it while keeping the user's real extensions.
  The `BrowserWindow` on a persistent session partition
  (`persist:claude-login-<id>`, UA stripped of Electron/Orchestra tokens so
  Google's embedded-webview OAuth block doesn't trip) remains the **fallback**
  when no Chromium is installed. `closeLoginBrowser` tears down both: it
  signals the browser's process GROUP (`-pid`, since the child is `detached`) —
  signalling the bare pid leaves the renderer/zygote children on screen.
  URLs reach it two ways,
  both via `dispatchLoginUrlRequest` (host-anchored `isClaudeAuthUrl` in
  `accounts.ts` gates which URLs get the partition; others → `openExternal`):
  (1) claude's auto-open, intercepted by the `xdg-open`/`open` PATH shim
  (`installLoginBrowserShim`, `cli-shim.ts`) → `orchestra login-url` →
  `/loginUrl` socket route (the login PTY carries `ORCHESTRA_LOGIN_ACCOUNT` +
  `ORCHESTRA_SOCK` + shimmed PATH/`BROWSER`); (2) the modal's link handler →
  `accounts:loginOpenUrl` IPC. Token detection and `accounts:loginStop` both
  `closeLoginBrowser`. Right-click menu offers a system-browser escape hatch.
  Windows has no shim (powershell opener) — link-click routing still applies.

## Usage metering — two pollers
The endpoint is `https://api.anthropic.com/api/oauth/usage` (headers:
`Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`, CC user-agent) —
the same source Claude Code's `/usage` reads. Pure parsers in `accounts.ts`:
`parseCredentials` `:159`, `isExpired` `:177` (60s grace), `parseUsageResponse`
`:210` (tolerates null windows; an **enabled** `extra_usage` pool with
null/absent `utilization` parses as `extraUtilization: 0`, not null — a freshly
enabled pay-as-you-go pool must read as "0% used, absorbing overflow", else a
maxed 5h/7d account stays limited and the queue banner never clears),
`classifyHttpError` (403→`no-scope`, 429→`rate-limited`). The Fable-scoped
weekly cap has NO top-level window — it's a `weekly_scoped` entry in the
response's `limits[]` whose `scope.model.display_name` is "Fable";
`parseFableWindow` maps it to `UsageData.fable` (null when the plan has none).
It is display-only: `usageLimitedUntil` deliberately ignores it, since a maxed
Fable window only blocks Fable requests while other models keep answering.

- **Global poller — usage.ts** (default login): one snapshot every ~60s,
  persisted to disk (bars paint immediately next launch), exponential backoff to
  10 min on 429. `getLastUsage` `:109`, `startUsagePolling(window)` `:210`. IPC
  `usage:update`/`usage:get`. Feeds workspaces with no pinned account. Its
  `parseSnapshot` delegates to the shared `parseUsageResponse` so the default
  login carries `extraUtilization` too (`UsageSnapshot.extraUtilization`,
  optional) — without it a maxed default account would ignore extra credits and
  stay "limited" in the queue banner.
- **Per-account poller — account-usage.ts**: each configured account, **≥180s
  cache per account** (API hard floor), 30s wake loop refreshing stale accounts.
  Detects expired tokens (keeps showing cached data, flags expiry).
  `snapshotAccountUsage` `:265`, `getAccountUsage` `:272`,
  `computeWorkspaceAccounts` `:309` (workspace→account *identity* map — never
  paths/tokens), `startAccountUsagePolling` `:356`, `refreshAccountsNow` `:373`.
  IPC `accounts:usageUpdate`/`accounts:usage`/`accounts:usageAll`/
  `accounts:workspaceAccounts`. The workspace→account map is re-broadcast each
  30s tick, but creation and migration don't wait for it: `createWorkspace`,
  `createScratchLikeWorkspace`, and `dispatchMigrateAccountRequest`
  (`workspaces.ts`) each call `refreshAccountsNow` so the new/changed
  workspace's badge and usage bars show the pinned account immediately instead
  of "default" for up to 30s.

Shapes (`accounts.ts`): `UsageData = {fiveHour, sevenDay, extraUtilization}`
(each window `{utilization 0–100, resetsAt}`); `AccountUsageStatus = {accountId,
ok, data, errorKind, errorMessage, fetchedAt, expired?}`; `UsageErrorKind =
'no-dir'|'not-logged-in'|'no-scope'|'rate-limited'|'error'`.

**Security:** tokens never leave the main process — the renderer sees only
account identity (id/label) and usage numbers.

## Structural rate-limit detection from a turn result (#26 item 2)
Besides `rate_limit_event` (the quota surface above), a TURN can terminate on a
usage limit. `classifyTurnError(api_error_status)` in `src/shared/agent-events.ts`
reads the HTTP status structurally — **429 → `rate-limit`**, **529 → `overload`**,
else `error` — and a 429 emits the same `rate-limit` notice this UX already
renders, so a limit-terminated turn stops looking like a generic error.
**529 is deliberately excluded**: it is transient upstream overload, not a quota
problem, so it must never park prompts on the queue. See
[structured-agent-view.md](structured-agent-view.md).

## Auto-resume when the usage limit resets (#74)

A session whose turn DIED on the usage limit is now restarted automatically
when the window resets — the fleet-freeze fix (a coordinator died on "resets
6pm" and nothing noticed for 75 minutes). Distinct from the prompt queue above:
the queue delivers prompts a USER parked; this resumes an agent that was cut
off mid-task and had nothing queued.

- **Detection is STRUCTURAL, never the error prose.** Two producers, both in
  `src/shared/agent-events.ts`, and both now set `rejected: true` on the
  `rate-limit` notice: the SDK's `rate_limit_event` (`status === 'rejected'`,
  carrying `resetsAt`) and the 429 turn result via `classifyTurnError` (see the
  section above; it carries NO reset time). The `rejected` flag exists because
  normalization otherwise collapses a real rejection and a mere
  `allowed_warning` into one notice kind distinguishable only by its English
  text — which is UI copy, free to be reworded.
- **Pure logic** (`src/shared/usage-resume.ts`, tested in `usage-resume.test.ts`):
  - `resetsAtMsFromNotice` — **the unit boundary**. The notice's `resetsAt` is
    epoch **SECONDS**; `usageLimitedUntil` and `Workspace.usageLimitResetsAt`
    are epoch **MS**. The conversion happens here and nowhere else, and refuses
    a value already in ms rather than silently producing a year-51000 date.
  - `decideResume` — the whole policy: only `lastStopReason === 'usage_limit'`
    is eligible (never blanket-wake idle workspaces); the reset must have
    passed; **banner-queued prompts WIN over the nudge** (user intent beats a
    synthesized one); then staggering — coordinators resume at the reset,
    everyone else additionally needs a usage reading fetched after the block.
  - `isActionableStopReason` / `ACTIONABLE_STOP_REASONS` — the shared predicate
    replacing what were **seven** hardcoded `'max_turns' || 'error'` copies
    across the renderer (the five in `Sidebar.tsx` / `InboxBell.tsx` /
    `JumpPalette.tsx` / `ResourcesView.tsx`, plus the `stopReason` prop type in
    `WorkspaceStatusGlyph.tsx` and the tooltip in `status-glyph-title.ts`).
  - `RESUME_NUDGE_TEXT` — a GENERIC nudge. The interrupted input is **never**
    replayed: the killed turn may have half-executed, so a replay re-runs side
    effects. It tells the agent to re-read its own durable state instead.
- **Producer** (`src/main/agent-sdk.ts`): a rejection seen mid-turn is LATCHED
  on the session (`rateLimitHit`) and applied at `turn-end` only if the turn
  actually ended in error — a limit the CLI retried through is not a stopped
  session. The latch is cleared at every turn boundary so it cannot mark a
  later healthy turn.
- **Store** (`src/main/activity.ts`): `markStoppedOnUsageLimit(id, resetsAtMs)`,
  the sibling of `markStoppedOnMaxTurns`, writing `lastStopReason:
  'usage_limit'` plus `Workspace.usageLimitResetsAt`; `clearStopReason(id)`
  drops it once resumed (without which every 20s tick would nudge again).
  Both take the same outside-the-`driveStatus`-gate exemption `markLooping`
  does, and for the same reason.
- **Driver** (`src/main/prompt-queue.ts`): `resumeUsageLimited(now)` runs at the
  head of the existing flusher tick — same inputs, same cadence, and one place
  where the queue-vs-nudge precedence is decided. Candidates are sorted
  coordinators-first so a coordinator is back up before its fleet asks it for
  work, and capped at `MAX_RESUMES_PER_TICK` so a large fleet spreads over
  successive ticks instead of waking in one pass (the budget is spent only by a
  real resume — a `wait` costs nothing, or not-yet-due workspaces would starve
  the due ones).
- **The failure compensator is load-bearing.** The nudge path clears the pause
  marker BEFORE waking (so a slow wake is not started twice) and **re-marks on
  failure**. Without that re-mark a failed wake leaves the workspace outside the
  `lastStopReason === 'usage_limit'` candidate filter, so no later tick
  reconsiders it: frozen forever, with the ⏸ glyph gone so nothing on screen
  says to look. Reachable — `wakeAgentWithPrompt` returns false when a terminal
  PTY coexists (`isRunning`), which the filter does not exclude, AND (#227) when the
  SDK session cannot start (there is no PTY fallback any more). `flushQueuedPrompts`
  pairs the same ordering with `requeue()`; this path needs its own equivalent.
- **Session death is a SECOND detection site.** `consume()`'s `finally`
  (`src/main/agent-sdk.ts`) builds its own `turn-end` and emits it directly,
  bypassing `emitFrom` where the latch lives (`emitFrom` has exactly one call
  site). So a rejection followed by the subprocess dying before any `result`
  must be marked there too, or the die-before-result shape — plausibly the
  original incident — is never detected. Interrupted sessions are excluded on
  both paths.
- **The gate excludes `max_turns` AND `interrupted`.** Enumerated over the
  reachable `result` shapes: 429-limit and plain error → (`'error'`, true);
  `error_during_execution` → (`'interrupted'`, true); clean success →
  (`'end_turn'`, **false**); max_turns → (`'max_turns'`, true). The pair
  (`'end_turn'`, true) is impossible by construction, since `toStopReason`
  returns `'error'` whenever `is_error` is truthy. Without the `interrupted`
  exclusion a user who hits the limit and then stops the turn would be
  auto-resumed against their own interrupt.
- **Surface**: the sidebar/inbox/palette/Resources glyph gains a pause shape
  (`.ws-glyph-usagelimit`, muted rather than red — nothing is wrong and nobody
  is needed), and the tooltip reads `⏸ limit reached — resumes ~6pm`, dropping
  the ETA when the reset time is unknown rather than inventing one.
- **Scope**: STRUCTURED (SDK) sessions only — the raw PTY path carries no
  structured limit signal. A `/loop` wakeup armed before a limit hit is still
  not re-armed at the reset (`src/main/loop-scan.ts`): declared OUT of v1.

## Prompt queue on usage limit — prompt-queue.ts
While a workspace's account is over its 5h/7d limit, prompts can be parked on
the workspace record (`Workspace.queuedPrompts`, `types.ts` — persisted, so a
queue survives restarts) instead of burning turns on "limit reached" errors.

- **Pure logic** (`accounts.ts`): `usageLimitedUntil(data, now)` — a window
  blocks at utilization ≥ 100; enabled extra-usage under 100% absorbs it;
  returns the LATER blocked reset (or null = usable). `canAutoFlushQueue`
  — auto-delivery requires a reading **fetched after** the newest queued
  prompt that shows the account un-limited (a stale pre-limit snapshot must
  not flush straight into the wall). Both covered in `accounts.test.ts`.
- **Main** (`src/main/prompt-queue.ts`): `addQueuedPrompt` / `removeQueuedPrompt`
  / `flushQueuedPrompts` (clears the queue *before* delivery so a tick +
  "Send now" race can't double-send; failure paths re-queue). Delivery joins
  the queue into ONE turn and reuses the peer-message path: `writePty` + `\r`
  into a live TUI, else the exported `wakeAgentWithPrompt` (`workspaces.ts`)
  with the same 5s died-immediately insurance. `startPromptQueueFlusher`
  ticks every 20s over pure cache reads (`getAccountUsage` / `getLastUsage` —
  no network of its own) and, once a blocked reset time passes, nudges
  `refreshAccountsNow` (throttled 120s per workspace) so the ≥180s account
  cache proves the reset promptly.
- **IPC**: `queue:add` / `queue:remove` / `queue:flush` (force — skips the
  limit check); queue state travels on the normal `workspace:update` events.
- **UI**: `PromptQueueBanner.tsx` above the pane row (see
  [renderer-ipc-ui.md](renderer-ipc-ui.md)).

## UI components
- **AccountBadge.tsx** — `RepoAccountBadge` `:105`, `WorkspaceAccountBadge` `:119`,
  `WorkspaceContextBadge` `:92`. Colour tint by the hotter window
  (≥90% crit/≥75% warn); `loginColor` `:36` hashes the name to a stable HSL.
- **UsageBars.tsx** — slim 5h/7d bars (plus a "Fable" bar when the account has
  a Fable-scoped weekly limit; panel rows show it as "F7D", and an "EX"/"ex"
  bar when the account's pay-as-you-go pool is enabled — `extraUtilization`
  non-null. The extra-credits cell is a spend meter, not a rolling window: it
  has no `resetsAt`, so its tooltip omits the "resets in" clause; it hides
  entirely when the pool is disabled) for the active
  workspace's account, plus a
  hover panel of all accounts sorted hottest-first. An "updated Xm ago" stamp
  (from the snapshot's `fetchedAt`) sits directly on the strip — centered in
  the 7d bar's head, mirroring the account name on the 5h bar — and on each
  panel row, so staleness is visible without hovering.
- **AccountsSettings.tsx** — manage accounts + inheritance checkboxes/chips
  (populated from `listGlobalInheritables`); saves via `setAccounts` then syncs.

## Tests
`transcript-move.test.ts` covers `sameDir` (every spelling, hard link = the dev+ino clause, look-alikes) and
`moveProjectTranscripts` (same dir via trailing slash / `..` / symlink / shared `projects/` / project-dir
symlink survives; same-FS rename keeps inode + mtime and a fd-holding writer; mid-way rename/copy failure, truncated copy,
size-preserving bit flip, skipped entry all leave the source intact; a different/appearing destination entry is never
overwritten; a source that changed after it was read is kept; late file not deleted). Driven proof through the REAL
`dispatchMigrateAccountRequest`: `scripts/e2e-migrate-transcripts.mjs all` (23 arms incl. bind mount under
`unshare -rm`, a cross-filesystem EXDEV target, 2 overlapping migrations, a real agent PTY still writing / ignoring HUP+TERM
(SIGKILL escalation, retry), a SIGKILL-proof child (latch), a recycled-pid guard, the start fence, and a REAL detached
`keeper.js` + fake CLI — needs `pnpm run build:keeper`; scratch HOME, live-dir canary).
`accounts.test.ts` covers `expandConfigDir`, `parseCredentials`, `isExpired`,
`parseUsageResponse`, `classifyHttpError`, `resolveWorkspaceAccountId`,
`planAccountMigration` (migrate/noop/error, default-login clear, trimming),
`sanitizeAccountInherit`, `usageLimitedUntil`, and `canAutoFlushQueue`.
`usage-resume.test.ts` covers the auto-resume policy above: the
seconds→ms conversion (both wrong-direction failures), the shared
stop-reason predicate, and every `decideResume` clause — each proven by
mutation to fail on the unfixed logic.
