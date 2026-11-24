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

**PASS receipt (#484, `rg_receipt_write` / `rg_receipt_check` / `rg_norm_tree` in `release-gate.sh`).** A full gate PASS writes
`<git-common-dir>/release-gate-receipts/<tree>` (outside the working tree, shared by every worktree; `RELEASE_GATE_RECEIPT_DIR` overrides)
with `gate_version`, `norm_tree`, `raw_tree`, `head`, `version`, `date`. `<tree>` is HEAD's git tree id with **package.json's one top-level
`"version"` line masked** (`rg_norm_tree`: a scratch index + alternate object dir, so no objects are added; no single such line → the raw tree id,
fail closed). `release.sh` calls `rg_receipt_check` before the gate and **skips it** (`release-gate: SKIPPED — PASS receipt: …`; `build:bus-abi`,
bump, build, ship still run) only when ALL hold: no tracked/untracked change (`_rg_tree_dirt`), a receipt exists for HEAD's masked tree, its
`gate_version` == `RG_GATE_VERSION` (bump the constant when the gate's checks change meaning), its stored `norm_tree` equals the file name, and — the
explicit proof — HEAD's tree is the gated tree or differs from it by `package.json` alone (`git diff-tree`, when the gated tree is still in the
object db; the masked-id equality already means "that file's version line only"). Anything else prints the reason and runs the gate; a failed gate
writes nothing; `--skip-release-gate` is unchanged (receipt ignored). The vague's final gate runs **`bash scripts/release-gate.sh`** (standalone: gate
+ receipt, leaves node_modules at node ABI) instead of tsc + suite by hand. Assumption: a bump re-serialises package.json only on the version line
(true for this repo's canonical 2-space file under `pnpm version`; a non-canonical file just misses the receipt). Rig: `pnpm run test:release-receipt`
(scratch repo + FAKE gate stubs, no real suite) and `pnpm run test:release-receipt-mutants` (11 clause mutants must all turn it red; all killed).

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
- **orchestra-spawn / -comms / -rename / -status / -workspace-admin / -browser** — the
  agent capability skills (`orchestra-promote` and the other split-era skills are in `RETIRED_SKILLS`, evicted at install; no promote since #440) also installed per-worktree (see
  [hooks-cli-socket.md](hooks-cli-socket.md)).
- **codebase-map** — this index.

### The bundled `verified-fanout` v2 skill (#470, verified-fanout v2 ledger #471)
Not a file of this repo's `.claude/skills/`: the text is `src/shared/verified-fanout-skill.ts` (`VERIFIED_FANOUT_SKILL`, `¤` = backtick), v1's `references/` (4 files) + `scripts/ledger-set` are
`src/shared/verified-fanout-files.ts` (D8: GENERATED byte-identical from the frozen v1 by `scripts/gen-verified-fanout-files.mjs <skills-v1 dir>`, ledger-set 0755; the same generator also embeds, as `VERIFIED_FANOUT_V2_REFERENCES`, the **6 v2-only
situational references** from their ONE source dir `src/shared/verified-fanout-refs/*.md` — `lead-ops-tiers`, `budget-and-gates`, `fleet-bus`, `verifier-and-review`, `closeout-and-gates`, #474, and `acceptance-tests`, #510; re-run it after editing one, the test reds on a stale embedding). `installVerifiedFanoutSkill(skillsDir)`
(`src/main/verified-fanout-install.ts`, called from `installOrchestraHooks` beside the `orchestra-*` skills; text, v1 files and v2 references are in the `HOOKS_VERSION` hash, so an edit reinstalls once; nothing evicted) writes them to
`<worktree>/.claude/skills/verified-fanout/`. **It never overwrites a repo's own `verified-fanout`**: only a SKILL.md with the generated-marker LINE (`<!-- VERIFIED_FANOUT_MARKER … -->`; an empty one counts as ours) is rewritten, else
`skipped-foreign` and nothing is added beside it; a symlinked skill dir is never written through. SKILL.md is written LAST (a failed reference write never leaves a new SKILL.md pointing at refs that did not land, #474). **It never throws** (an fs error → `skipped-error`, logged): it sits BEFORE the `settings.local.json` merge and the
stamp, so a throw would silently drop every hook (probed: dangling symlink / SKILL.md as a dir / a file at the dir). Writes are tmp+rename.
The text is the frozen v1 (tag `verified-fanout-v1-prose`, never modified) where a rule did not move, and **ONE line per rule that a verb or guard now enforces** (#472): the rule + its verb/guard + what to do on its
refusal (`fanout deliver|state|resume`, `handoff`, the role guard incl. `AskUserQuestion` and the check-then-destructive chain, the `scribe-` role) — v1's prose of such a rule and #470's `In code (v2)` paragraphs are gone, prose stays only
for judgement rules (review stance, gate specification, close-out writing, tone, LEAD/OPS split). Size (rendered text): v1 649 lines / 6,358 words / 40,690 B; #470 v2 753 / 7,536 / 48,213 (+18.5 %); #472 v2 689 / 6,943 / 44,795 (+10.1 %, the new verbs'
lines); **#474 (lever S3): the ALWAYS-READ SKILL.md was 322 lines / 3,962 words / 25,978 B (#476: 3,957, no named scribe jobs: a scribe only for steps needing turns between them) (budget < 4,000 words)** — each moved section left a "read when …" pointer, its long form is a reference (words: lead-ops-tiers 1,495, budget-and-gates 1,085,
verifier-and-review 867, closeout-and-gates 746, fleet-bus 470 = 4,663; v1's 4 refs unchanged). Resident in SKILL.md: every enforced one-liner (#472) + the every-turn judgement rules (`SKILL_RESIDENT` = `RULE_PINS` + `JUDGEMENT_PINS`, read from SKILL.md ALONE);
moved sentences are pinned in their reference (`REFERENCE_PINS`). #495/#497: §0b carries the verifier's full-suite rule (per `orchestra fanout gate`) and the implementer's no-full-suite-in-fix-rounds rule — `fullSuiteConflicts` pins that exactly those two bullets name the suite and do not contradict. `src/shared/verified-fanout-skill.test.ts` pins one phrase per enforced rule (`RULE_PINS`) and per judgement rule (`JUDGEMENT_PINS`; must-FAIL: delete any one rule's line) and the budgets (`wordCount` < 4,000 words — must-FAIL arm over budget; 32,000 B). `docs/evidence/470-v1-vs-v2.diff` is the full-context `diff -u`
(regenerate: `scripts/verified-fanout-v1-vs-v2-diff.mjs <v1 SKILL.md>`).
**#510 (acceptance tests, ledger #511 track B):** SKILL.md §1b « Acceptance tests » (≈170 words) POINTS at the verbs — the coordinator registers the ticket with `state set --spec` and Orchestra spawns the `accept-` writer itself (#515: Opus 5.5 in the fleet role table; D4's manual `--model` spawn line is gone — the test `#515: the skill has NO manual writer spawn line` pins that and resolves `accept-` through `resolveSpawnRoleDefaults`), the writer freezes its own ticket to `acceptance/<run>`, `fanout gate --cwd` / `fanout deliver --acceptance` check bytes, `fanout acceptance amend` needs a ledger decision — and the **routing rule** sits in §1 (an upstream gap is fixed by a follow-up ON the upstream, never by changing the dependent's spec interface); the long form is `references/acceptance-tests.md`. Pins: 4 `RULE_PINS` + 1 `JUDGEMENT_PINS` + 3 `REFERENCE_PINS`; the existing `orchestra <verb> --flag` lint covers every acceptance span against `fanout`'s real help (checked at A's tip 523a0781); the always-read text stayed < 4,000 words by trimming prose no pin names (3,997 words). Mutants: `drop/replace the --model`, rename each verb/flag, drop the routing rule or the pointer, pad past the budget — all red.
**#514:** the merge-rule line now says every MINOR is `noted` (no follow-up PR) and the « ONE follow-up branch » bullet names `state set --finding / --follow-up-of / --fixes`; the code that enforces it is `followUpRefusal` (`hooks-cli-socket.md`). SKILL.md 3,999 words; `docs/evidence/470-v1-vs-v2.diff` regenerated. **#552:** the merge-rule line now reads « 0 BLOCKING, 0 MAJOR and no unsettled spec-sentence MINOR »; the specSentence / `kind: process` / `--settle` / `--decide` text is in `references/verifier-and-review.md` (diff + `verified-fanout-files.ts` regenerated).
**#514:** the merge-rule line now says every MINOR is `noted` (no follow-up PR) and the « ONE follow-up branch » bullet names `state set --finding / --follow-up-of / --fixes`; the code that enforces it is `followUpRefusal` (`hooks-cli-socket.md`). SKILL.md 3,999 words; `docs/evidence/470-v1-vs-v2.diff` regenerated.
**#564:** the `<!--sw preNominationChecks=on-->` block (one bullet in §0b, `orchestra fanout check` before nominating) is present only when that switch is on — the default render is byte-identical. **#554 (switches, ledger D2):** the installed SKILL.md is RENDERED from the run's frozen switches — `VERIFIED_FANOUT_SKILL_TEMPLATE` carries `<!--sw earlyGate=on-->`/`<!--sw acceptance=on-->`/`<!--sw minorPolicy=refuse|spec-->`/`=legacy` blocks (+ the `earlyGate=off` variant: « a dependent waits for its upstream's MERGE »), `renderVerifiedFanoutSkill(switches)` (`renderSwitchBlocks` in `src/shared/fanout-switch-render.ts`) drops a block whole, `VERIFIED_FANOUT_SKILL` = the default render (#559: acceptance off, minorPolicy legacy = the v0.5.375 text — no § 1b, no routing rule, no acceptance reference, the pre-#514 merge sentence; `acceptance=on,minorPolicy=spec` is byte-identical to v0.5.378's render, pinned by sha256 in `fanout-switches.test.ts`, evidence `scripts/diff-fanout-skill-vs-375.mjs`); the installer renders EVERY bundled `.md` the same way (`references/budget-and-gates.md` carries an `earlyGate` pair); with `acceptance` off `references/acceptance-tests.md` is not installed (an earlier copy is removed — `verifiedFanoutReferenceWanted`). `installOrchestraHooks` (`workspaces.ts`) reads the switches with `switchesForRun(orchestraHome(), resolveWaveRunId(ws))` and stamps `.hooks-version` as `HOOKS_VERSION` (+ `+sw:<non-defaults>` only when a switch is off its default: `switchesStamp` — a run that keeps the v0.5.378 defaults is stamped, it re-renders once), so a default run keeps the plain stamp and a switch flip re-renders once; the digest also hashes the TEMPLATE. A child's skill is rendered at ITS session start (the state is frozen before any child exists); the coordinator's own is re-rendered by the host after `state set --switch`. The off-switch sentences are tested ABSENT on the rendered text (`src/cli/fanout-switches.test.ts`).
**#554 (switches, ledger D2):** the installed SKILL.md is RENDERED from the run's frozen switches — `VERIFIED_FANOUT_SKILL_TEMPLATE` carries `<!--sw earlyGate=on-->`/`<!--sw acceptance=on-->`/`<!--sw minorPolicy=refuse|spec-->`/`=legacy` blocks (+ the `earlyGate=off` variant: « a dependent waits for its upstream's MERGE »), `renderVerifiedFanoutSkill(switches)` (`renderSwitchBlocks` in `src/shared/fanout-switch-render.ts`) drops a block whole, `VERIFIED_FANOUT_SKILL` = the default render (#559: acceptance off, minorPolicy legacy = the v0.5.375 text — no § 1b, no routing rule, no acceptance reference, the pre-#514 merge sentence; `acceptance=on,minorPolicy=spec` is byte-identical to v0.5.378's render, pinned by sha256 in `fanout-switches.test.ts`, evidence `scripts/diff-fanout-skill-vs-375.mjs`); the installer renders EVERY bundled `.md` the same way (`references/budget-and-gates.md` carries an `earlyGate` pair); with `acceptance` off `references/acceptance-tests.md` is not installed (an earlier copy is removed — `verifiedFanoutReferenceWanted`). `installOrchestraHooks` (`workspaces.ts`) reads the switches with `switchesForRun(orchestraHome(), resolveWaveRunId(ws))` and stamps `.hooks-version` as `HOOKS_VERSION` (+ `+sw:<non-defaults>` only when a switch is off its default: `switchesStamp` — a run that keeps the v0.5.378 defaults is stamped, it re-renders once), so a default run keeps the plain stamp and a switch flip re-renders once; the digest also hashes the TEMPLATE. A child's skill is rendered at ITS session start (the state is frozen before any child exists); the coordinator's own is re-rendered by the host after `state set --switch`. The off-switch sentences are tested ABSENT on the rendered text (`src/cli/fanout-switches.test.ts`). **#563 `verifier`**: `<!--sw verifier=on-->` / `<!--sw verifier=off-->` pairs in the SKILL template (description, roles, `verif-` prefix, role-guard line, handoff, full-suite + gate bullets, §3 « No gating seat: the CI and the reviewer », §4 bullets, the deliver paragraph, the refs list; §1b has `acceptance=on verifier=on|off` variants — the directive takes several space-separated terms, all must hold) and in four v2 references (`acceptance-tests`, `budget-and-gates`, `lead-ops-tiers`, `verifier-and-review` head); `verifier=on` is byte-identical to master (sha256 pins in `src/cli/fanout-verifier-switch.test.ts`); the off render has no verifier ROLE in SKILL.md or any v2 reference (the file name `verifier-and-review.md` stays; v1's frozen references are untouched). After editing a reference run `node --experimental-strip-types scripts/gen-verified-fanout-files.mjs`.
**#476:** SKILL.md (was 3,985 words) names the four `scribe-` jobs the coordinator must delegate (ledger writes, `state set` relays, CI polling, close-out sweep greps) + the handoff lever; the severity scale moved to `references/verifier-and-review.md`. The measurement that picked the lever: `scripts/vf2-trial/cache-split.mjs` (per-role/workspace/model token split of the trial transcripts; OPS 35% of cache-read).
- **Precedence (D3, MEASURED on Claude Code 2.1.325 only).** `scripts/skill-precedence/measure-skill-precedence.mjs` (a MANUAL rig, not in `pnpm test`: re-run it after a CLI update; the real CLI against the
  local fake API, scratch HOME + config dir, positive controls personal-only / project-only, then both; 3 runs, same verdict, `docs/evidence/470-skill-precedence.jsonl`; the `claude` on PATH): with a personal
  `<config dir>/skills/verified-fanout` AND the worktree's `.claude/skills/verified-fanout`, the **personal one is listed and loaded; the worktree one is not**. So v2 applies on a machine with NO personal
  copy (the benchmark VPS) and, on that CLI, does not shadow a personal v1.
- **VPS install.** Install an Orchestra AppImage release that contains this change (a release is the owner's call, ledger D5); any worktree install (a spawn) writes the skill. No personal
  `verified-fanout` there ⇒ nothing shadows it. To make v2 load on a machine that has a personal copy, move the personal copy aside (never done by the app).
- Tests: `src/shared/verified-fanout-skill.test.ts` — every `orchestra <verb> [sub] [--flag]` span of the text must exist in `COMMANDS` (flags scoped to the sub-verb's usage; must-FAIL: fake verb, the deleted
  `orchestra link`, fake sub-verb, sibling/near-miss flag), the "Roles are typed" claims vs `roleSpec()` (`roleClaimDrift`, 4 must-FAIL), `RULE_PINS` + `JUDGEMENT_PINS` (one pin per enforced / judgement rule, must-FAIL per rule) + the size budget, the diff artifact rebuilds BOTH sides (v2 == the module, v1 == sha256 of the
  frozen file), each shipped v1 file's sha256 == the frozen v1's `SHA256SUMS` (must-FAIL: one byte, a dropped/stray file), the v2 references == their source dir byte-for-byte (`v2Drift`: stale embedding / missing / stray / v1-name collision / mode), every `references/x.md` pointer of SKILL.md and of the references reaches a shipped file and every new reference has a "read when/before" trigger (`pointerProblems`, 5 must-FAIL), the CLI-verb lint and the role-guard claims also run over the references, the `workspaces.ts` wiring pin (import / call / both hashed / not in `RETIRED_SKILLS`, each with a
  must-FAIL), `installVerifiedFanoutSkill` on scratch dirs (fresh, marked-old rewrite + exec bit restored, a repo's own unmarked / marker-quoting skill untouched, symlinks, the 3 error shapes, an empty SKILL.md, a throwing reporter); `src/shared/verified-fanout-skill-guard.test.ts` (the guard-SCRIPT claims of "Roles are typed" — 56 allow/deny probes through master's real `role-guard.sh` via `HOOK_ROLE_GUARD_CMD`, must-FAIL: chain rule / all Bash rules removed, always-allow script), and the REAL `installOrchestraHooks` through
  `scripts/e2e-verified-fanout-skill-install.mjs` (lands + files, rewritten on a spawn after an upgrade, `orchestra-*` untouched, a same-version install is a no-op, a repo's own skill kept, and the 3 fs-error shapes still leave `settings.local.json` + the stamp written — the unfixed installer fails all 3).

## Storage / .gitignore
Build outputs (`dist/`, `dist-electron/`, `release/`, `.vite/`), `node_modules/`,
`*.log`, and user `.claude/*` (except `skills/`) and `.planning/` are ignored.
`pnpm-lock.yaml` is the dependency source of truth.

## Packaged-run proof for #431 (prep, #442)
- `scripts/build-pre-update-fixture.mjs --out <dir under $TMPDIR>` — synthetic pre-update `ORCHESTRA_HOME` (run-less plain tree, LEAD→OPS→workers fleet, a delivery-OFF vague with unread mail, `default`-run short-recipient rows), written by MASTER's own `Store` + `bus.ts` (`git archive <base>` of `src/`, refuses a base carrying ADR 0012); `MANIFEST.json` = the shape the "before" arm must see.
- `scripts/pre-update-fixture-census.mjs` — readonly census of which workspace has a run (`ownRun` / `inRun`), shared by the builder and the rig.
- `scripts/e2e-packaged-run-proof.sh --exe <AppImage|binary> --arm before|after|fleet` — packaged app on that fixture inside `e2e-contained-rig.sh`'s second headless sway; `before` on master MUST show run-less workspaces, `after`'s mail clause is filled by the final #442 run. Evidence: `docs/evidence/431/`.
