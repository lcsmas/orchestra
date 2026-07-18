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
  silently authorize the wrong account. Each account instead gets a
  `BrowserWindow` on its own persistent session partition
  (`persist:claude-login-<id>`), UA stripped of Electron/Orchestra tokens so
  Google's embedded-webview OAuth block doesn't trip. URLs reach it two ways,
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
  a Fable-scoped weekly limit; panel rows show it as "F7D") for the active
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
