# Codebase Structure

**Analysis Date:** 2026-04-21

## Directory Layout

```
orchestra/
├── src/
│   ├── main/               # Electron main process (Node.js)
│   │   ├── index.ts        # IPC handler registration, BrowserWindow creation
│   │   ├── store.ts        # Persistent state (repos, workspaces)
│   │   ├── workspaces.ts   # Workspace lifecycle (create, archive, open)
│   │   ├── git.ts          # Git operations (worktrees, diff, commit, push, PR)
│   │   └── pty.ts          # PTY session multiplexing
│   ├── renderer/           # React UI (runs in Electron renderer process)
│   │   ├── main.tsx        # React root entry point
│   │   ├── App.tsx         # Main App component with view routing
│   │   ├── store.ts        # Zustand state management
│   │   └── components/
│   │       ├── Sidebar.tsx      # Workspace list sidebar
│   │       ├── Terminal.tsx     # xterm + PTY terminal emulator
│   │       ├── DiffView.tsx     # Git diff viewer with Monaco editor
│   │       ├── NewWorkspaceModal.tsx  # Workspace creation form
│   │       └── PRModal.tsx      # Pull request creation workflow
│   ├── preload/            # Electron preload script
│   │   └── index.ts        # Context-isolated IPC bridge
│   ├── shared/             # Shared types and interfaces
│   │   ├── types.ts        # Workspace, DiffFile, RepoEntry, WorkspaceStatus
│   │   └── ipc.ts          # OrchestraAPI interface definition
│   └── styles.css          # (in renderer)
├── dist/                   # Built renderer output (Vite)
├── dist-electron/          # Built main + preload output (Vite)
├── index.html              # HTML entry point (loaded by Electron)
├── vite.config.ts          # Vite + Electron build configuration
├── tsconfig.json           # TypeScript configuration
├── package.json            # Dependencies, build scripts, Electron config
└── README.md               # Project overview
```

## Directory Purposes

**`src/main/`:**
- Purpose: Electron main process code running in Node.js
- Contains: IPC handler implementations, git/worktree management, PTY multiplexing, persistent store
- Key files: `index.ts` (entry), `store.ts` (persistence), `git.ts` (git operations), `pty.ts` (terminal sessions), `workspaces.ts` (workspace lifecycle)
- Compiled to: `dist-electron/main.js`

**`src/renderer/`:**
- Purpose: React-based UI running in Electron renderer process
- Contains: Components, state management (Zustand), terminal emulation, diff viewer, modals
- Key files: `App.tsx` (main component), `store.ts` (state), components in `components/`
- Compiled to: `dist/` directory

**`src/preload/`:**
- Purpose: Bridge between renderer (limited context) and main process IPC
- Contains: Single `index.ts` implementing OrchestraAPI by wrapping ipcRenderer calls
- Security: Exposes only defined API surface via contextBridge; renderer cannot access Node/Electron directly
- Compiled to: `dist-electron/preload.js`

**`src/shared/`:**
- Purpose: Shared type definitions and IPC contract
- Contains: `types.ts` (Workspace, DiffFile, etc.), `ipc.ts` (OrchestraAPI interface)
- Used by: Main process (implementation), renderer (consumption), preload (mapping)
- Pattern: No runtime code; types only

**`dist/`:**
- Purpose: Built renderer output (React/HTML/CSS)
- Generated: By Vite during `npm run build` or `npm run dev`
- Contents: index.html, bundled JS/CSS
- Loaded by: Electron BrowserWindow in production

**`dist-electron/`:**
- Purpose: Built main process and preload script
- Generated: By Vite + vite-plugin-electron during build
- Contents: `main.js` (CommonJS), `preload.js` (CommonJS)
- Referenced by: package.json `main` field and BrowserWindow webPreferences

## Key File Locations

**Entry Points:**

| File | Purpose |
|------|---------|
| `src/main/index.ts` | Electron main process entry; app.whenReady() creates window, registers IPC handlers |
| `src/renderer/main.tsx` | React root; creates React app and mounts to #root |
| `index.html` | HTML document; loads div#root for React, script bundles |

**Configuration:**

| File | Purpose |
|------|---------|
| `vite.config.ts` | Vite build config; defines main/preload/renderer entry points, alias `@shared` |
| `tsconfig.json` | TypeScript compiler options; ES2022 target, path aliases, strict mode |
| `package.json` | Dependencies, build scripts, Electron builder config (AppImage/dmg/nsis targets) |

**Core Logic:**

| File | Purpose |
|------|---------|
| `src/main/store.ts` | Persistent JSON store for repos and workspaces at `~/.orchestra/store.json` |
| `src/main/git.ts` | Git operations: worktree creation, diff detection, commit/push, PR creation via gh CLI |
| `src/main/pty.ts` | PTY session multiplexing; spawns agent CLI, routes I/O between subprocess and renderer |
| `src/main/workspaces.ts` | Workspace lifecycle: creation (git + PTY setup), archival (cleanup) |
| `src/renderer/store.ts` | Zustand store for UI state (repos, workspaces, activeId, view mode) |
| `src/renderer/App.tsx` | Main App component; routing between welcome/terminal/diff views |

**Components:**

| File | Purpose |
|------|---------|
| `src/renderer/components/Sidebar.tsx` | Workspace list sidebar; click to switch active workspace |
| `src/renderer/components/Terminal.tsx` | xterm.js emulator; connects to PTY via IPC |
| `src/renderer/components/DiffView.tsx` | File list + Monaco DiffEditor; polls diff every 4s |
| `src/renderer/components/NewWorkspaceModal.tsx` | Form to create workspace (repo, branch, agent, task) |
| `src/renderer/components/PRModal.tsx` | Multi-stage PR workflow (form → commit → push → create PR) |

**Type Definitions:**

| File | Purpose |
|------|---------|
| `src/shared/types.ts` | Workspace, DiffFile, RepoEntry, CreateWorkspaceInput, WorkspaceStatus |
| `src/shared/ipc.ts` | OrchestraAPI interface; method signatures for all IPC calls |

**IPC Bridge:**

| File | Purpose |
|------|---------|
| `src/preload/index.ts` | Implements OrchestraAPI by mapping renderer calls to ipcRenderer.invoke/on |

## Naming Conventions

**Files:**

- **Main process**: `src/main/*.ts` - module per concern (store, git, pty, workspaces)
- **Components**: `src/renderer/components/*.tsx` - PascalCase; one component per file
- **Utilities**: Located inline in service modules; not extracted to separate `utils/` directory
- **Tests**: Not present in current codebase

**Directories:**

- **`src/main/`** - Main process code
- **`src/renderer/`** - Renderer process code
- **`src/preload/`** - Preload script
- **`src/shared/`** - Shared types
- **`dist/`** - Built renderer (generated)
- **`dist-electron/`** - Built main/preload (generated)

**Functions:**

- **Camel case**: `createWorkspace`, `startPty`, `getDiff`, `commitAll`
- **Async functions**: Named as verbs (not `getDataAsync`; just `getData`)

**Types:**

- **Interfaces**: `PascalCase` prefixed with capital (Workspace, DiffFile, OrchestraAPI)
- **Unions**: `WorkspaceStatus = 'idle' | 'running' | 'waiting' | 'error' | 'stopped'`
- **Shared types**: All in `src/shared/types.ts` for consistency

**IPC Channels:**

- **Namespaced with colon**: `repos:list`, `repos:add`, `workspaces:create`, `pty:start`, `git:diff`
- **Event channels** (sent from main): `pty:data`, `pty:exit`, `workspace:update`, `workspace:removed`

## Where to Add New Code

**New Feature (e.g., workspace pause/resume):**

1. **Main process handler**:
   - Add function to `src/main/workspaces.ts` (e.g., `pauseWorkspace()`)
   - Register IPC handler in `src/main/index.ts` (e.g., `ipcMain.handle('workspaces:pause', ...)`)

2. **API interface**:
   - Add method to `OrchestraAPI` interface in `src/shared/ipc.ts` (e.g., `pauseWorkspace: (id: string) => Promise<void>`)

3. **Preload mapping**:
   - Add invoke call in `src/preload/index.ts` (e.g., `pauseWorkspace: (id) => ipcRenderer.invoke('workspaces:pause', id)`)

4. **Renderer call**:
   - Use `window.orchestra.pauseWorkspace(id)` in Zustand store or component
   - Update Zustand store in `src/renderer/store.ts` to add action (e.g., `pauseWorkspace: async (id) => { ... }`)

5. **UI**:
   - Add button to Sidebar or toolbar to trigger action

**New Component (e.g., workspace settings):**

1. Create `src/renderer/components/SettingsModal.tsx` with component logic
2. Add modal state to `App.tsx` (showSettings flag, close handler)
3. Call IPC methods via `window.orchestra.*()` for any server operations
4. Import and render conditionally in `App.tsx`

**New Git Operation (e.g., rebase):**

1. Add function to `src/main/git.ts` (e.g., `rebaseWorkspace(worktreePath, ontoCommit)`)
2. Register IPC handler in `src/main/index.ts`
3. Add to `OrchestraAPI` interface in `src/shared/ipc.ts`
4. Map in `src/preload/index.ts`
5. Call from component or store

**New Utility/Helper:**

- Keep utilities in the same file where they're used (no separate `utils/` directory)
- If shared across multiple modules, add to bottom of `src/main/git.ts` or extract to new module in `src/main/`
- Avoid adding to `src/shared/` unless it must be shared with renderer (prefer main-process-only)

## Special Directories

**`~/.orchestra/worktrees/`:**
- Purpose: Root directory for all git worktrees created by Orchestra
- Generated: By `ensureRoot()` in `src/main/workspaces.ts`
- Committed: No (local runtime only)
- Contents: Named like `{repoName}-{safeBranch}-{shortUUID}` (e.g., `orchestra-feat-my-feature-a1b2c3d4`)

**`~/.orchestra/store.json`:**
- Purpose: Persistent JSON store for repos and workspaces
- Generated: By `Store.save()` in `src/main/store.ts`
- Committed: No (user-local data)
- Format: `{ repos: RepoEntry[], workspaces: Workspace[] }`

**`.vite/` and `node_modules/`:**
- Purpose: Build artifacts and dependencies
- Generated: Yes
- Committed: No (in .gitignore)

## Build & Output

**Vite config** (`vite.config.ts`):
- Defines three separate builds:
  1. **Main process**: Entry `src/main/index.ts` → `dist-electron/main.js`
  2. **Preload**: Entry `src/preload/index.ts` → `dist-electron/preload.js`
  3. **Renderer**: Default Vite (React) → `dist/`

**Build commands**:
- `npm run dev`: Vite dev server with HMR for renderer; main/preload rebuilt on file changes
- `npm run build`: Production build (Vite + electron-builder) → `release/` directory
- `npm start`: Runs `electron .` pointing to `dist-electron/main.js`

**Watch behavior**:
- Renderer changes: Hot module reload in dev server
- Main/preload changes: Requires restart (Vite plugin rebuilds, but Electron must reload)

---

*Structure analysis: 2026-04-21*
