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
- `pnpm run build` — `vite build && pnpm run build:cli && electron-builder`.
- `pnpm run build:cli` — CLI only.
- `pnpm run start` — `electron .` (runs the built `dist-electron/main.js`).
- `pnpm run lint` — `eslint src --ext .ts,.tsx`.
- `pnpm run test` — `node --test --experimental-strip-types 'src/**/*.test.ts'`
  (built-in runner; no Jest/Vitest). Current tests: `events-spool`,
  `git-merge-state`, `orchestra-hook`, `accounts`, `linear`.
- `pnpm` `onlyBuiltDependencies: [electron, node-pty]` — always rebuilt on install
  (native bindings differ per platform/arch). After install, run
  `pnpm exec electron-rebuild` for node-pty against Electron's ABI.

## Release — scripts/release.sh (~265 lines)
**Worktree-safe** (never checks out master). Invoke via
`pnpm run release [patch|minor|major|X.Y.Z] [flags]`.

Preflight (fails before any mutation): `gh auth status`; not detached HEAD;
clean tree; branch not behind `origin/<branch>`; for `--to-master`, that
`origin/master` fast-forwards to HEAD; for `--install`, resolvable destination.

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
Triggers on `push` tag `v*` (or manual `workflow_dispatch` with a tag). Build
matrix: `ubuntu-latest`→x64, `ubuntu-24.04-arm`→arm64. Each: checkout the tag,
pnpm + Node 20, `apt install build-essential libfuse2`, `pnpm install
--frozen-lockfile`, `electron-rebuild`, `vite build && electron-builder --publish
never`, rename to `Orchestra-<arch>.AppImage`, upload artifact. Publish job
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
