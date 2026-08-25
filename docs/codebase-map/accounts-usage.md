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

`Account = {id, label, configDir, scratchDefault?, inherit?}` (`accounts.ts:18`).
`configDir` supports templates (`~`, `${VAR}`) expanded by
`expandConfigDir(template, home, source)` `:130`.

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
  auto-stops the agent, `moveWorkspaceTranscripts` moves
  `<old>/projects/<mangled-worktree>/*.jsonl` → the new account's config dir
  (per-file `rename`, EXDEV→copy+unlink), re-pins `ws.accountId`,
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
  tracks injections for clean removal. Key fns: `listInheritables` `:111`,
  `defaultInheritForAccount` `:138`, `seedAccountInheritDefaults` `:159`,
  `syncAccountInheritance(account)` `:304` (idempotent; run on account changes &
  each spawn).
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
  work.
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
`accounts.test.ts` covers `expandConfigDir`, `parseCredentials`, `isExpired`,
`parseUsageResponse`, `classifyHttpError`, `resolveWorkspaceAccountId`,
`planAccountMigration` (migrate/noop/error, default-login clear, trimming),
`sanitizeAccountInherit`, `usageLimitedUntil`, and `canAutoFlushQueue`.
`usage-resume.test.ts` covers the auto-resume policy above: the
seconds→ms conversion (both wrong-direction failures), the shared
stop-reason predicate, and every `decideResume` clause — each proven by
mutation to fail on the unfixed logic.
