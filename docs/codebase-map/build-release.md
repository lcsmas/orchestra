# Build system, release pipeline & tooling

Files: `package.json`, `vite.config.ts`, `vite.cli.config.ts`, `tsconfig.json`,
`index.html`, `scripts/release.sh`, `.github/workflows/release.yml`,
`.claude/skills/`.

## Two builds, one binary
The same artifact is both the GUI and the CLI (`<app> cli …`).

- **`vite.config.ts`** — main + preload + renderer via `vite-plugin-electron/simple`.
  Outputs `dist/` (React SPA, entry `index.html`→`src/renderer/main.tsx`),
  `dist-electron/main.js` (CJS, externals: electron, node-pty, simple-git),
  `dist-electron/preload.js`. Alias `@shared → src/shared`.
- **`vite.cli.config.ts`** — standalone CLI (`src/cli/index.ts` → `dist-electron/cli.js`).
  `target: node18`, `minify:false`, `emptyOutDir:false` (shares the dir with the
  main build — don't clobber main.js/preload.js). **Node built-ins kept external**
  (`/^node:/` + bare forms) or Vite's browser default would stub them as `{}` and
  crash at runtime. Shebang injected via Rollup **output banner**
  (`#!/usr/bin/env node`), not source. `resolve.conditions:['node']`.
- **electron-builder** (config in `package.json`): `appId dev.orchestra.app`,
  bundles `dist/**` + `dist-electron/**` → `release/`. Targets: Linux **AppImage**
  (`Orchestra.AppImage`), macOS **dmg**, Windows **nsis**.
  **Pruned from the package** (`build.files` negations + `electronLanguages`): the
  SDK's per-platform `claude` binaries (`@anthropic-ai/claude-agent-sdk-*`, ~670 MB
  unpacked, never run — sessions use the host `claude`, see `agent-sdk.ts`
  `resolveClaudeBinary`), better-sqlite3's compile sources/intermediates, and every
  Chromium locale but `en-US`/`fr`. AppImage 298 → 102 MB. Rationale:
  `docs/research/bundle-claude-cli.md`.
- **App icon**: source of truth is `build/icon.svg` (the "conductor's fan" mark —
  root node splitting into four lanes ending in dots). `build/icon.png` (512², a
  raster of the same SVG) feeds electron-builder via `linux.icon`. Copies in
  `public/` land in `dist/` at build time: `dist/icon.svg` is the favicon
  (`index.html`), `dist/icon.png` the runtime `BrowserWindow` icon (set in
  `src/main/index.ts` `createMainWindow`, guarded by `existsSync` since dev runs
  may predate any build). Regenerate the PNGs from the SVG with `@resvg/resvg-js`
  if the mark changes, and keep `build/` and `public/` in sync. Launchers (rofi
  etc.) resolve the desktop entry's `Icon=orchestra` via the XDG icon theme, not
  the AppImage — `release.sh --install` copies the icon into
  `~/.local/share/icons/hicolor/{512x512,scalable}/apps/`.

`tsconfig.json`: ES2022, `module:ESNext`, `moduleResolution:bundler`,
`jsx:react-jsx`, `strict`, `@shared/*` path. **Excludes `src/**/*.test.ts`** (tests
use explicit `.ts` imports for Node's loader, which conflicts with bundler
resolution).

## Commands (package.json scripts)
- `pnpm run dev` — `ORCHESTRA_HOME=$HOME/.orchestra-dev vite` (isolated dev data,
  HMR + Electron).
- `pnpm run build` — `pnpm run build:bundles && electron-builder`.
- `pnpm run build:bundles` — every JS bundle the package needs, in one place:
  `vite build && pnpm run build:cli && pnpm run build:keeper`. **CI calls this
  same script** — the list of bundles is never restated, because a CI build that
  inlined only `vite build` shipped every AppImage up to v0.5.221 without
  `keeper.js` (structured sessions then died with `connect ENOENT
  …/keepers/<wsId>.sock`).
- `pnpm run build:cli` — CLI only.
- `pnpm run build:keeper` — detached session keeper only (`dist-electron/keeper.js`,
  see `session-keeper.md`).
- `pnpm run start` — `electron .` (runs the built `dist-electron/main.js`).
- `pnpm run lint` — `eslint src --ext .ts,.tsx`.
- `pnpm run test` — `node --test --experimental-strip-types 'src/**/*.test.ts'`
  (built-in runner; no Jest/Vitest). Current tests: `events-spool`,
  `git-merge-state`, `orchestra-hook`, `accounts`, `linear`.
- `pnpm` `onlyBuiltDependencies: [electron, node-pty]` — always rebuilt on install
  (native bindings differ per platform/arch). After install, run
  `pnpm exec electron-rebuild` for node-pty against Electron's ABI.
- `pnpm run test:gates` — **the compositor-dependent gate aggregate**
  (`scripts/run-gates.sh`, issue #80). Runs the two fail-closed E2E gates #76
  (PR #79) shipped runnable-but-uninvoked: `test:rig-selftest`
  (`scripts/run-rig-selftest.sh` — boots its own headless sway, so called
  DIRECTLY) and `test:cli-pipe` (run THROUGH `scripts/e2e-contained-rig.sh`,
  which exports `RIG_WAYLAND`; a bare invocation exits `rc=3`). It is
  **deliberately NOT in `pnpm run test`**: both need a live compositor, and a
  compositor-dependent test in the headless suite would self-skip → a false
  green (the wave-6 shape). **Fail-closed and never papered over with
  `|| true`/`continue-on-error`** (`run-gates.sh:20,45-58`): the aggregate rc is
  the STRONGEST outcome — `1` (a gate ran red) dominates `2`
  (`PRECONDITION-UNMET`, no compositor → surfaced as "not exercised", NEVER
  green) dominates `0` (all exercised+green). See the `raise()` severity ladder
  (`run-gates.sh:39-49`).
  - **A full `/tmp` is a PROVISION precondition, not a red (issue #80, F1).** A
    disk-full mount makes the contained rig's disk-guard exit `DISK_FULL_EXIT=17`,
    which would otherwise score as an investigate-the-code failure (`rc=1`). An
    up-front preflight (`run-gates.sh`, same `disk-guard.cjs --preset e2e-rig
    /tmp` the rig uses) catches it BEFORE either gate and exits `rc=2` (`disk full
    → provision the box`), so it can't be masked as a red; gate 2 keeps a
    `ORCHESTRA_DISK_FULL`-marker re-check for a mid-run fill.
  - **DECISION ON RECORD (issue #80's three valid answers): gate it in the
    release/verifier flow, NOT a CI job.** The repo's only GitHub Actions
    workflow (`.github/workflows/release.yml`) is release-only (triggers on `v*`
    tag push / `workflow_dispatch`) with no compositor and no test/PR job — there
    is nowhere in existing CI to wire a compositor gate. So the enforcement is the
    fleet model: the build-verifier runs `pnpm run test:gates` and the release
    checklist names it. Provisioning sway in CI and a scheduled runner were the
    two alternatives; both were rejected because no verification-CI surface exists
    to attach to.
  - **PATH trap (issue #80, T80.3):** the no-compositor `rc=2` reproduces only
    with a FULLY usable PATH minus the compositor binaries. A hand-stripped PATH
    that also drops `grep`/`uname` breaks the wrapper's OWN toolchain and
    fabricates a spurious "produced NO outcome line" `rc=1` — the exact PATH trap
    #76 carried. The aggregate inherits the invoker's PATH; the contained rig sets
    its own `PATH=/usr/local/bin:/usr/bin:/bin` for the Electron child.

## Pinned Node bundled for the keepers (#390, spec #388)

The package ships a pinned Node (linux arm64 + x64) as `resources/pinned-node/{node,manifest.json}`; the runtime side (copy-out, pick, versioned dir) is in
`session-keeper.md` § Pinned Node runtime. Build side, all under `scripts/pinned-node/`:

- **`pins.json`** — the pin: Node **22.23.4** (LTS Jod), per arch the tarball name + `tarballSha256` (the `linux-<arch>.tar.gz` lines of the release's
  `SHASUMS256.txt`, whose `.asc` was GPG-verified 2026-10-25) + `nodeSha256`/`nodeBytes` of the `bin/node` inside. `lib.cjs` `loadPins` refuses any malformed pin.
  **Bumping Node** = edit this file (version, tarball names, the six hashes), `pnpm run test:pinned-node` (its `pins_match_upstream` arm re-checks the tarball
  hashes against nodejs.org), rebuild.
- **`before-pack.cjs`** (electron-builder `beforePack`, linux only) → `lib.cjs` `prepareRuntime`: tarball cached in `build/pinned-node/.cache` (gitignored; **re-hashed on
  every use**, a poisoned cache is deleted and re-fetched), downloaded to a `.part` file and hashed BEFORE extraction, `tar` extracts only `bin/node`, the binary is hashed
  against `nodeSha256`, written with `manifest.json` to `build/pinned-node/<arch>/` by atomic rename. Offline + no cache = the build fails (never a silent skip).
- **`package.json` `build.linux.extraResources`** `build/pinned-node/${arch}` → `resources/pinned-node`. electron-builder SKIPS a missing `from` silently — that is
  why the next step re-verifies what actually landed.
- **`pack-check.cjs`** (called at the end of `scripts/after-pack-check.cjs`'s `afterPack`; linux only) → `checkPackedRuntime`: the packaged `node` exists, is a regular
  executable, has the pinned size and SHA-256, its `manifest.json` agrees with the pin, then **`smoke.cjs` `smokeKeeper`** — the runtime executes and reports the
  pinned version, STARTS the packaged `keeper.js` (read out of `app.asar`), answers a `hello`, relays a child's stdio (`spawn` → echo → `kill`), and
  `/proc/<keeper>/exe` is that very runtime (an exec-proxy wrapper fails). Any failure throws → electron-builder fails → `pnpm run build` fails → `release.sh`
  stops before tag/publish (and the CI build job goes red — CI runs the same hooks via `electron-builder`). A pack for the OTHER arch than the host is
  **refused** (cannot be executed) unless `ORCHESTRA_PINNED_NODE_ALLOW_CROSS=1`, which ships it hash-verified but UNSMOKED and says so.
- **Gates**: `pnpm run test:pinned-node` (28 arms: fetch/hash must-FAILs, packaged-runtime must-FAILs incl. corrupted byte / truncated / non-exec / manifest / cross-arch,
  smoke-has-teeth arms with the hash gate neutralised, launcher arms) · `pnpm run test:pinned-node-mutants` · `pnpm run test:pinned-node-pack` (the REAL
  electron-builder `--linux dir` chain under `flock $PKG_LOCK`: good pack passes; corrupted runtime and missing runtime FAIL the pack; with the `packCheck` call
  removed the corrupted runtime ships) · `pnpm run test:pinned-node-app` (built AppImage, see `session-keeper.md`). The AppImage grows by ~40 MB (measured 339 MB vs 298–304 MB for sibling builds of the same tree family; node is 28 MB xz / 44 MB gzip).

## Cookie-encryption fuse (#407) — measured, NOT flipped (ADR 0010, `browser-panel.md` § At rest)

- **State of the shipped binary:** `EnableCookieEncryption` is **disabled** (Electron 33.4.11; `package.json` `build` has no `electronFuses`). It is read from the packaged
  `release/linux-arm64-unpacked/orchestra` by `scripts/lib/fuse-wire.cjs` `parseFuseWire` (CommonJS so `afterPack` and the `.mjs` rigs share it; pure, never throws, refuses a missing /
  duplicated sentinel, an unknown version or a garbage state byte; `src/shared/fuse-wire.test.ts`), cross-checked against `@electron/fuses` `getCurrentFuseWire`. The wire is `sentinel
  dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX · version · length · one byte per fuse ('0' disabled, '1' enabled)`.
- **Where a flip + its check must live:** electron-builder 26.15.3 runs the app's `afterPack` hook BEFORE its own `electronFuses` flip (`app-builder-lib/out/platformPackager.js`:
  `emitAfterPack` … `doAddElectronFuses` — "the fuses MUST be flipped right before signing"), so an `afterPack` wire check can never see an `electronFuses` flip. A flip and the
  check that proves it both belong in `afterPack`, through `context.packager.addElectronFuses(context, { version: '1', 1: true })` (index 1 = `EnableCookieEncryption`) and a re-read.
- **Release step (#407 phase 2):** `afterPack` (`scripts/after-pack-check.cjs`, linux) calls `scripts/lib/cookie-fuse-pack.cjs` `ensureCookieFuse(context, COOKIE_ENCRYPTION_FUSE_SHIPPED, <appOutDir>/orchestra)`:
  it flips the fuse through `context.packager.addElectronFuses` iff the policy `scripts/lib/cookie-fuse-policy.cjs` says so, then reads the binary's wire back (`fuse-wire.cjs` `expectCookieFuse`) and
  THROWS — the release fails — when the wire disagrees (or cannot be read). The policy is `true` on the HELD flip commit (the release then ships the fuse ON; proven through the real hook: `executing @electron/fuses` → wire enabled, byte-diff 1 vs the stock build) and `false` before it (the check then guards "fuse OFF ⇒ the at-rest warning is unconditional"). Must-FAIL arms on scratch copies of a
  real packaged binary: `pnpm run test:cookie-fuse-check` (`scripts/verify-cookie-fuse-check.mjs`: stock passes, a scratch build flipped ON fails, a flip that lands passes, a flip that silently does nothing fails, an
  unreadable wire fails closed). The flip is that one-line change of the policy constant, held for the maintainer's OK (ADR 0010).
- **Rig:** `scripts/e2e-cookie-fuse.sh <unpacked-dir>` (never touches the source tree; copies the unpacked app twice under `E2E_RIG_BASE`, default `/var/tmp/c407-<uid>`), driver
  `scripts/e2e-cookie-fuse.mjs`, flip helper `scripts/lib/flip-cookie-fuse.cjs` (resolves `@electron/fuses` THROUGH electron-builder: it is not a direct dependency). Needs the packaged
  build (`pnpm run build:bus-abi && rm -rf dist-electron && flock /var/tmp/orch-1000-b17728/pkg-388.lock pnpm run build`), MemAvailable ≥ 8 GB, `gnome-keyring-daemon`, `dbus-run-session`,
  `bwrap`, `sway`; runs behind the GUI-slot semaphore. Evidence `docs/evidence/407-cookie-fuse.jsonl` (+ `.verdict.txt`), must-FAIL build `docs/evidence/407-cookie-fuse-mutant-on-is-off.jsonl`.

## Release — scripts/release.sh (~265 lines)
**Worktree-safe** (never checks out master). Invoke via
`pnpm run release [patch|minor|major|X.Y.Z] [flags]`.

Preflight (fails before any mutation; the #207 gate below is the last of them): `gh auth status`; not detached HEAD;
clean tree; branch not behind `origin/<branch>`; for `--to-master`, that
`origin/master` fast-forwards to HEAD; for `--install`, resolvable destination.

**Tag-vs-master preflight (issue #78, the `rp_two_way_discriminator` call in `release.sh`, after the version is
computed and before the bump).** The bare `git rev-parse "$TAG"` check
(the `git rev-parse "$TAG"` check) only sees the LOCAL tag namespace; the "3rd race shape" (stale
`package.json` version + an ORIGIN tag that does not contain the work being
released) fired on v0.5.257/260/261. `release.sh` `git fetch origin master --tags`
(FAILS CLOSED on a non-dry-run fetch failure — a no-network release can't push a
tag, and skipping the guard is how the 3rd shape shipped; `--dry-run` tolerates
offline), then sources `scripts/release-preflight.sh` and calls:
- `rp_two_way_discriminator <newest-origin-tag> HEAD` — compares against **HEAD**,
  the ref `pnpm version` tags, NOT `origin/master` (review F1: `ship --to-master`
  advances `origin/master` to HEAD only later, so at preflight time it still equals
  the newest tag → comparing against it would false-refuse every real release).
  Resolves the newest tag by **version sort** (`sort -V`, not ls-remote's
  alphabetical order), runs both `tag..HEAD` and `HEAD..tag`:
  - HEAD adds 0 → rc 3, `tag already contains this ref → refuse to cut a duplicate`
  - tag diverged (`HEAD..tag` nonzero) → rc 6, `DIVERGED tag → refuse` (review F2:
    the tag carries commits HEAD lacks; shipping HEAD would orphan them)
  - clean superset (ahead>0, behind==0) → rc 0, `ahead by N commits → shipping them`
  - range uncomputable → rc 4, fail closed
- `rp_next_version_free <tag>` — the chosen `NEW` tag must be absent from BOTH
  `git ls-remote --tags` AND `gh release list` (the v0.5.253 race took the number
  between the two reads); rc 5 if taken.

Both functions read every external surface through injectable `RP_*` env seams so
`scripts/verify-release-preflight.sh` (`pnpm run test:release-preflight`) can
exercise all arms — the duplicate/diverged/instrument-error refuse arms, the F1
vs-master-would-false-refuse vs vs-HEAD-proceeds pair, the F3 fetch-fail arm that
drives the real `release.sh` in a temp repo with an unreachable origin, a
**call-site arm** that drives the real `release.sh --dry-run` in a temp repo where
`origin/master`==tag but HEAD is ahead (asserts it PROCEEDS on HEAD; the must-FAIL
control mutates the call site HEAD→origin/master and requires it to REFUSE — so
the arm depends on the shipped call site's ref, not just the library), and a
mutation of the refuse condition — with stubbed ls-remote/gh, never driving a real
release. The preflight is read-only, so it runs under `--dry-run` too.

**Release gate (issue #207, `scripts/release-gate.sh`, sourced by `release.sh`).**
Runs after every cheap preflight and BEFORE the first mutation (`--to-master`
push, bump, tag), once per release: tree == HEAD (tracked files unchanged after a
`git update-index --refresh`, **no untracked non-ignored files** — a tag carries
neither) → `npx tsc --noEmit` → `pnpm run test` → `pnpm run test:session-budget` → `pnpm run test:admission-hold` → `pnpm run test:admission-wake`
(#208, `session-budget.md`: rc 0 **and** the `SESSION-BUDGET: PASS` terminator, rc 3 =
VOID; refusal names check `session-budget`; opt-in `RELEASE_REAL_API_SMOKE_CONFIG_DIR=<account
config dir>` adds a sixth step, one real cheap-model turn, check `real-api-smoke`; **#287 follow-up:**
the two Admission rigs — `scripts/e2e-admission-{hold,wake}.mjs`, ~17 s each, real modules + a fake memory source — are
gates 4/5 and 5/5, judged by `rg_judge_admission_rig`: rc 0 **and** the driver's `<label> ALL PASS (N/N) tree <path>` terminator
with N==N>0 naming THIS tree, run with `RIG_ARMS`/`RIG_REPO` unset (a `RIG_ARMS` subset prints `PARTIAL(RIG_ARMS)` and is refused;
refusals name `admission-hold` / `admission-wake`). Concurrent rig drivers are isolated: per-run scratch `<base>/<runId>/<arm>` and
every arm under ONE host-wide `flock` on `~/.cache/e2e-admission-rigs.lock` (`scripts/rig-isolation.mjs`; the mutant sweep keeps a private backup dir) → the
same tree check again → (local build only) `pnpm run build:bus-abi`. The test step reads node's summary
(`# tests|pass|fail|cancelled|skipped|todo`, TAP or spec) and refuses on rc≠0,
any fail/cancelled, **any skipped or todo**, zero tests, `tests != pass`, or a
summary missing `tests|pass|fail|skipped` (fails closed). Refusals are
`release-gate: REFUSED — check '<tsc|test|session-budget|admission-hold|admission-wake|real-api-smoke|tree|build:bus-abi>' failed: …`, rc 1.
Order is the native-module order: the suite leaves better-sqlite3 on node ABI 127,
the package needs Electron's 130 (`bus.md` ABI section) — `build:bus-abi` runs
after the suite and before `pnpm run build`, and is not a check, so it also runs
under the bypass. The gate also runs under `--ci-only` (which just skips
`build:bus-abi`, the build and `gh release create`). **Escape hatch:**
`--skip-release-gate "<reason>"` (reason mandatory, not `patch|minor|major|X.Y.Z`,
not with `--ci-only`) prints a `release-gate: BYPASSED` banner, appends a
`## ⚠ Release gate bypassed` section (reason, tree, date) to a COPY of the notes
handed to `gh release create` (`--notes-file`, or alongside `--generate-notes`),
and stamps `[release gate bypassed: <reason>]` on the bump commit and tag message.
`--dry-run` prints the plan and runs nothing. **Accepted gap:** a hand-pushed
`v*` tag or `workflow_dispatch` still builds ungated in CI (outside the release
path). `scripts/verify-release-gate.sh` (`pnpm run test:release-gate`) drives the
real `release.sh` in a sandbox (local bare origin, fake `gh`, real tsc/`node
--test`, stub build scripts) across the refusal/bypass/order/once/`--to-master`/
`--ci-only` arms; nothing real is tagged or pushed.

Then: compute version → (if `--to-master`) `git push origin HEAD:master` →
`pnpm version` (bump+commit+tag) → (unless `--ci-only`) `pnpm run build` +
validate AppImage → (if `--install`) **atomic** cp-to-temp, the version sidecar
`<AppImage>.version` = `<version> <inode> <size>` of the tmp file (a rename keeps the inode; the running app's
« Nouvelle version installée » banner reads it — `src/shared/app-update.ts`), then `mv` over the
launcher's AppImage → `git push --follow-tags` → (if `--to-master`) push master
again → (unless `--ci-only`) `gh release create $TAG` with the local AppImage
and `--notes-file` (or `--generate-notes`). `--dry-run` prints every step.

Flags: `--to-master` (land on master via ff push), `--install` (swap local
launcher AppImage; dest from `$ORCHESTRA_INSTALL_PATH` or the
`orchestra.desktop` `Exec=` line), `--ci-only` (skip local build/release; let CI
do it), `--notes-file`. On build failure it prints the undo
(`git tag -d $TAG && git reset --hard HEAD~1`).

## CI — .github/workflows/release.yml (~90 lines)
**This is the ONLY workflow file — a release BUILDER, not a verification CI**
(issue #80, T80.0): it triggers on `push` tag `v*` / `workflow_dispatch`, so
nothing runs on a push or PR, and its ubuntu runners have no compositor. That is
why the compositor gates (`pnpm run test:gates`, above) are wired into the
verifier/release flow, not a CI job — there is no test-CI surface to attach to.
Triggers on `push` tag `v*` (or manual `workflow_dispatch` with a tag). Build
matrix: `ubuntu-latest`→x64, `ubuntu-24.04-arm`→arm64. Each: checkout the tag,
pnpm + Node 20, `apt install build-essential libfuse2`, `pnpm install
--frozen-lockfile`, `electron-rebuild`, `pnpm run build:bundles` then `pnpm exec
electron-builder --publish never`, rename to `Orchestra-<arch>.AppImage`, upload
artifact. Two non-obvious constraints on that build step, both learned by
shipping breakage:
- It calls the shared `build:bundles` script rather than restating the bundle
  list — the inlined `vite build` it used to run silently omitted the CLI and
  keeper bundles from every published AppImage.
- electron-builder is invoked via `pnpm exec`, NOT `pnpm run build -- --publish
  never`: `pnpm run <script> -- <args>` forwards the `--` itself, so argv
  becomes `["--","--publish","never"]`, the parser reads the separator as a
  positional and leaves `publish` undefined — the exact condition that turns on
  implicit publishing (`app-builder-lib` `PublishManager.js`: git tag first,
  then CI detection), which then aborts with "GitHub Personal Access Token is
  not set". The build job only uploads artifacts; publishing is the `publish`
  job's role.

Publish job
(`needs: build`, only on real tags) downloads both and attaches them to the
release via `softprops/action-gh-release` — **appends** to a release the local
`pnpm run release` already created, or creates one in `--ci-only` mode.

## Bundled skills (.claude/skills/, version-controlled)
`.gitignore` ignores `.claude/*` but **un-ignores** `.claude/skills/` so these
ship with the repo:
- **ship** — drives `release.sh` (rebase → evidence check → notes → `release
  patch --to-master --install`). It checks that `verify` evidence (UI drive,
  idle CPU) exists for the diff rather than producing it.
- **orchestra-spawn / -comms / -repos / -promote / -attach / -rename** — the
  agent capability skills also installed per-worktree (see
  [hooks-cli-socket.md](hooks-cli-socket.md)).
- **codebase-map** — this index.

## Storage / .gitignore
Build outputs (`dist/`, `dist-electron/`, `release/`, `.vite/`), `node_modules/`,
`*.log`, and user `.claude/*` (except `skills/`) and `.planning/` are ignored.
`pnpm-lock.yaml` is the dependency source of truth.
