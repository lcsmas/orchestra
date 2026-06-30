# Accounts, usage metering & Linear

Multi-account Claude login, usage bars, and Linear issue badges. Files:
`src/shared/accounts.ts` (+ `.test.ts`, pure logic), `src/main/account-inherit.ts`,
`account-usage.ts`, `usage.ts`, `src/main/linear.ts` + `src/shared/linear.ts`
(+ `.test.ts`). UI: `AccountBadge.tsx`, `AccountsSettings.tsx`,
`AccountLoginModal.tsx`, `UsageBars.tsx`, `LinearSettings.tsx`.

## Accounts model
An "account" is a separate Claude Code **`CLAUDE_CONFIG_DIR`** with its own
`.credentials.json` OAuth token and conversation history. Orchestra runs agents
under different accounts by injecting that dir into the spawned `claude` PTY.
**Orchestra never mints/refreshes tokens** — Claude Code does; Orchestra only
reads them transiently to query usage.

`Account = {id, label, configDir, inherit?}` (`accounts.ts:18`). `configDir`
supports templates (`~`, `${VAR}`) expanded by `expandConfigDir(template, home,
source)` `:130`.

- **Pinning:** a workspace snapshots its repo's `accountId` at creation and keeps
  it for life (else `claude --continue` finds no session). `resolveWorkspaceAccountId(pinned,
  known)` `:245` → `null` falls back to the default `~/.claude` login. Changing a
  repo's account only affects *new* workspaces.
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

## Usage metering — two pollers
The endpoint is `https://api.anthropic.com/api/oauth/usage` (headers:
`Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`, CC user-agent) —
the same source Claude Code's `/usage` reads. Pure parsers in `accounts.ts`:
`parseCredentials` `:159`, `isExpired` `:177` (60s grace), `parseUsageResponse`
`:210` (tolerates null windows), `classifyHttpError` `:228` (403→`no-scope`,
429→`rate-limited`).

- **Global poller — usage.ts** (default login): one snapshot every ~60s,
  persisted to disk (bars paint immediately next launch), exponential backoff to
  10 min on 429. `getLastUsage` `:109`, `startUsagePolling(window)` `:210`. IPC
  `usage:update`/`usage:get`. Feeds workspaces with no pinned account.
- **Per-account poller — account-usage.ts**: each configured account, **≥180s
  cache per account** (API hard floor), 30s wake loop refreshing stale accounts.
  Detects expired tokens (keeps showing cached data, flags expiry).
  `snapshotAccountUsage` `:265`, `getAccountUsage` `:272`,
  `computeWorkspaceAccounts` `:309` (workspace→account *identity* map — never
  paths/tokens), `startAccountUsagePolling` `:356`, `refreshAccountsNow` `:373`.
  IPC `accounts:usageUpdate`/`accounts:usage`/`accounts:usageAll`/
  `accounts:workspaceAccounts`.

Shapes (`accounts.ts`): `UsageData = {fiveHour, sevenDay, extraUtilization}`
(each window `{utilization 0–100, resetsAt}`); `AccountUsageStatus = {accountId,
ok, data, errorKind, errorMessage, fetchedAt, expired?}`; `UsageErrorKind =
'no-dir'|'not-logged-in'|'no-scope'|'rate-limited'|'error'`.

**Security:** tokens never leave the main process — the renderer sees only
account identity (id/label) and usage numbers.

## Linear integration
Turns a branch name into a verified issue badge.
- `parseLinearIssueCandidate(branch)` (`shared/linear.ts:28`) — extracts a
  `TEAM-NUMBER` token (whole-token regex; `nmc-261-…`→`NMC-261`; permissive, may
  yield false candidates like `POLL-429`).
- `verifyLinearIssue(branch)` (`main/linear.ts:112`) — queries Linear GraphQL
  (`https://api.linear.app/graphql`, `Authorization: <key>` no Bearer) and only
  returns a `LinearIssue` (`types.ts:227`) if the returned `identifier` matches.
  Caches hits *and* misses; `noApiKey` latch (`:32`) stops retrying after 401/403
  until the user saves a new key (`resetLinearAuthState` `:52`).
- Key resolution (`:37`): stored key → `LINEAR_API_KEY` env → none.
  `getLinearKeySource` `:46`. Stored via `secrets.ts` (encrypted). UI:
  `LinearSettings.tsx` (test/save/clear). IPC: `linear:keySource`/`checkKey`/
  `saveKey`/`clearKey`.

## UI components
- **AccountBadge.tsx** — `RepoAccountBadge` `:105`, `WorkspaceAccountBadge` `:119`,
  `WorkspaceContextBadge` `:92`. Colour tint by the hotter window
  (≥90% crit/≥75% warn); `loginColor` `:36` hashes the name to a stable HSL.
- **UsageBars.tsx** — slim 5h/7d bars for the active workspace's account, plus a
  hover panel of all accounts sorted hottest-first.
- **AccountsSettings.tsx** — manage accounts + inheritance checkboxes/chips
  (populated from `listGlobalInheritables`); saves via `setAccounts` then syncs.

## Tests
`accounts.test.ts` covers `expandConfigDir`, `parseCredentials`, `isExpired`,
`parseUsageResponse`, `classifyHttpError`, `resolveWorkspaceAccountId`,
`sanitizeAccountInherit`. `linear.test.ts` covers `parseLinearIssueCandidate`
(normalization, path-style, whole-token, permissiveness).
