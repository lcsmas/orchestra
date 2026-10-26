# Ship the `claude` CLI inside the Orchestra AppImage?

Question (Lucas, 2026-10-25): « est-ce qu'il ne serait pas mieux de shipper le CLI claude dans
l'app image d'orchestra ? » — should Orchestra run a `claude` it bundles instead of the one
installed on the host?

**Decision (2026-10-25): option A** — keep the host CLI only, prune the SDK binaries (plus
better-sqlite3 sources and unused Chromium locales) from the package, and fail a session start
with a clear "not found on PATH" error. The fallback (option B) was dropped: login, voice and
self-tune need a host `claude` anyway.

Date: 2026-10-25. Host: Fedora 42 Asahi, `6.19.14-400.asahi.fc42.aarch64+16k`. Code read at
`276cd058` (0 commits behind `origin/master`). Installed app: v0.5.352
(`~/Applications/orchestra/release/Orchestra.AppImage`).

Tags: **VERIFIED** = read or measured in this session. **INFERRED** = my reasoning from verified
facts. **UNVERIFIED** = not checked.

## Answer

1. **Orchestra ALREADY ships the CLI. It just never runs it.** The installed AppImage carries
   `claude` 2.1.241 twice (glibc + musl, 340 MB + 333 MB unpacked, executable) in
   `resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64{,-musl}/`
   (VERIFIED). They come from the SDK's per-platform optional dependencies. Compressed the same way
   as the AppImage (zstd, 128 KiB blocks), they take about **180 MB of the 298 MB AppImage**
   (VERIFIED, measured). Every session runs the host's `claude` from PATH instead. On this host that
   is 2.1.310 (VERIFIED).
2. **Switching to the bundled binary as-is would crash detached sessions.** A `claude` started from
   the AppImage FUSE mount died with **SIGBUS (`Bus error`, exit 135)** on its next request once the
   mount was gone (VERIFIED, experiment below). The mount goes away when the app quits or is
   replaced, and keeper sessions are built to outlive both. Anthropic documents the same failure:
   "A running session reads parts of the Claude Code executable from disk as it works … the session
   crashes. On Linux, your shell reports this as a `Bus error`"
   ([setup § network storage](https://code.claude.com/docs/en/setup#install-on-network-storage)).
   The keeper already works around this for itself by copying `keeper.js` out of the mount
   (`src/main/keeper-client.ts:18-20`). A bundled CLI would need the same copy-out: 340 MB per
   version.
3. **Pinning the CLI would undo a deliberate design.** The model picker follows the `claude` on PATH
   so that "New models therefore appear without an Orchestra release"
   (`docs/codebase-map/structured-agent-view.md:1882-1890`). Anthropic warns that "A newly launched
   model can require a Claude Code version newer than the stable channel serves"
   ([setup § release channel](https://code.claude.com/docs/en/setup#configure-release-channel)).
   The SDK pin, 0.3.241, is **69 patch releases** behind npm `latest` (0.3.310 / CLI 2.1.310,
   VERIFIED `npm view`). A bundled CLI moves only when Orchestra bumps the SDK and ships.
4. **The terms allow it, with conditions Orchestra already meets.** Bundling needs the Commercial
   Terms, an **unmodified binary** with every built-in sign-in method intact, and **each end user on
   their own credentials** ([legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)).
   The public GitHub releases already ship these binaries (VERIFIED for arm64, INFERRED for x64).
5. **Recommendation: keep the host CLI as the default.** Add a bundled **fallback**, used only when
   no `claude` is on PATH, and copy it out of the mount before use (option B below). Two cheap fixes
   apply whatever is decided: drop the musl copy (about 89 MB compressed, never runnable here), and
   repair the fallback, which is broken today (the asar path gives ENOTDIR). Bundling as the
   **default** (option C) is worth it only if reproducibility matters more than getting new models
   on day one, and only with copy-out plus a user override.

## 1. Current state (VERIFIED)

- **How the binary is found.** `resolveClaudeBinary(env)` walks the session env's `PATH` for an
  executable `claude` (`src/main/agent-sdk.ts:645-661`). The result goes in as
  `pathToClaudeCodeExecutable` (`:1816`, `:1903`). The comment at `:1808-1815` explains why: the
  SDK's default path resolves inside `app.asar` → `spawn ENOTDIR` in the packaged app. That was
  fixed in `8d979b08 fix(agent-view): packaged-app SDK spawn (ENOTDIR)`. When no `claude` is on
  PATH, the option is omitted and the SDK default is used. The comment says that default "only
  works outside the packaged asar". **So the packaged app has no working fallback** (INFERRED from
  the comment and the commit; not re-measured).
- **Where PATH comes from.** At boot, `shellEnvSync()` (`$SHELL -ilc env`) is merged into
  `process.env` (`src/main/index.ts:128-157`). `buildSdkEnv` then prepends only the `orchestra`
  shim dir (`agent-sdk.ts:900-902`).
- **Other places that spawn `claude` by name**, all host-dependent:
  - the `/status` auth line (`agent-sdk.ts:3523`, `resolveClaudeBinary(env) ?? 'claude'`);
  - the model-list probe (`:2379-2425`), keyed on `claude --version`, realpath and mtime, so a
    `claude update` is picked up live;
  - voice dictation, bare `spawn('claude', …)` (`src/main/voice.ts:87-91`);
  - self-tune (`src/main/self-tune.ts:41-43`);
  - account login, `claude /login` through the user's login shell in a PTY
    (`src/main/api-handlers.ts:614-680`);
  - the boot dependency check (`src/main/deps.ts:35`), whose hint is
    `npm install -g @anthropic-ai/claude-code` (`:50`).
- **Session keeper.** Local sessions spawn the CLI through the detached keeper, which outlives app
  quit (`agent-sdk.ts:1904-1914`). The keeper runtime is copied to `$ORCHESTRA_HOME/bin/keeper.js`
  "so a live keeper never depends on the app install (asar / AppImage FUSE mount) after quit"
  (`src/main/keeper-client.ts:18-20`, `:473-498`). For the same reason, in an AppImage it prefers a
  PATH `node` (`:502-522`).
- **Sandbox image.** It installs its own `claude` with the official native installer
  (`sandbox/Dockerfile:101-105`). That is independent of the AppImage.
- **Session-budget gate.** It drives the host CLI (`scripts/session-budget/harness.mjs:104-114`,
  `findOnPath('claude')`). So the release gate certifies whatever CLI the releaser has, not the one
  users run.
- **The SDK already bundles the CLI.** `@anthropic-ai/claude-agent-sdk@0.3.241`
  (`package.json:149`) declares 8 `optionalDependencies` `…-{linux,darwin,win32}-{x64,arm64}[-musl]`
  and `"claudeCodeVersion": "2.1.241"` (its `package.json`). `sdk.mjs` resolves the default with
  `createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk-linux-<arch>[-musl]/claude")`,
  glibc first on a glibc host. Otherwise it throws "Native CLI binary for … not found … or set
  options.pathToClaudeCodeExecutable" (minified `kB()` / `$Ie()` in `sdk.mjs`). The docs agree:
  "The SDK bundles a native Claude Code binary for your platform as an optional dependency … Most
  installs need no separate Claude Code install"
  ([agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript)).
- **Versions.** Repo `node_modules/…-linux-arm64/claude --version` → `2.1.241`. Host
  `which -a claude` → `~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.310` (native
  installer) → `2.1.310`. npm `latest`: SDK `0.3.310`, `claude-code` `2.1.310` (`stable` `2.1.308`).
- **Packaging.** electron-builder `files` lists only `dist/**`, `dist-electron/**`
  (`package.json:174-178`). It still auto-ships the externalized SDK (`vite.config.ts:38-45`;
  `docs/spikes/phase0-sdk-findings.md` Q1). Explicit `asarUnpack` covers only the
  better-sqlite3/node-pty `.node` files (`package.json:204-207`), yet both `claude` binaries land
  in `app.asar.unpacked` with `+x` (observed on the live mount). CI builds x64 on `ubuntu-latest`
  and arm64 on `ubuntu-24.04-arm` natively (`.github/workflows/release.yml:19-28`), so each runner
  installs its own platform package (INFERRED). Release v0.5.352 assets: arm64 298.4 MB, x64
  301.5 MB (`gh release view`).

## 2. Version coupling

- **The SDK states the rule:** "The SDK version tracks the bundled Claude Code version. SDK
  v0.3.191 bundles Claude Code v2.1.191, so a feature … that requires a Claude Code version needs
  the SDK release with the same patch number or later"
  ([agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript)). Some fields need
  a minimum CLI: `claude_code_version` needs 2.1.296, `verbatimPrompts` needs 2.1.248 (same page).
- **Orchestra runs with skew today.** SDK 0.3.241 drives CLI 2.1.310, 69 patches newer. The code
  tolerates skew both ways:
  - `applyFlagSettings` failure → "An older installed `claude` CLI may not know
    apply_flag_settings" (`agent-sdk.ts:4399`);
  - `tool_result_meta` is a "RUNTIME SUPERSET" absent from `sdk.d.ts` 0.3.241 and present in CLI
    2.1.241 (`structured-agent-view.md:1440-1442`);
  - the stale-runtime helpers (`src/shared/cli-runtime.ts:1-4`, `isRuntimeStale`,
    `runtimeServesLikeCurrent`);
  - model aliases change meaning across CLI patches, e.g. "2.1.278 maps `opus[1m]` to Opus 5,
    2.1.280 to Opus 5.5" (`structured-agent-view.md:1889`).
- **Behaviour already pinned to CLI versions:**
  - the daemon /loop invisibility (CLI ≥ 2.1.233, `activity-pty-terminal.md:288`);
  - `.claude.json` lock-dir writes measured on 2.1.284 (`accounts-usage.md:133`);
  - the tool heartbeat measured on 2.1.291 (`docs/research/302-liveness-definitive-probes.md:43`).

  Every one of these is a fact about a CLI version Orchestra does not control. A bundled CLI would
  turn each into a pinned, release-gated fact (INFERRED).

## 3. Mechanics of bundling

- **Already done by default.** No new electron-builder config is needed to *carry* the binary
  (observed above). What is missing is *using* it: pass
  `path.join(process.resourcesPath, 'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-linux-<arch>/claude')`
  as `pathToClaudeCodeExecutable` (INFERRED). The SDK's own `require.resolve` default points inside
  `app.asar` (per the `:1808-1815` comment).
- **Size.** Unpacked: glibc 339,794,152 B, musl 332,939,032 B (`ls -l`). As zstd squashfs, 128 KiB
  blocks (the AppImage's own parameters, `unsquashfs -s`): glibc alone 90.8 MB, both 179.6 MB, out
  of a 297.2 MB squashfs. The musl copy cannot run here: executing it → "no such file or directory",
  the missing `/lib/ld-musl-*` loader that the SDK's own error text names. The SDK docs suggest
  deleting the non-matching libc package. electron-builder could exclude
  `**/claude-agent-sdk-linux-*-musl/**` (INFERRED; Electron itself is glibc-linked, UNVERIFIED).
  npm `0.3.310` `linux-arm64` unpacked size is 291.5 MB, smaller than 0.3.241's.
- **16k pages.** The binary's `PT_LOAD` alignment is `0x10000` (64 KiB; `readelf -lW`), and it runs
  on this 16k kernel (`--version` OK). So no page-size blocker on Asahi.
- **Read-only mount, and SIGBUS once it is gone** (experiment, VERIFIED):
  1. `Orchestra.AppImage --appimage-mount` gives a private mount.
  2. The bundled `claude mcp serve` was started from it under `env -i` with a scratch
     `HOME`/`CLAUDE_CONFIG_DIR`. It answered `initialize` (id 1).
  3. The mount process was killed. `/proc/mounts` no longer listed the mount, and the positive
     control `head` on the binary failed ("cannot open").
  4. After `tools/list` was sent, the process died with `Bus error (core dumped)`, exit 135, Bun
     crash banner, and never answered id 2.

  Script and scratch dirs: `$TMPDIR/mountexp/run.sh`, scratch removed.

  An AppImage's runtime unmounts when the app exits. That covers app quit, the update relaunch, and
  the `.AppImage` being replaced (INFERRED from the AppImage model and from `keeper-client.ts:502-504`
  "the mount vanishes at quit"). So any keeper session on a mount-resident CLI dies at the next
  quit/update. **A bundled CLI must be copied to `$ORCHESTRA_HOME/bin/claude-<version>`**, each
  version in its own file and never overwritten in place, as the setup doc prescribes ("Keep each
  version in its own directory … Delete an old version only when no machine can still be running
  it"). Old versions are garbage-collected only when no keeper's `/proc/<pid>/exe` points at them
  (INFERRED design).
- **Self-update.** Native installs "automatically update in the background", and the launcher is a
  symlink `~/.local/bin/claude` → `~/.local/share/claude/versions/` (setup § auto-updates). That is
  exactly why the host path survives updates: a running keeper keeps its own version file, and the
  installer keeps "any version a session on the same machine is running"
  (setup § network storage). A bundled copy should run with `DISABLE_UPDATES=1`: "Use this when you
  distribute Claude Code through your own channels and need users to stay on the version you
  provide" (setup § disable auto-updates). `DISABLE_AUTOUPDATER` alone does not block
  `claude update`. Both names appear in the SDK's env allow-list (`sdk.mjs`). What a mount-resident
  copy's updater actually does on a read-only mount: UNVERIFIED.

## 4. Licensing / terms (quoted)

- **The binary's own `LICENSE.md`** (`…-linux-arm64/LICENSE.md`, the same text in the SDK): "© Anthropic
  PBC. All rights reserved. Use is subject to the Legal Agreements outlined here:
  https://code.claude.com/docs/en/legal-and-compliance." `package.json`: `"license": "SEE LICENSE
  IN LICENSE.md"`. Not an open-source licence.
- **[legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance), "Can customers
  offer Claude Code in their products?":**
  > "Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products
  > or services … requires agreeing to our Commercial Terms of Service and complying with the
  > conditions below: **The Claude Code binary must not be modified.** Claude Code must be installed
  > and run as published by Anthropic, and customers may not remove, disable, or restrict any
  > authentication method built into it … **Customers may not pay for, resell, or intermediate
  > Claude usage on their end users' behalf.** Each end user must authenticate with their own
  > Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential"
- **The same page, on authentication:**
  > "Anthropic does not permit third-party developers to offer Claude.ai login into their own
  > applications … developers may not collect, store, or intermediate Claude.ai credentials or
  > session tokens — sign-in to a Claude account must complete through Anthropic's own flow … Nor
  > does it prevent an end user from signing in to the unmodified Claude Code binary with their own
  > Claude subscription"
- **Reading (INFERRED, not legal advice).** Shipping the unmodified binary is allowed under these
  conditions, and Orchestra already does it publicly (GitHub releases of a public repo).
  Bundling-vs-host does not change the licence posture. Orchestra's account login runs the CLI's
  own `/login` and redirects its browser-open into an isolated surface (`api-handlers.ts:645-659`).
  That is the part to keep checking against "Anthropic's own flow", whichever binary runs.
  Branding: only "runs Claude Code" in plain text.

## 5. Tradeoffs

| Axis | Host CLI (today) | Bundled CLI |
|---|---|---|
| Reproducibility / release gate | The CLI each user runs is unknown. The session-budget gate tests the releaser's CLI. | Exact CLI tested = CLI shipped. The pin is visible in `package.json`. |
| New models / features / fixes | Same day (native auto-update). The picker follows PATH by design. | Lags until an SDK bump plus an Orchestra release. Already 69 patches behind. |
| Security fixes | Anthropic's channel. | Orchestra's release cadence becomes the patch SLA. |
| Users who want another version | Free choice (channel, `minimumVersion`). | Needs an override setting, or PATH first. |
| Detached keeper across app quit/update | Safe: the version file stays on disk. | SIGBUS unless copied out of the mount (VERIFIED). |
| First run without `claude` installed | Blocking dep check, and the SDK fallback is broken (ENOTDIR). | Works out of the box. |
| `~/.claude` / account dirs | Shared with the user's own interactive `claude`, same version. | Shared too, but two CLI versions write the same config/transcripts (`.claude.json` lock protocol measured on 2.1.284). Skew risk, UNVERIFIED in practice. |
| AppImage size | Already pays ~180 MB for unused binaries. | Same size, now used. Drop musl → about −89 MB. |
| Other spawners (voice, self-tune, login, `/status`) | All on PATH. | Each must be switched to the resolver, or behaviour splits between two CLIs. |

## 6. Options

- **A. Keep the host CLI only, and stop paying for the dead binary.** Exclude
  `claude-agent-sdk-*` platform packages from the build; the AppImage gets about 180 MB lighter.
  - Requires that no code path needs the SDK default. Today that holds only when `claude` is on
    PATH.
  - Keep the dep check blocking.
- **B. Host CLI first, bundled fallback (recommended).** `resolveClaudeBinary` returns the PATH
  `claude`, else a copy of the bundled binary at `$ORCHESTRA_HOME/bin/claude-<ver>`. The copy is
  made like `installKeeper`, per version, `DISABLE_UPDATES=1`. Ship glibc only.
  - Requires: the copy-out (the SIGBUS finding); every spawner using the one resolver (voice,
    self-tune and login use bare `claude` today); a first-run copy of 340 MB in `$ORCHESTRA_HOME`.
  - Keeps same-day models for everyone with a host install. Users without one get a working app.
- **C. Bundled by default plus a "use host claude" setting.** Gives reproducible releases, and the
  session-budget gate can then drive the bundled binary.
  - Requires everything in B, plus SDK bumps on Anthropic's cadence (or the lag is accepted).
  - The model picker's "follows PATH" design (`sdkListModels`) must be re-pointed at the selected
    binary.
- **D. Use the SDK's default resolution directly.** Not viable in the AppImage. It resolves inside
  `app.asar` (ENOTDIR), and even with the `.unpacked` path it lives on the mount (SIGBUS after
  quit).

## VERIFIED

- Installed AppImage ships `claude` 2.1.241 glibc (339,794,152 B, +x) and musl (332,939,032 B):
  `find /tmp/.mount_OrcheseiigiE/resources/app.asar.unpacked/node_modules/@anthropic-ai -exec ls -lad {} \;`
  and `<glibc>/claude --version` → `2.1.241 (Claude Code)`.
- Mounted app is 990 MB uncompressed; AppImage file is 298,456,545 B; squashfs is zstd with 128 KiB
  blocks: `du -sh $MNT`, `ls -l`, `unsquashfs -s -o $(… --appimage-offset)`.
- The two binaries compress to 179.6 MB (glibc alone 90.8 MB) with the same zstd/128K settings:
  `mksquashfs … -comp zstd -b 131072`.
- Host CLI is 2.1.310 through the native-installer symlink: `which -a claude; readlink -f; claude --version`.
- npm `latest`: SDK 0.3.310 (claudeCodeVersion 2.1.310), claude-code 2.1.310 / stable 2.1.308:
  `npm view … dist-tags`.
- SDK 0.3.241 optional deps, `claudeCodeVersion` 2.1.241, licence text:
  `cat node_modules/@anthropic-ai/claude-agent-sdk/package.json LICENSE.md`.
- SDK default resolution = `require.resolve` of the platform package, glibc first, plus the
  "Native CLI binary … not found" error: Python search of `sdk.mjs` (`kB`, `$Ie`).
- Orchestra resolves `claude` from PATH, passes `pathToClaudeCodeExecutable`, and has the ENOTDIR
  comment: `agent-sdk.ts:645-661,1808-1816,1903`; commit `8d979b08`.
- The keeper copies itself out of the mount, for the stated reason: `keeper-client.ts:18-20,473-522`.
- A `claude` run from an AppImage mount dies with SIGBUS (exit 135) after the mount goes away,
  with a positive control that the file became unreadable: `$TMPDIR/mountexp/run.sh` (output
  quoted in §3).
- Musl binary does not execute on this host: `exec` → "no such file or directory".
- 16k pages: `PT_LOAD` alignment 0x10000 and `--version` runs: `readelf -lW`.
- Legal, setup and SDK doc quotes: WebFetch of code.claude.com `legal-and-compliance`, `setup`,
  `agent-sdk/typescript` (first 100k chars).
- Public repo with public AppImage releases ~298–301 MB: `gh repo view`,
  `gh release view v0.5.352 --json assets`.
- CI builds each arch on a native runner: `.github/workflows/release.yml:19-28`.
- Other spawners use bare/PATH `claude`: `voice.ts:87-91`, `self-tune.ts:41-43`,
  `api-handlers.ts:655-659`, `deps.ts:35`.

## NOT VERIFIED

- That the packaged app's SDK-default fallback still fails with ENOTDIR today. I relied on the code
  comment and commit `8d979b08`; I did not launch a packaged app without `claude` on PATH.
- That the x64 AppImage contains the `linux-x64` binary. Inferred from the asset size and the
  native-runner matrix; not unpacked.
- What the bundled CLI's auto-updater does when run from a read-only mount or under the SDK
  entrypoint (`CLAUDE_CODE_ENTRYPOINT=sdk-ts`).
- That two CLI versions sharing one `~/.claude` (host interactive plus bundled agent) actually
  conflict. This is a risk, not an observation.
- That the AppImage unmounts on in-app update relaunch exactly as in my `--appimage-mount` kill.
  Inferred from the AppImage runtime model and the keeper comment, not reproduced with the real
  update path.
- That excluding the musl package from electron-builder leaves the app working (Electron being
  glibc-only is assumed).
- The legal reading in §4. It is a plain reading of Anthropic's published text, not legal advice.
  The Commercial Terms page itself was not read; only the Claude Code legal page that points to it.
- The rest of the SDK TypeScript reference beyond the first 100k chars (it may hold further
  version notes).
