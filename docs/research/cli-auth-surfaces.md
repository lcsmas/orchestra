# Claude Code CLI: official non-interactive auth surfaces

Research for [#245](https://github.com/lcsmas/orchestra/issues/245), which is part of map [#243](https://github.com/lcsmas/orchestra/issues/243).
Measured on 2026-09-30 against the installed CLI **2.1.284** (`claude --version`), Agent SDK **0.3.241** (the version pinned in `package.json`), https://code.claude.com/docs, and `anthropics/claude-code` CHANGELOG.md, whose latest heading is 2.1.285.

Each claim carries a tag:
- **[S]** means SOURCED: from a doc URL, a changelog version, the SDK types or the CLI bundle, or from a command I ran against a scratch dir.
- **[I]** means INFERRED.

Bundle citations are literal strings you can grep in `strings -n 6 ~/.local/share/claude/versions/2.1.284`. Every `claude` call ran through `env -i HOME=<scratch> CLAUDE_CONFIG_DIR=<scratch>`. No OAuth flow was started.

## Verdict

1. **No surface signs a Compte in without a browser step, and none should.** Every mint path goes through the claude.ai authorize page. The legal page forbids a third party from running that flow itself: "developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow" [S, legal-and-compliance]. The carve-out is an end user signing in to "the unmodified Claude Code binary" with their own subscription [S, same page]. So the "Orchestra does the OAuth itself" fallback that #243 lists is **policy-blocked**. The CLI has to own the flow.
2. **`claude auth login` is a documented, line-oriented CLI flow that needs no PTY and no TUI** [S, bundle + cli-reference; since 2.1.41].
   - It prints `If the browser didn't open, visit: <manual URL>`.
   - It opens the automatic URL through `$BROWSER`, falling back to `xdg-open`. That automatic URL redirects to a localhost callback the CLI listens on.
   - It also accepts `code#state` pasted on **stdin** (since 2.1.126).
   - On success it prints `Login successful.`, exits 0, and writes to `$CLAUDE_CONFIG_DIR`.

   So the PTY can go today. Orchestra can spawn this command as a plain child with pipes and hand the URL to its own window.
3. **`claude auth status --json` is the documented non-interactive state probe** [S]. It exits 0 when signed in and 1 when not.
   - For a claude.ai login it returns `email`, `orgId`, `orgName` and `subscriptionType`.
   - It is **local-only**: a fake `CLAUDE_CODE_OAUTH_TOKEN` reads `loggedIn: true` [S, ran]. It cannot detect expiry or revocation.
4. **`setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` are unfit for Comptes** [S].
   - They have **inference-only scope** (`user:inference`).
   - There is no refresh token, and no email or plan comes back.
   - Usage and profile need `user:profile`.
   - `setup-token` is an interactive Ink TUI.
5. **The cleanest protocol exists but is undocumented.** It is the Agent SDK control requests `claude_authenticate`, `claude_oauth_callback` and `claude_oauth_wait_for_completion`.
   - `claude_authenticate` returns `{manualUrl, automaticUrl}` without opening a browser.
   - The completion request resolves with `{account:{email, organization, subscriptionType, …}}`.
   - These are in `sdk.mjs` but absent from `sdk.d.ts` and from the SDK docs [S]. Treat them as unstable.

## Per-surface table

| Surface | Documented? | Since | Interactive? | Writes what, where | Lifetime / scopes |
|---|---|---|---|---|---|
| `claude auth login [--claudeai\|--console] [--email E] [--sso]` | Yes, [cli-reference](https://code.claude.com/docs/en/cli-reference). `--claudeai` appears only in `--help` | 2.1.41. `--console` 2.1.79. Stdin code paste 2.1.126 [S, changelog] | Needs a browser step, but no TTY: stdout is text and stdin reads `code#state` lines [S, bundle: `Paste code here if prompted > `, `createInterface({input:process.stdin})`] | `.credentials.json` (0600) under `$CLAUDE_CONFIG_DIR`, or the Keychain on macOS, keyed to the dir [S, [authentication](https://code.claude.com/docs/en/authentication)]. Also `oauthAccount` and `hasCompletedOnboarding` in `.claude.json` [S, bundle] | Default scopes: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload` (+`user:plugins`) [S, bundle `r=[KV,mT,"user:sessions:claude_code",…]`]. Refresh token included. The access-token TTL comes from the server's `expires_in`. It is about 8 h [I, changelog 2.1.86 "8 hours after login"] |
| `claude auth login` + `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `CLAUDE_CODE_OAUTH_SCOPES` | Yes, [env-vars](https://code.claude.com/docs/en/env-vars): "exchanges this token directly instead of opening a browser" | Not in the changelog. Present in 2.1.284 | **No**. It fails fast without the scopes [S, ran: rc=1 with `CLAUDE_CODE_OAUTH_SCOPES is required…`] | Same as `auth login`. The exchange asks for `expiresIn: 31536000` [S, bundle `Kce(C,{scopes:s,expiresIn:fY…})`] | The scopes you pass. But you need a refresh token minted elsewhere, and minting one yourself is the policy-blocked path [I] |
| `claude auth status [--json\|--text]` | Yes, cli-reference. `configDirectory` field since 2.1.268 | 2.1.41 | No. Exit 0 = logged in, 1 = not [S, ran] | Creates `.claude.json` plus `backups/` in the config dir, even when signed out [S, ran] | Keys: `loggedIn, authMethod (none\|claude.ai\|oauth_token\|api_key\|api_key_helper\|third_party), apiProvider, analyticsDisabled, projectsDirectory, configDirectory`, and optionally `forcedLoginMethod, apiKeySource`. `email, orgId, orgName, subscriptionType` appear only when `authMethod==="claude.ai"` [S, bundle `a={loggedIn:S,authMethod:p,…}`]. No network validation [S, ran with a fake token] |
| `claude auth logout` | Yes, cli-reference | 2.1.41 | No [S, ran: rc=0 `Successfully logged out…`] | Clears credentials. On the scratch dir it also removed `.claude.json` and its backups [S, ran]. `/logout` also clears MCP logins and plugin secrets [S, troubleshoot-install] | n/a. Whether it revokes server-side is NOT VERIFIED |
| `claude setup-token` | Yes, authentication ("one-year OAuth token… does not save the token anywhere") | Not in the changelog. First mention is 2.1.212 (a fix) | **Yes**: an Ink TUI browser flow [S, bundle `Long-lived authentication token created successfully!`] | Nothing. The token goes to the terminal only [S, docs] | `scope=user:inference` only (`inferenceOnly ? [mT]`). Asks for `expires_in` of 1 year [S, bundle `W6n`, `fY=31536000`]. The bundle says: "Long-lived tokens (from `claude setup-token` or CLAUDE_CODE_OAUTH_TOKEN) are limited to inference-only" |
| `CLAUDE_CODE_OAUTH_TOKEN` env | Yes, env-vars and authentication (precedence #5) | Changelog 2.1.117 (a fix) | No | Nothing. Read from env each session | Scopes default to `["user:inference"]` unless `CLAUDE_CODE_OAUTH_SCOPES` is set [S, bundle `Jv(e=["user:inference"])`]. `refreshToken:null, expiresAt:null`: it is never refreshed. On a 401 the CLI keeps the env token: "Mint a fresh token… and restart" [S, bundle]. **Cannot read `/api/oauth/usage` or the profile** (needs `user:profile`) [S, sdk.d.ts `rate_limits_available`: "missing profile scope" → null]. Also a `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` variant [S, bundle; undocumented] |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper` | Yes, authentication precedence #2–4, settings | Helper 0.2.74. TTL env 0.2.117 | No | Nothing | API-key billing. Out of scope for #243 (API-key Comptes unchanged) |
| `/login`, `/logout`, `/status` (slash) | Yes, commands | old | **Yes**. Needs the TUI, which is what Orchestra drives today | Same as `auth login` | Same as `auth login` |
| `claude doctor` | Yes, cli-reference | 2.0.33 | No | Nothing | Diagnostics only. Not an auth-state API [I] |
| SDK `query.accountInfo()` and `initialize.account` | Yes, `sdk.d.ts:23-33, 2590-2594, 3745` and [agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript) | SDK 0.3.x | No. Needs a live session | Nothing | `{email, organization, subscriptionType, tokenSource, apiKeySource, apiProvider}` |
| SDK `get_usage` control request | Marked experimental: `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` [S, `sdk.d.ts:3470-3498`] | SDK 0.3.x | No | Nothing | Plan windows (`five_hour`, `seven_day`, …) from `/api/oauth/usage`. `rate_limits_available:false` when the profile scope is missing |
| SDK `claude_authenticate` → `claude_oauth_callback` / `claude_oauth_wait_for_completion` | **No**. In `sdk.mjs` (`claudeAuthenticate(loginWithClaudeAi)`, `claudeOAuthCallback(code,state)`, `claudeOAuthWaitForCompletion()`), absent from `sdk.d.ts` and the docs. Changelog count: 0 | Present in CLI 2.1.284 / SDK 0.3.241 | No TTY. The browser step stays. The CLI runs with `skipBrowserOpen:true` and returns `{manualUrl, automaticUrl}` [S, bundle] | Same storage as `auth login`, via the session's config dir [S, bundle `GOe(je,{storageV5,credentials})`] | Full login scopes. Completion answers `{account:{email, organization, subscriptionType, tokenSource, apiKeySource, apiProvider}}` [S, bundle] |
| SDK `getOAuthToken` option (host supplies the token on `oauth_token_refresh`) | **No**. The option is in `sdk.mjs`, absent from `sdk.d.ts` | SDK 0.3.241 | No | Nothing. The host owns the token | Would give "one writer per Compte" by construction, but it only exists for a host that already holds tokens, which is the policy-blocked path [I] |

## Other facts the map needs

- **Browser opener** [S, bundle `Jo`/`m`]:
  - The order is: `vd()?.browser`, then `$BROWSER`, then `xdg-open`.
  - On Linux with no `DISPLAY` and no `WAYLAND_DISPLAY` it returns `no_display`.
  - `$BROWSER` is a documented Unix convention, but the CLI's use of it is not in the Claude Code docs [I].
- **Automatic vs manual URL** [S, bundle `W6n`]:
  - The automatic URL uses `redirect_uri=http://localhost:<port>/callback`.
  - The manual URL uses `MANUAL_REDIRECT_URL`, which shows a code to paste.
  - `auth login` prints the manual URL and opens the automatic one.
- **Enterprise knobs** [S, authentication]:
  - `forceLoginMethod` and `forceLoginOrgUUID` are enforced by `auth login` and by `claude_authenticate` (`EAe`).
  - `setup-token` honours only `forceLoginMethod`.
- **Refresh concurrency** (input for the "one writer per Compte" rule) [S, changelog]:
  - 2.1.81 fixed concurrent sessions re-authenticating after one refreshed.
  - 2.1.126 fixed a concurrent credential write clearing a valid refresh token.
  - 2.1.117 made refresh reactive on 401.
  - The CLI still refreshes in-process in every session that shares a config dir [I].
- **macOS**: the Keychain entry is keyed to `CLAUDE_CONFIG_DIR`, with a `.credentials.json` fallback when the Keychain is locked [S, authentication].

## Implication for #243

- **Near-term protocol:** spawn `claude auth login` with `CLAUDE_CONFIG_DIR=<new Compte dir>` as a plain child with pipes.
  - Capture the URL. Either parse stdout or keep today's `BROWSER` shim, since the automatic URL (localhost callback) only reaches `$BROWSER`.
  - Open that URL in Orchestra's isolated window. The callback lands on the CLI's own listener.
  - Wait for exit 0.
  - Read `claude auth status --json` for the email and plan.
- **Documented surfaces only**, no TUI, no PTY. It stays inside the "unmodified binary, Anthropic's own flow" carve-out [I].
- **Watch item:** the SDK `claude_authenticate` trio would remove the stdout/`$BROWSER` scraping. Adopt it only if it gets documented.

## NOT VERIFIED

- The full `auth login` flow end-to-end: no real login was run, per the safety rule. That includes the exact stdout order and whether the localhost listener survives without a TTY.
- The access-token TTL (about 8 h) and the refresh-token TTL (`refresh_token_expires_in`). Both are server-side.
- Whether a `setup-token` token is rejected by `/api/oauth/usage` in practice. This is inferred from the scope list and the SDK comment, not called.
- Whether `auth logout` revokes the token server-side.
- The version that introduced `setup-token` and `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`: there is no changelog line for either.
- Whether the undocumented SDK auth control requests are stable across versions.
