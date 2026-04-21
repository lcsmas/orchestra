# Architecture

**Analysis Date:** 2026-04-21

## Pattern Overview

**Overall:** Electron + React with IPC-based main/renderer split

**Key Characteristics:**
- **Two-process model**: Electron main process (Node.js) and renderer process (React/DOM)
- **Context isolation**: Secure IPC bridge via preload script; renderer cannot access Node APIs directly
- **Parallel agent orchestration**: Manages multiple concurrent Claude Code and Codex agents in isolated git worktrees
- **Reactive updates**: Zustand store in renderer, IPC events push changes from main process
- **Terminal multiplexing**: Each workspace owns a PTY session; main process handles all PTY I/O

## Layers

**Main Process (Node.js):**
- Purpose: System integration, git operations, PTY management, persistent storage
- Location: `src/main/`
- Contains: IPC handlers, git/worktree management, PTY server, state persistence
- Depends on: Electron, simple-git, node-pty, Node.js fs/child_process APIs
- Used by: Preload script (via IPC), event broadcasts to renderer

**Preload Bridge:**
- Purpose: Safely expose main process capabilities to renderer without context isolation bypass
- Location: `src/preload/index.ts`
- Contains: OrchestraAPI implementation mapping renderer calls to IPC invoke/on handlers
- Depends on: Electron context bridge and ipcRenderer
- Used by: React components in renderer via `window.orchestra`

**Renderer (React + UI):**
- Purpose: User interface for workspace management, terminal viewing, diff inspection, and PR workflow
- Location: `src/renderer/`
- Contains: React components, Zustand store, terminal emulation, diff viewer
- Depends on: React, Zustand, xterm.js, Monaco editor, IPC bridge
- Used by: HTML document loaded by Electron BrowserWindow

**Shared Types & IPC Contract:**
- Purpose: Type definitions and IPC method signatures shared between main and renderer
- Location: `src/shared/`
- Contains: `types.ts` (Workspace, DiffFile, RepoEntry, WorkspaceStatus), `ipc.ts` (OrchestraAPI interface)
- Depends on: TypeScript only
- Used by: All layers for type safety

## Data Flow

**Workspace Creation Flow:**

1. User fills NewWorkspaceModal form (`src/renderer/components/NewWorkspaceModal.tsx`)
2. `useStore.createWorkspace()` calls `window.orchestra.createWorkspace(input)` → IPC invoke
3. Main process IPC handler `ipcMain.handle('workspaces:create')` receives input
4. Main process calls `createWorkspace()` from `src/main/workspaces.ts`:
   - Creates git worktree via `createWorktree()` in `src/main/git.ts`
   - Creates Workspace record in store
   - Spawns PTY session via `startPty()` in `src/main/pty.ts`
   - Sends `workspace:update` event to renderer
5. Renderer receives event, updates Zustand store, switches to active workspace
6. Terminal component (`src/renderer/components/Terminal.tsx`) renders xterm and connects to PTY output

**Diff Viewing Flow:**

1. User clicks "Diff" tab in toolbar
2. `DiffView` component mounts → calls `window.orchestra.getDiff(workspaceId)`
3. Main process IPC handler calls `getDiff()` from `src/main/git.ts`:
   - Runs `git diff --numstat` against merge-base with baseBranch
   - Reads file contents (old and new) from worktree
   - Returns DiffFile[] with path, status, additions/deletions, oldContent, newContent
4. DiffView renders file list on left; clicking file opens Monaco DiffEditor
5. Polling every 4 seconds refetches diff to show live changes

**PTY I/O Flow:**

1. Terminal component mounts → calls `window.orchestra.ptyStart(id, cols, rows)`
2. Main process `startPty()` spawns agent CLI (claude or codex) in worktree
3. PTY subprocess output → main process sends via `window.webContents.send('pty:data', id, data)`
4. Terminal component receives `onPtyData` event → writes to xterm
5. User input in xterm → Terminal sends `window.orchestra.ptyWrite(id, data)` → main process writes to PTY
6. PTY process exits → main process sends `pty:exit` event with exit code

**Workspace Status Updates:**

1. Main process performs long-running operation (commit, push, etc.)
2. Emits `workspace:update` event with updated Workspace object
3. Renderer's Zustand store listener (`src/renderer/store.ts` line 69) maps update to store
4. Affected React components re-render with new status

**State Management:**

- **Main process**: Store class (`src/main/store.ts`) persists repos and workspaces to `~/.orchestra/store.json`
- **Renderer**: Zustand store (`src/renderer/store.ts`) holds repos, workspaces, activeId, and view mode
- **Sync**: Renderer calls `load()` on mount; subsequent updates from main process via IPC events

## Key Abstractions

**Workspace:**
- Purpose: Represents an isolated agent execution environment with git worktree and PTY
- Location: `src/shared/types.ts`, managed in `src/main/store.ts`, viewed in `src/renderer/`
- Pattern: Plain immutable data object; status transitions driven by main process events
- Properties: id, name, repoPath, worktreePath, branch, baseBranch, createdAt, status, agent, lastTask

**OrchestraAPI:**
- Purpose: Type-safe contract for renderer ↔ main process communication
- Location: `src/shared/ipc.ts` (interface), `src/preload/index.ts` (implementation)
- Pattern: Promise-based invoke for request/response; callback-based on for events
- Methods: repos, workspaces, pty, git (diff/commit/push/pr), events (onPtyData, onPtyExit, onWorkspaceUpdate)

**PTY Session:**
- Purpose: Bidirectional communication with agent subprocess
- Location: `src/main/pty.ts`
- Pattern: Map of workspace ID → node-pty IPty instance; handlers for data and exit events
- Lifecycle: Created at workspace creation, destroyed when workspace archived or agent exits

**DiffFile:**
- Purpose: Represents a single changed file in git worktree (committed + uncommitted changes)
- Location: `src/shared/types.ts`
- Pattern: Aggregated stats from `git diff --numstat` with full oldContent/newContent for diff viewer
- Computation: `getDiff()` in `src/main/git.ts` merges committed and working tree changes

**Repo Entry:**
- Purpose: Reference to a git repository that agents can spawn workspaces from
- Location: `src/shared/types.ts`, stored and managed in `src/main/store.ts`
- Pattern: Path, name, and detected defaultBranch
- Operations: Add repo (validate is git repo, detect default branch), remove repo

## Entry Points

**Main Process Entry:**
- Location: `src/main/index.ts`
- Triggers: Electron app.whenReady() event
- Responsibilities:
  - Creates BrowserWindow pointing to dev server or built dist/index.html
  - Sets up context isolation with preload script at `dist-electron/preload.js`
  - Registers all IPC handlers for repos, workspaces, PTY, git operations
  - Manages app lifecycle (window-all-closed, before-quit → cleanups)

**Renderer Entry:**
- Location: `src/renderer/main.tsx`
- Triggers: HTML document load of `index.html` (Dev: Vite dev server; Prod: dist/index.html)
- Responsibilities:
  - Creates React root at #root DOM element
  - Renders App component which loads store and renders UI

**IPC Handler Registration:**
- Location: `src/main/index.ts` lines 44–122
- Method: `ipcMain.handle(channel, handler)`
- Channels:
  - `repos:list`, `repos:add`, `repos:remove`, `dialog:pickDir`
  - `workspaces:list`, `workspaces:create`, `workspaces:archive`, `workspaces:openInEditor`
  - `pty:start`, `pty:write`, `pty:resize`, `pty:stop`
  - `git:diff`, `git:commit`, `git:push`, `git:pr`

## Error Handling

**Strategy:** Synchronous errors thrown as Error objects; caught in renderer, displayed in alerts or modal error UI

**Patterns:**

- **IPC invoke errors**: Main process handler throws → renderer's `catch (e as Error)` → alert dialog (`src/renderer/components/NewWorkspaceModal.tsx` line 29, PRModal.tsx line 82)
- **PTY spawn failures**: Terminal component catches `startPty()` rejection → writes ANSI red error to xterm
- **Git operations**: Safe wrappers (`safeRaw`, `safeShow`, `readWorking`) in `src/main/git.ts` return empty strings instead of throwing
- **Worktree removal**: Best-effort; if `git worktree remove` fails, falls back to `fs.rm()` with force flag

## Cross-Cutting Concerns

**Logging:** Currently minimal; errors and status changes logged via:
- Terminal output written directly to xterm via ANSI codes
- Workspace events trigger console logging in renderer store listeners

**Validation:**
- Git repo validation: `isGitRepo()` checks `git rev-parse --is-inside-work-tree`
- Branch name sanitization: Replace unsafe chars with hyphens in `createWorkspace()`
- IPC input validation: TypeScript types enforce correct argument shapes

**Authentication:**
- No built-in auth; relies on:
  - GitHub CLI (`gh`) authentication for PR creation
  - SSH/Git credentials for push/pull operations
  - Agent CLI (claude/codex) environment authentication (assumed by user)

**Workspace Isolation:**
- Git worktrees isolate each agent's files from main repo
- Separate PTY session per workspace prevents agent interference
- Store UUID per workspace prevents collisions

---

*Architecture analysis: 2026-04-21*
