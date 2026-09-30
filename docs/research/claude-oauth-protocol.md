# Claude Code's claude.ai OAuth protocol, and refresh-token rotation

Research for [#246](https://github.com/lcsmas/orchestra/issues/246), part of map [#243](https://github.com/lcsmas/orchestra/issues/243). 2026-09-30.

## Verdict

- **Protocol:** a public OAuth 2.0 authorization-code client with PKCE (S256). The redirect is either an ephemeral loopback port (`http://localhost:<port>/callback`) or Anthropic's manual-code page. The token endpoint takes JSON bodies. Every value below is hard-coded in the CLI bundle. **SOURCED**
- **Rotation: yes, in practice. Treat refresh tokens as single-use.** The 2.1.284 CLI is written around rotation. It holds a cross-process refresh lock per config dir, saves with a compare-and-swap keyed on the refresh token it posted, and marks the posted token dead on `invalid_grant`. Its design-token path revokes a *new, different* refresh token that it could not persist. Several upstream issues report that a concurrent refresh logs out every sibling. Anthropic documents none of this. The wire behaviour is **INFERRED**, with strong evidence. Whether reusing a consumed refresh token revokes the whole token family (RFC 9700 reuse detection) is **UNKNOWN**.
- **Consequence for #243:** two refreshers on one Compte can break each other *unless* both take the same lock under the same config dir, i.e. `<configDir>/.oauth_refresh.lock`. "One writer per Compte" is required, and it has to be the CLI's own lock, or no Orchestra-side refresh at all.
- **ToS: high risk for Orchestra running OAuth itself with Claude Code's `client_id`.** Anthropic's Claude Code legal page says "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications … developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow". The same page allows "an end user … signing in to the unmodified Claude Code binary with their own Claude subscription". **SOURCED**
- **An official non-interactive surface exists:** `claude auth login [--claudeai|--console] [--email] [--sso]`, `claude auth status --json` and `claude auth logout`. It runs Anthropic's flow itself: it prints the URL, listens on loopback and accepts a pasted `code#state` on stdin. **SOURCED** (CLI help and bundle). Whether it fits Orchestra without a PTY is for a sibling ticket; see the last section.

## Sources and method

- Installed CLI `claude --version` → `2.1.284 (Claude Code)`. `readlink -f $(which claude)` → `/home/lmas/.local/share/claude/versions/2.1.284`, a Bun-compiled ELF, aarch64. The JS was read in place with Python `find`/`seek`. Citations below are **byte offsets into that binary** (`@N`) and will drift with every CLI version.
- `claude auth --help` and `claude auth login --help` were run with a scratch `CLAUDE_CONFIG_DIR`.
- Agent SDK `@anthropic-ai/claude-agent-sdk@0.3.216` (`sdk.d.ts`). It exposes `accountInfo()` (`AccountInfo.subscriptionType`, `tokenSource`) but no login or refresh API.
- Official docs: <https://code.claude.com/docs/en/authentication> and <https://code.claude.com/docs/en/legal-and-compliance>, fetched 2026-09-30.
- Upstream issues, read with `gh issue view -R anthropics/claude-code`: [#25609](https://github.com/anthropics/claude-code/issues/25609), [#54443](https://github.com/anthropics/claude-code/issues/54443), [#88583](https://github.com/anthropics/claude-code/issues/88583), [#91708](https://github.com/anthropics/claude-code/issues/91708). A web search also surfaced [#24317](https://github.com/anthropics/claude-code/issues/24317), [#48786](https://github.com/anthropics/claude-code/issues/48786), [#93879](https://github.com/anthropics/claude-code/issues/93879) and [#43801](https://github.com/anthropics/claude-code/issues/43801); their bodies were not read.
- **Safety:** no live `~/.claude*` credential file was read, no token was printed, and no login, refresh or token request was made.

## 1. Endpoints and client (SOURCED, prod config object @197219532)

| Key | Value |
|---|---|
| `CLIENT_ID` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (public client, no secret) |
| `CLAUDE_AI_AUTHORIZE_URL` (subscription login) | `https://claude.com/cai/oauth/authorize` |
| `CONSOLE_AUTHORIZE_URL` (`--console`) | `https://platform.claude.com/oauth/authorize` |
| `TOKEN_URL` | `https://platform.claude.com/v1/oauth/token` |
| Revoke | `${TOKEN_URL}/revoke`, JSON `{token, token_type_hint:"refresh_token", client_id}` (`Jk` @200301901) |
| `MANUAL_REDIRECT_URL` | `https://platform.claude.com/oauth/code/callback` (the page that shows a code to paste) |
| `CLAUDEAI_SUCCESS_URL` | `https://platform.claude.com/oauth/code/success?app=claude-code` (the loopback 302s here after a successful exchange) |
| `ROLES_URL` | `https://api.anthropic.com/api/oauth/claude_cli/roles` |
| `API_KEY_URL` | `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` (Console flow) |
| Profile | `GET https://api.anthropic.com/api/oauth/profile` (`LUe` @200190058) |
| Beta header for OAuth API calls | `oauth-2025-04-20` (constant `Rp`, next to the scopes). Orchestra already sends it (`src/main/account-usage.ts`). |
| Separate client | `DESIGN_CLIENT_ID 59637612-477b-4836-a601-b0589eda7704`, with `user:design:*` scopes and its own `designOauth` slot. Not relevant to Comptes. |

Staging and local configs exist, selected by `CLAUDE_CODE_CUSTOM_OAUTH_URL` / `CLAUDE_LOCAL_OAUTH_*`. The local config uses a different client id and the `-local-oauth` file suffix.

## 2. Authorization request (SOURCED, `W6n` @200297712)

Query parameters, in this order:

1. `code=true`
2. `client_id`
3. `response_type=code`
4. `redirect_uri`
5. `scope`
6. `code_challenge`
7. `code_challenge_method=S256`
8. `state`
9. optional `orgUUID`, `login_hint` (email) and `login_method` (`sso`)

- **PKCE:** the verifier is base64url of 32 random bytes, the challenge is base64url(SHA-256(verifier)), and `state` is base64url of 32 random bytes (`class xN` @216832425).
- **Redirect URIs:**
  - **Automatic:** `http://localhost:<port>/callback`. The listener binds `127.0.0.1` on port `0`, i.e. an ephemeral port (@216828946). Note the host is `localhost` in the URI and `127.0.0.1` in the bind.
  - **Manual:** `https://platform.claude.com/oauth/code/callback`. The page shows `code#state` and the CLI splits it on `#` (@222405084).
- **Dual-URL trick:** the CLI builds *both* URLs from one PKCE pair. It opens the automatic one in the browser and prints the manual one for copy-paste. Whichever code arrives first wins, and the exchange then sends the matching `redirect_uri`.
- **Scopes for a claude.ai login** (`WKr`, next to `CLIENT_ID` @~197219000):
  - `org:create_api_key`
  - `user:profile`
  - `user:inference`
  - `user:sessions:claude_code`
  - `user:mcp_servers`
  - `user:file_upload`
  - `user:plugins`

  `setup-token` / inference-only asks for `user:inference` alone.

## 3. Code exchange and refresh (SOURCED)

- **Exchange** (`aBr` @200298527): `POST TOKEN_URL`, `Content-Type: application/json`, body `{grant_type:"authorization_code", code, redirect_uri, client_id, code_verifier, state[, expires_in]}`. A 401 means an invalid code.
- **Refresh** (`Kce` @200299261): `POST TOKEN_URL`, JSON body `{grant_type:"refresh_token", refresh_token, client_id, scope}`. The scope is the stored scopes minus `org:create_api_key`, plus `user:plugins` and the projects scopes when they were already held. If the server rejects that scope set, the CLI retries once with the stored scopes (`invalid_scope` fallback).
- **Response fields the CLI reads** (`formatTokens` @216834408, `Kce`):
  - `access_token`, `refresh_token`, `expires_in` (seconds), `refresh_token_expires_in` (optional), `scope` (space-separated)
  - `account{uuid,email_address}`, `organization{uuid,name}`, `workspace{id,name}`

  **The email and org come back in the token response itself**, with no extra call.
- On refresh the CLI reads `refresh_token:U=e` (@200299775): **if the response omits `refresh_token`, the old one is kept.** So the client tolerates a non-rotating server. The rotation evidence is in §6.
- **Error classes:**
  - `invalid_grant` on a 400/401 means a dead refresh token (`Vce` @200308643).
  - A structured 400/401/403 body means "account on hold" (`G6n`).

## 4. Profile, plan and org (SOURCED)

- `GET /api/oauth/profile` with `Authorization: Bearer <access>` (@200190058) returns:
  - `account{uuid,email,display_name,full_name,created_at}`
  - `organization{uuid,organization_type,rate_limit_tier,seat_tier,billing_type,has_extra_usage_enabled,subscription_created_at,plan_display_name,cc_onboarding_flags,claude_code_trial_*}`
- Plan mapping (@200303899):

  | `organization_type` | plan |
  |---|---|
  | `claude_max` | `max` |
  | `claude_pro` | `pro` |
  | `claude_team` | `team` |
  | `claude_enterprise` | `enterprise` |

- `GET /api/oauth/claude_cli/roles` (`aUt` @200302318) returns `organization_role`, `workspace_role` and `organization_name`.
- The CLI caches these in `<configDir>/.claude.json` → `oauthAccount`:
  - `accountUuid`, `emailAddress`, `organizationUuid`, `displayName`, `billingType`, `seatTier`, `planDisplayName`, `profileFetchedAt`, …
  - The plan also lands in `.credentials.json` (`subscriptionType`, `rateLimitTier`).

## 5. `.credentials.json` schema and storage (SOURCED)

- **Path:** `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json`, mode `0600` (`xn(…,384)` @199477439; docs §Credential management). On macOS it lives in the Keychain entry keyed to the config dir, with this file as the fallback (docs).
- **`claudeAiOauth` object** (writer `EE` @200252927):
  ```json
  { "claudeAiOauth": {
      "accessToken": "…", "refreshToken": "…", "expiresAt": 0,          // epoch ms
      "refreshTokenExpiresAt": 0,                                       // epoch ms, optional
      "scopes": ["user:inference", "…"],
      "subscriptionType": "max|pro|team|enterprise|null",
      "rateLimitTier": "…|null",
      "clientId": "…"                                                   // only for non-default clients
  } }
  ```
- **Sibling keys** in the same file: `designOauth`, and MCP OAuth entries. Every write is a read-modify-write under a lock (`mutate`), so writers must preserve unknown keys.
- **"Signed out" on-disk state:** after `invalid_grant` the CLI blanks the tokens (`refreshToken:"", accessToken:"", expiresAt:0`) *only if* the stored refresh token is still the dead one (`W3n` @200255953). `refreshToken === ""` is the CLI's own "needs /login" marker (`AE`).
- **Write lock:** `<configDir>/.storage-write`, via proper-lockfile (stale 15 s, 10 retries) around every credential mutation (`vqr` @199475634).

## 6. Lifetimes and the rotation verdict

**Lifetimes**

- **Access token:** about **8 h**. **INFERRED** from user logs: in #88583 a watcher saw "rotation OK" every ~8 h, and #91708 says "8-hour access token". The CLI takes `expires_in` from the server and refreshes when `now + 5 min ≥ expiresAt` (`UL` @200303831). **SOURCED**
- **Refresh token / login:** finite.
  - The docs say: "When the login you created with `/login` is within three days of expiring … `Your login expires in 3 days · run /login to renew`" (CLI string @224948017). **SOURCED**
  - Default when the server omits `refresh_token_expires_in` at login: 30 days (`o0=2592000000` @200297473). **SOURCED**
  - On refresh, a missing value keeps the previous `refreshTokenExpiresAt` (`EE`). **SOURCED**
  - Measured: #88583's credential logged in at 08-17 ~16:00 UTC and showed `refreshTokenExpiresAt` = 2026-09-13 14:56 UTC, i.e. **~27 days**, still unchanged after 8 rotations. #91708 also says "27-day refresh token". **INFERRED:** the refresh-token lifetime is **anchored to the login, not sliding**, so a periodic re-sign-in is unavoidable.
- **`setup-token`:** one-year access token (`expires_in = fY = 31536000` @197218748; docs "one-year OAuth token"), inference-only and not stored. **SOURCED**

**Rotation: YES, INFERRED-strong. Evidence:**

1. **Cross-process refresh lock.** Before refreshing, the CLI takes `<configDir>/.oauth_refresh.lock` (proper-lockfile, stale 60 s, update 5 s, @200266930). For compatibility it also takes a legacy `<realpath(configDir)>.lock`. It then **re-reads the credential under the lock**, and if `accessToken` changed it adopts the sibling's result without refreshing (`Oa` @200269867, `tengu_oauth_token_refresh_race_resolved`). Up to 5 retries with 1–2 s jitter, then dead-holder takeover. **SOURCED**
2. **Compare-and-swap save.** The CLI persists the new pair only if the stored `refreshToken` still equals the one it *posted*. Otherwise it keeps the newer write (`B3n` @200253253, `postedRefreshToken`, `adopted_sibling`). **SOURCED.** This is only needed if a refresh changes the refresh token.
3. **Unused tokens are revoked.** The design-token refresh revokes a **new refresh token that differs from the posted one** when it cannot persist it (`if(e.refreshToken&&e.refreshToken!==s.refreshToken)await Jk(…)` @216838757). It also revokes the fresh token when it loses the CAS race. **SOURCED.** This implies the server issues a new refresh token on refresh.
4. **Dead-token marking.** `invalid_grant` marks the *posted* refresh token dead in memory (`jo`) and blanks it on disk if still current (`W3n`). **SOURCED**
5. **Field reports** of exactly this failure: concurrent sessions on one credential, where the loser gets `invalid_grant`/400 and every session is forced to `/login`. The reporters describe the refresh token as "single-use" or "rotate on use". #88583 (Aug 2026, macOS Keychain, v2.1.229) and #91708 (Sep 2026, Windows file store, v2.1.258) are still open. #25609 (Feb 2026, Linux) is closed. **Reports, not an Anthropic statement.**
6. **Not confirmed by Anthropic:** no official doc says whether a refresh invalidates the old refresh token, or whether reuse revokes the token family. **UNKNOWN**

**What this means for two refreshers on one Compte (INFERRED)**

- **Two CLI processes on the *same* `CLAUDE_CONFIG_DIR` are safe in 2.1.284:** they share the lock, re-read under it, and CAS-save. The open upstream issues describe older engines, the Keychain or the VS Code bundle.
- **Anything that refreshes *outside* that lock breaks the others.** That covers a second config dir holding a *copy* of the same refresh token, and an Orchestra-side refresher that does not take `.oauth_refresh.lock`. One side's refresh consumes the token and the other side's next refresh fails with `invalid_grant`. The CLI then blanks its credential ("signed out"), and with family revocation both sides could lose the login.
- **Rules that follow:**
  - Never duplicate a Compte's `.credentials.json` into two config dirs.
  - Orchestra should either never refresh, and treat an expired access token as "the next CLI run refreshes it", which is today's behaviour in `account-usage.ts`.
  - Or, if it must refresh, take `<configDir>/.oauth_refresh.lock` with the same proper-lockfile protocol, re-read under the lock and CAS-save. That couples Orchestra to a private CLI protocol (see §7).

## 7. Terms-of-service and stability risk

**Terms of service (SOURCED, <https://code.claude.com/docs/en/legal-and-compliance> §Authentication and credential use)**

- OAuth is "intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications".
- Developers building products "should use API key authentication".
- "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."
- "developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
- Allowed: "an end user signing in to the unmodified Claude Code binary with their own Claude subscription".
- "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
- Consumer Terms apply to Free/Pro/Max, Commercial Terms to Team/Enterprise/API (same page). The Consumer Terms text itself was not read.

**Reading for Orchestra (INFERRED, not legal advice)**

- **Orchestra implementing the authorize/token exchange itself with Claude Code's `client_id`** is the pattern the page prohibits: a third-party app offering Claude.ai login and storing the tokens.
- Orchestra is a personal tool running the unmodified CLI for its own user, which is closer to the allowed case. That is only true **as long as the CLI performs the sign-in**, via `claude auth login` or `/login`.
- Anthropic says it enforces without notice. Enforcement against third-party clients reusing the Claude Code OAuth client has been publicly reported, but not verified here.

**Stability (SOURCED facts, INFERRED risk)**

- Nothing in this protocol is a documented API. The endpoints, the `client_id`, the scope list and the lock protocol are hard-coded constants that have already moved: the authorize host is now `claude.com/cai/…` and the token host is `platform.claude.com`.
- A new scope was added behind a flag (`PLUGINS_SCOPE_REGISTERED`), and the refresh path already carries an `invalid_scope` fallback for it.
- A self-implemented client would silently drift from each CLI release. A client that delegates to `claude auth login` would not.

## 8. The official CLI surface (SOURCED, context for the sibling tickets)

- `claude auth login` (@222405084):
  - Prints `Opening browser to sign in…` and `If the browser didn't open, visit: <manual URL>`.
  - Opens the loopback URL in the browser.
  - Reads `code#state` lines from **stdin**; no TTY is required for the paste path.
  - Writes the credentials and prints `Login successful.`, exit 0.
- It also accepts `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `CLAUDE_CODE_OAUTH_SCOPES` (optionally `CLAUDE_CODE_OAUTH_CLIENT_ID`) to log in from an existing refresh token without a browser (@222405615). That is an official import path, and it would itself consume that refresh token (§6).
- `claude auth status --json` and `claude auth logout` exist per `claude auth --help`. Their output schema was not captured.
- The SDK offers no login; it only reports `accountInfo()`.

## Not verified

- Any live wire behaviour: whether refresh returns a new `refresh_token`, whether the old one dies immediately or after a grace period, and whether reuse revokes the token family. No token requests were made, by design.
- The 8 h access-token lifetime and the ~27-day login lifetime come from third-party user logs, not from Anthropic.
- Whether `https://claude.com/cai/oauth/authorize` accepts redirect URIs other than `localhost:<any port>/callback` and the manual page, e.g. a custom scheme or a fixed port.
- `claude auth status --json` output and whether `claude auth login` opens the browser via `xdg-open`/`BROWSER` in a way Orchestra can intercept.
- macOS Keychain specifics beyond the docs.
- The text of the Consumer Terms, and any enforcement history against third-party OAuth clients.
