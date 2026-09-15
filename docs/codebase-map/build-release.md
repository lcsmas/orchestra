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

## Release — scripts/release.sh (~265 lines)
**Worktree-safe** (never checks out master). Invoke via
`pnpm run release [patch|minor|major|X.Y.Z] [flags]`.

Preflight (fails before any mutation): `gh auth status`; not detached HEAD;
clean tree; branch not behind `origin/<branch>`; for `--to-master`, that
`origin/master` fast-forwards to HEAD; for `--install`, resolvable destination.

**Tag-vs-master preflight (issue #78, `release.sh:310`, after the version is
computed and before the bump).** The bare `git rev-parse "$TAG"` check
(`release.sh:296`) only sees the LOCAL tag namespace; the "3rd race shape" (stale
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

Then: compute version → (if `--to-master`) `git push origin HEAD:master` →
`pnpm version` (bump+commit+tag) → (unless `--ci-only`) `pnpm run build` +
validate AppImage → (if `--install`) **atomic** cp-to-temp + `mv` over the
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
- **ship** — drives `release.sh` (rebase → notes → `release patch --to-master
  --install`). See the `/ship` skill for the full sequence.
- **orchestra-spawn / -comms / -repos / -promote / -attach / -rename** — the
  agent capability skills also installed per-worktree (see
  [hooks-cli-socket.md](hooks-cli-socket.md)).
- **codebase-map** — this index.

## Storage / .gitignore
Build outputs (`dist/`, `dist-electron/`, `release/`, `.vite/`), `node_modules/`,
`*.log`, and user `.claude/*` (except `skills/`) and `.planning/` are ignored.
`pnpm-lock.yaml` is the dependency source of truth.
