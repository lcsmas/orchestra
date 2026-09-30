# How the Claude desktop app signs a user in

Research for [#244](https://github.com/lcsmas/orchestra/issues/244) (map [#243](https://github.com/lcsmas/orchestra/issues/243)). 2026-09-30.

**Verdict.** Claude Desktop is an Electron shell around the claude.ai web app. The user signs in on claude.ai's own login page inside the app. External steps (Google, magic link, SSO) run in the system browser and come back through a `claude://` deep link. The result is a claude.ai **cookie session**, not an OAuth login. From that cookie, the app **mints its own OAuth tokens**, with no browser involved, and hands them to Claude Code through `CLAUDE_CODE_OAUTH_TOKEN`. When the CLI gets a 401, the app refreshes the token through an SDK callback. The app is the only writer. The CLI never runs `/login` and never writes `.credentials.json`.

**Key:** **SOURCED** = official doc/page (URL) or the shipped code (file + marker you can grep). **INFERRED** = my reading, not directly observed.

## Sources and method

- Claude Desktop **1.24012.0** (`@ant/desktop`, Electron 42.7.0), official Linux `.deb` payload. On this Fedora host it is extracted rootless into `~/.local/opt/claude-desktop` (launcher `~/.local/bin/claude-desktop --no-sandbox`). Fedora is not a supported distro ([desktop-linux doc](https://code.claude.com/docs/en/desktop-linux)). I extracted `resources/app.asar` into a scratch dir and read it. Minified identifiers are cited as grep markers, and every code claim below is from `.vite/build/index.chunk-Cx0dveeJ.js` unless another file is named.
- Claude Code CLI **2.1.284** (`~/.local/share/claude/versions/2.1.284`): I grepped its strings and ran `auth --help` under a scratch `CLAUDE_CONFIG_DIR`.
- `@anthropic-ai/claude-agent-sdk`: Orchestra's pinned 0.3.216 and the latest npm release, 0.3.285.
- Docs: [authentication](https://code.claude.com/docs/en/authentication), [env-vars](https://code.claude.com/docs/en/env-vars), [desktop-linux](https://code.claude.com/docs/en/desktop-linux), [support: log in](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account), issues [anthropics/claude-code#94884](https://github.com/anthropics/claude-code/issues/94884) and [#62206](https://github.com/anthropics/claude-code/issues/62206).
- **Safety:** I ran no login or OAuth flow, and read no `~/.claude*` credentials.

## 1. Sign-in UI and methods

- **SOURCED.** The Linux app signs in "with a claude.ai subscription, or through your organization's SSO". It does not accept a Console API key ([desktop-linux](https://code.claude.com/docs/en/desktop-linux)).
- **SOURCED.** The claude.ai methods are Continue with Google, and Continue with email. The email method sends a login link, or a code when the link is opened on another device ([support](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)).
- **SOURCED.** The app's main view is a `WebContentsView` that loads claude.ai. The login page is claude.ai's own. There is no native login form: the only login code in the main process is the deep-link handler below (`Nd.Login`, `Or.MagicLink`, `Or.SSOCallback`).

## 2. How control comes back to the app: a custom URL scheme, not a loopback port

- **SOURCED.** The app registers `claude:` through `app.setAsDefaultProtocolClient` (marker `Mfe="claude:"`, `Xer()`). It holds a single-instance lock, so a deep link arrives as `second-instance` argv on the running app. The `.desktop` entry declares `MimeType=x-scheme-handler/claude;`.
- **SOURCED.** The login routes, from the enums `Nd`, `dYe` and `Or`:
  - `claude://login/google-auth?code=…&anon_id=…`: the `code` is posted over IPC (`googleAuthCode`) to the claude.ai page, which finishes the login.
  - `claude://claude.ai/magic-link#<a>:<b>`: the app loads `https://claude.ai/magic-link#<a>:<b>` in its own view.
  - `claude://claude.ai/sso-callback?…`: the app loads `https://claude.ai/sso-callback?…` in its own view.
  - `anon_id` is set as the `_cross_domain_anonymous_id` cookie first. A repeated delivery is dropped (`gQ`, "ignoring repeat delivery of login callback").
- **SOURCED.** Enterprise policy `authentication.disableDeepLinks` unregisters the scheme but still lets these three login routes through.
- **SOURCED.** On the browser side, Google sign-in lands on `claude.ai/login/popup-google-auth`, which says "Finish sign-in in the Claude app" and shows an "Open Claude" button that fires `claude://`. When no handler is registered, sign-in dead-ends. Issue [#94884](https://github.com/anthropics/claude-code/issues/94884) is open, labelled `platform:linux`.
- **INFERRED.** Desktop's own sign-in uses no loopback port and no pasted code. The `runLoopbackPkceFlow` and `127.0.0.1` hits in the bundle belong to other flows (MCP and third-party auth, dev URLs). I did not trace each one.

## 3. Which browser

- **SOURCED.** Google, SSO and the email link finish in the **system default browser**. That is where the "Open Claude" page from #94884 appears, and the email link opens wherever the user clicks it. The result is returned to the app through the deep link.
- **NOT VERIFIED.** The exact call that opens Google or SSO outside the app (a `setWindowOpenHandler` → `shell.openExternal` path, or navigation by the page). I did not trace it.

## 4. Several accounts at once, and switching

- **SOURCED.** The whole session is the claude.ai cookies in Electron's `session.defaultSession`: `sessionKey` plus `lastActiveOrg`. Token minting reads exactly those two cookies (`$in`: "no lastActiveOrg cookie found" / "no sessionKey cookie found").
- **SOURCED.** The only switcher is claude.ai's account selector (click your initials, pick an account). It switches between a personal account and a Team/Enterprise account that share **the same email** ([support](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)). The selected account is the `lastActiveOrg` cookie.
- **INFERRED.** Two different emails cannot be signed in at the same time: there is one cookie jar and no "add account" string in the bundle. Switching email means `/logout` and signing in again (the app watches for `/logout` and `/logout/all-sessions`).
- **SOURCED.** The CLI supports multiple accounts through one `CLAUDE_CONFIG_DIR` per account ([authentication](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts)). That is Orchestra's Compte model today.
- **SOURCED.** The desktop and CLI logins are separate. A request to share them was closed as not planned ([#62206](https://github.com/anthropics/claude-code/issues/62206)).

## 5. Token minting, storage and refresh

- **SOURCED: minting from the cookie, no browser (`$in`).**
  1. `POST {api}/v1/oauth/{lastActiveOrg}/authorize` with `Authorization: Bearer <sessionKey>` and the body `{response_type:"code", client_id, organization_uuid, redirect_uri, scope, state, code_challenge, code_challenge_method:"S256"}`.
  2. It reads `code` from the returned `redirect_uri`.
  3. `POST {api}/v1/oauth/token` with `grant_type:"authorization_code"` and the PKCE verifier.
  - It asks for a custom `expires_in` (`Sin`): 1 year for most scopes, 720 h for `user:sessions:claude_code`. The 720 h figure can be overridden by a GrowthBook flag. If the server rejects the custom value, it retries without it.
  - A 403 is classified either as "session too old for this scope" or "subscription past due".
- **SOURCED: OAuth clients in the bundle (tables `d5`, `mC`, `SD`).**
  - `9d1c250a-e61b-44d9-88ed-5944d1962f5e`: the Claude Code CLI client (the same id is in the CLI binary). Scopes `user:inference user:file_upload user:profile`, plus `user:sessions:claude_code` for Code (`pot`).
  - `a473d7bb-…`: the desktop client.
  - `89355bc3-…`: redirect URI `https://claude.ai/desktop/callback`, scope `user:inference`.
  - All of them are production endpoints under `https://api.anthropic.com`.
- **SOURCED: storage.** The token cache is JSON, encrypted with Electron `safeStorage` (libsecret or kwallet on Linux), stored base64 in the app's store under the key `oauth:tokenCache` (`MU`/`got`). If `safeStorage` is unavailable, the cache is **not persisted** ("tokens will not persist"). The claude.ai cookies live in Electron's own profile.
- **SOURCED: refresh.** The app owns refresh: `grant_type:"refresh_token"` (`Ein`). When the cookie is still valid, it can also mint again.

## 6. How Claude Code inside Desktop gets authenticated

- **SOURCED.** Desktop spawns the CLI through the Agent SDK with the env built by `TG()`: `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, `CLAUDE_CODE_OAUTH_TOKEN=<minted token>`, `CLAUDE_CODE_OAUTH_SCOPES`, `CLAUDE_CODE_SUBSCRIPTION_TYPE`, `CLAUDE_CODE_RATE_LIMIT_TIER`, with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` blanked.
- **SOURCED.** It passes the SDK option `getOAuthToken` (`index.chunk-pq1faw8M.js`: `createGetOAuthToken(...)`, `refreshOAuthTokenForSdk`). When the CLI hits a 401, it sends the control request `oauth_token_refresh`, and the host answers with a fresh access token ("[oauth] CLI requested token refresh after 401"). An identity fence refuses to answer if the signed-in account changed in the meantime.
- **SOURCED.** The public SDK implements this: `sdk.mjs` handles `subtype==="oauth_token_refresh"` by calling `this.getOAuthToken({signal,onDecline})`. The callback exists in the runtime of Orchestra's pinned **0.3.216** and of **0.3.285**. It is **absent from `sdk.d.ts` in both**, so it is undocumented.
- **SOURCED.** The docs agree that Desktop sessions "use OAuth" and do not read `apiKeyHelper`, `ANTHROPIC_*`, or Anthropic profiles ([authentication](https://code.claude.com/docs/en/authentication#credential-management)).
- **INFERRED.** The result is exactly one writer per identity: the host process. The CLI holds only an in-memory access token.

## 7. What the user sees

- **SOURCED.** Email, org and plan are shown by the claude.ai web UI. The host also calls `GET {api}/api/oauth/profile` with a Bearer token (`bin`) and maps `organization.organization_type` to `claude_max`/`claude_pro`/`claude_team`/`claude_enterprise` → max/pro/team/enterprise, plus `organization.rate_limit_tier`.
- **SOURCED.** An expired session is shown in-app. Among the reasons is `auth_expired` ("sign-in has expired").

## 8. The CLI's own sign-in, for contrast

- **SOURCED.** `claude auth login` supports `--claudeai`, `--console`, `--sso` and `--email <email>`. `claude auth status` prints JSON by default (`--json`/`--text`). Both were observed with `--help` on 2.1.284.
- **SOURCED.** Browser → CLI hand-back is a loopback `http://localhost:<port>/callback`. The fallback is a manual redirect to `…/oauth/code/callback` plus "Paste code here if prompted" ([authentication](https://code.claude.com/docs/en/authentication#log-in-to-claude-code); CLI strings).
- **SOURCED.** The CLI has a non-interactive, documented login: with `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` and `CLAUDE_CODE_OAUTH_SCOPES` set, "`claude auth login` exchanges this token directly instead of opening a browser" ([env-vars](https://code.claude.com/docs/en/env-vars)). The binary has "Login from refresh token failed" and `tengu_login_from_refresh_token`.
- **SOURCED.** Credentials are stored in `$CLAUDE_CONFIG_DIR/.credentials.json`, mode 0600, on Linux. `CLAUDE_CODE_OAUTH_TOKEN` ranks above a `/login` credential ([authentication](https://code.claude.com/docs/en/authentication#authentication-precedence)).
- **SOURCED.** CLI 2.1.284 registers its own `claude-cli://` handler (`--handle-uri`, installed here as `claude-code-url-handler.desktop`). It is separate from Desktop's `claude://`.

## What Orchestra could reuse on Linux

| Piece | Reusable? | Note |
|---|---|---|
| Embedded claude.ai login in an isolated Electron session per Compte (`partition: persist:compte-<id>`) | **Yes (INFERRED)** | This is Desktop's model. Orchestra is Electron too, so each Compte gets its own cookie jar and several Comptes can be signed in at once, which Desktop cannot do. |
| `claude://` deep-link return | **No** | The scheme belongs to Desktop. It collides with Claude Desktop when installed, and claude.ai only redirects to `claude://`. An embedded view can catch the callback URL instead (`/sso-callback`, `/magic-link`, and the Google code page), but that is **not verified**. |
| Minting tokens from `sessionKey` via `/v1/oauth/{org}/authorize` | **Technically possible, not a stable protocol** | This is an undocumented first-party endpoint called with the CLI's client id. It fits "Orchestra does the OAuth itself" but not "a protocol we control". It needs a policy decision. |
| Standard PKCE authorize + loopback on the CLI client id, in an embedded window | **Probably (INFERRED)** | This is the flow `claude auth login` already runs (`/oauth/authorize` → `localhost:<port>/callback` → `/v1/oauth/token`). Orchestra would run the same flow without the PTY. It is not documented for third parties. |
| `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `CLAUDE_CODE_OAUTH_SCOPES` → `claude auth login` | **Yes, documented** | This is the official non-interactive CLI surface. It turns any refresh token Orchestra obtained into a normal `.credentials.json` in the Compte's config dir, with no PTY. |
| Host-owned token + `CLAUDE_CODE_OAUTH_TOKEN` env + SDK `getOAuthToken` refresh callback | **Yes for SDK sessions, undocumented** | This gives one writer per Compte (the #243 refresh policy). It exists in Orchestra's pinned SDK runtime but is not typed. PTY sessions get no refresh callback. |
| `GET /api/oauth/profile` for email, plan and org | **Yes** | Orchestra's usage pollers already call Anthropic endpoints with the Compte's token. |

## NOT VERIFIED

- The exact mechanism that opens Google or SSO outside the app (not traced).
- Whether claude.ai's login inside a non-Desktop Electron view falls back to a normal web redirect or insists on `claude://`. This needs a prototype.
- Whether Anthropic accepts third-party use of the CLI client id or the `/v1/oauth/{org}/authorize` endpoint. No policy page was found.
- macOS behaviour (Keychain / `safeStorage` backends). Only the Linux build was read.
- The claude.ai web front-end's own code. Only the Electron main process and preload bundles were read.
