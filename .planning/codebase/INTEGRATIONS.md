# External Integrations

**Analysis Date:** 2026-04-21

## Child Process Management (Claude Code / Codex CLI)

**Agent CLI Spawning:**
- What: Spawns `claude` or `codex` CLI agents as child processes in isolated git worktrees
- Implementation: node-pty pseudo-terminal spawning
- Location: `src/main/pty.ts`
- Environment: Child process inherits main Electron process environment with `TERM=xterm-256color`
- Terminal: xterm-256color emulation
- Communication: Full-duplex: write stdin via `ptyWrite()`, receive stdout/stderr via `pty:data` events
- Exit handling: Captured via `onExit` callback, sent to renderer via `pty:exit` IPC

**IPC Channels for PTY:**
- `pty:start` (invoke) - Start PTY with workspace ID, dimensions
- `pty:write` (invoke) - Write data to PTY stdin
- `pty:resize` (invoke) - Resize PTY dimensions
- `pty:stop` (invoke) - Terminate PTY
- `pty:data` (on) - Receive PTY stdout/stderr data from main process
- `pty:exit` (on) - Receive PTY exit code from main process

## Git Operations

**Git Client:**
- Library: simple-git 3.27.0
- Location: `src/main/git.ts`
- Operations:
  - **Repository validation:** `isGitRepo()` - Check if path is valid git repository
  - **Branch detection:** `detectDefaultBranch()` - Query origin/HEAD or fallback to main/master/develop
  - **Worktree management:** `createWorktree()`, `removeWorktree()` - Create/delete isolated git worktrees
  - **Diff generation:** `getDiff()` - Compare worktree against merge-base with base branch (committed + uncommitted changes)
  - **Commits:** `commitAll()` - Stage all changes and create commit
  - **Push:** `pushBranch()` - Push branch to origin
  - **Pull Request:** `createPullRequest()` - Create PR via `gh` CLI

**IPC Channels for Git:**
- `git:diff` (invoke) - Get diff files for workspace
- `git:commit` (invoke) - Commit changes with message
- `git:push` (invoke) - Push branch to origin
- `git:pr` (invoke) - Create pull request (requires GitHub CLI)

## External CLI Tools

**GitHub CLI (`gh`):**
- Used for: Create pull requests
- Invoked via: `execFile()` in `src/main/git.ts` - `createPullRequest()`
- Requirement: `gh` must be available in PATH
- Command: `gh pr create --title <title> --body <body> --base <baseBranch>`
- Output parsing: Extracts PR URL from stdout

**System Git:**
- Used for: All git operations (branch, worktree, diff, commit, push)
- Invoked via: simple-git library
- Requirement: System `git` must be available in PATH

**Code Editors:**
- Used for: Open workspace in external editor
- Location: `src/main/workspaces.ts` - `openInEditor()`
- Supported: `code` (VS Code) or `cursor` (Cursor IDE)
- Invoked via: `execFile()`, fallback to `shell.openPath()`
- No auth required: Direct filesystem opening

## IPC Bridge (Main ↔ Renderer)

**Preload Context Bridge:**
- Location: `src/preload/index.ts`
- Pattern: Exposes `window.orchestra` API to renderer
- Security: Context isolation enabled, nodeIntegration disabled

**IPC Interface (OrchestraAPI):**
```typescript
// Located at src/shared/ipc.ts
// Full API exposed via window.orchestra in renderer
```

**Repository Management:**
- `addRepo(absPath)` - Add repo (validates git repo, detects default branch)
- `listRepos()` - Get all registered repos
- `removeRepo(absPath)` - Remove repo from registry
- `pickDirectory()` - File dialog to select directory

**Workspace Management:**
- `listWorkspaces()` - Get all workspaces
- `createWorkspace(input)` - Create workspace with repo, branch, agent type, optional task
- `archiveWorkspace(id)` - Delete workspace (cleanup worktree)
- `openInEditor(id, editor)` - Open workspace in VS Code or Cursor

**Terminal Control:**
- `ptyStart(id, cols, rows)` - Start PTY for workspace
- `ptyWrite(id, data)` - Send data to PTY
- `ptyResize(id, cols, rows)` - Resize PTY
- `ptyStop(id)` - Stop PTY
- `onPtyData(cb)` - Listen for PTY output
- `onPtyExit(cb)` - Listen for PTY exit

**Git Operations:**
- `getDiff(id)` - Get diff files (read-only)
- `commit(id, message)` - Commit changes
- `push(id)` - Push to origin
- `createPR(id, title, body)` - Create GitHub PR

**Events:**
- `onWorkspaceUpdate(cb)` - Listen for workspace state changes
- Emitted: When workspace status changes, when PTY exits

## Local Storage

**Electron User Data Directory:**
- Location: `~/.orchestra/` (managed by `src/main/store.ts`)
- File: `store.json` in Electron's userData path
- Format: JSON
- Contents:
  - `repos[]` - Registered repositories (path, name, defaultBranch)
  - `workspaces[]` - Active/archived workspaces (id, name, branch, status, createdAt, etc.)
- Persistence: All changes via `store.save()` after mutations
- No encryption: Plain JSON on disk

**Worktree Storage:**
- Location: `~/.orchestra/worktrees/`
- Pattern: `{repoName}-{branch}-{uuid-prefix}/`
- Contents: Git worktree clones (full working directories)
- Lifecycle: Created on workspace creation, removed on archival

## Data Storage

**No External Databases:**
- Application state stored entirely in Electron userData JSON
- No API calls to external backends
- No authentication services
- No analytics or telemetry

**File Storage:**
- Local filesystem only (git worktrees, store.json)
- No cloud storage, no S3, no blob storage

## Authentication & Authorization

**No Auth Required:**
- Application operates entirely with user's local git/github credentials
- GitHub CLI (`gh`) uses existing user authentication (via `~/.config/gh/config.yml` or system keyring)
- No API keys, OAuth tokens, or service accounts configured in code

## Webhooks & Callbacks

**Not Applicable:**
- No incoming webhooks
- No external service callbacks
- Terminal output events are internal Electron IPC only

## Environment Configuration

**Environment Variables (None Required):**
- Application does not read `.env` files or require environment configuration
- Uses system `PATH` for git, gh, claude, codex executables
- Electron userData path determined by `app.getPath('userData')`

## Monitoring & Observability

**Not Implemented:**
- No error tracking service (Sentry, etc.)
- No structured logging
- No analytics
- No health checks

**Development Debugging:**
- Dev tools: `mainWindow.webContents.openDevTools()` when `VITE_DEV_SERVER_URL` detected
- Console: Standard console.log available in main and renderer processes
- PTY output: Full agent stdout/stderr streamed to UI terminal

## CI/CD & Deployment

**Build Pipeline:**
- Vite build → electron-builder
- Output: Installable packages for Linux (AppImage), macOS (DMG), Windows (NSIS)
- No automated deployment (manual release workflow)

**Platform Support:**
- Linux: AppImage
- macOS: DMG
- Windows: NSIS installer

---

*Integration audit: 2026-04-21*
