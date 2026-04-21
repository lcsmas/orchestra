# Codebase Concerns

**Analysis Date:** 2026-04-21

## Tech Debt

**No test coverage:**
- Issue: Zero automated tests (unit, integration, or e2e). MVP state but no safety net for regressions.
- Files: Entire `src/` directory
- Impact: Blind refactoring, missed bugs in critical paths (git operations, IPC, PTY lifecycle)
- Fix approach: Add jest/vitest + foundational unit tests for `src/main/git.ts`, `src/main/pty.ts`, `src/main/store.ts`, and critical IPC handlers in `src/main/index.ts`

**No linting or code style enforcement:**
- Issue: No ESLint, Prettier, or code formatter configured
- Files: `package.json` (line 10 references eslint but no config exists), `tsconfig.json`
- Impact: Inconsistent code style, potential for undiscovered bugs (e.g., unused vars, missing error handling)
- Fix approach: Add `.eslintrc.json` with TypeScript rules, Prettier config, run in CI

**Hardcoded agent command names:**
- Issue: Agent spawn logic only knows about 'claude' and 'codex' CLIs; no abstraction or extensibility
- Files: `src/main/workspaces.ts` (line 47), `src/main/index.ts` (line 86)
- Impact: Adding new agents requires code changes; no plugin system or configuration
- Fix approach: Move agent definitions to a config file or enum with spawn metadata

**Unsafe environment inheritance in PTY spawn:**
- Issue: `src/main/pty.ts` line 33 spreads entire `process.env` into child process
- Files: `src/main/pty.ts:33`
- Impact: Electron env vars, app secrets, host PATH are leaked to agent processes; agents can access unintended capabilities
- Fix approach: Whitelist only necessary env vars (HOME, USER, TERM, PATH with constraints); strip ELECTRON_*, npm_*, and other internal vars

**Hardcoded terminal size defaults:**
- Issue: `src/main/workspaces.ts:53-54` hardcodes cols=120, rows=32 for all agents
- Files: `src/main/workspaces.ts:53-54`
- Impact: Terminal may not fit user's window; no persistence of user's preferred size across sessions
- Fix approach: Detect initial size from BrowserWindow, save user preference in store

## Security Concerns

**Arbitrary command execution via execFile in openInEditor:**
- Issue: `src/main/workspaces.ts:82` calls `execFile(editor, [ws.worktreePath])` where `editor` is 'code' or 'cursor'
- Files: `src/main/workspaces.ts:78-88`
- Impact: Medium risk. Only hardcoded editors used, but fallback to `shell.openPath()` bypasses sandboxing. If editor string ever becomes user-controlled, RCE possible.
- Current mitigation: Union type restricts to 'code' | 'cursor'; no user input
- Recommendations: Keep union type strict; never accept user-supplied editor names; consider using `shell.openPath()` only with path normalization

**Preload bridge lacks explicit API boundaries:**
- Issue: `src/preload/index.ts:48` exposes entire OrchestraAPI on window.orchestra without capability control
- Files: `src/preload/index.ts`, `src/shared/ipc.ts`
- Impact: Renderer can invoke any IPC handler without granular permission checks. Compromised renderer = full app compromise.
- Current mitigation: `contextIsolation: true`, `nodeIntegration: false` (good), but preload has no per-method guards
- Recommendations: Add middleware in preload to log/audit sensitive calls (git:push, git:pr, pty:write); consider capability-based model for sensitive ops; document that compromised renderer can spawn agents in any repo

**PTY input/output unbounded:**
- Issue: `src/main/pty.ts:38` sends raw agent stdout to renderer; `src/main/pty.ts:48` accepts raw user input and writes to agent stdin
- Files: `src/main/pty.ts:37-43`, `src/main/pty.ts:46-49`
- Impact: Agent can emit ANSI escape codes, terminal control sequences, or binary data that may crash xterm.js or trick user; user input fed directly to agent shell
- Current mitigation: `xterm.js` handles most sequences safely; PTY uses "xterm-256color"
- Recommendations: Sanitize/filter IPC messages for suspicious binary payloads; validate user terminal input length; add per-agent stdout byte counter with circuit breaker

**Path traversal in diff rendering:**
- Issue: `src/main/git.ts:120-122` constructs git show commands with file paths from `git diff` output; no validation
- Files: `src/main/git.ts:120-122`, `src/renderer/components/DiffView.tsx:75`
- Impact: Low (git is authoritative for paths in its own repo), but if git output is corrupted or malicious, could theoretically read arbitrary files via `git show ../../../etc/passwd:0`
- Current mitigation: Files come from git's own index, not user input
- Recommendations: Validate file paths are within worktree using `path.resolve()` + normalization

**Agent process isolation incomplete:**
- Issue: Agents run in PTY with full access to worktree and inherited environment; no containerization or resource limits
- Files: `src/main/workspaces.ts:49-56`, `src/main/pty.ts:28-34`
- Impact: Malicious agent code or prompt injection could steal git credentials, modify repos across multiple worktrees, exhaust disk/memory
- Current mitigation: Each worktree is a separate git clone (filesystem isolation between workspaces)
- Recommendations: (MVP acceptable, but document) Set resource limits with `setrlimit()` or OS-level controls; use `--noprofile --nologin` for shell; consider namespace isolation for future versions

**Git commands executed without validation:**
- Issue: Branch names, commit messages, and PR titles accepted from user input and passed to git/gh CLI
- Files: `src/main/git.ts:54`, `src/main/git.ts:170-171`, `src/main/git.ts:186-187`
- Impact: Git injection (e.g., branch name `--force`) could break git state; gh injection less likely due to `--` separator
- Current mitigation: `src/main/workspaces.ts:26` sanitizes branch names (`replace(/[^a-zA-Z0-9._-]/g, '-')`); commit/PR title passed as args, not shell
- Recommendations: Keep sanitization of branch names; ensure commit/PR always use `--` separator or array-based args (already done); add max length limits (e.g., 200 chars for branch, 500 for commit msg)

## Performance Bottlenecks

**Diff polling every 4 seconds with full file content:**
- Issue: `src/renderer/components/DiffView.tsx:28` polls `getDiff()` every 4s; `src/main/git.ts:68-135` loads entire file contents (capped at 300KB each)
- Files: `src/renderer/components/DiffView.tsx:28`, `src/main/git.ts:163-165`
- Impact: With many large files, polling causes repeated disk reads; 300KB cap truncates large diffs; unresponsive UI if git operations block
- Current situation: Functional for MVP; becomes issue with 50+ modified files or files > 300KB
- Improvement path: Implement watcher-based updates (fs.watch or git hooks) instead of polling; stream diff chunks; lazy-load file contents on click

**DiffEditor re-renders on every diff poll:**
- Issue: `src/renderer/components/DiffView.tsx:35` accesses `files` and `active` in render; Monaco DiffEditor created fresh on file change
- Files: `src/renderer/components/DiffView.tsx`
- Impact: Excessive Monaco re-renders; possible memory growth in long-running sessions
- Improvement path: Memoize DiffEditor; use `key={}` to persist component; extract to separate component with lazy loading

**No pagination or virtualization for large diff file lists:**
- Issue: DiffView renders all files in a scrollable list; no virtualization
- Files: `src/renderer/components/DiffView.tsx:47-60`
- Impact: With 1000+ modified files (possible in monorepo agents), list becomes sluggish
- Improvement path: Add react-window virtualization; implement infinite scroll with pagination

**stdout buffering in IPC channel:**
- Issue: `src/main/pty.ts:37-39` sends each onData chunk via IPC; no batching
- Files: `src/main/pty.ts:37-39`
- Impact: High-throughput agent output (build logs, large diffs) may cause IPC message queue buildup; potential memory spike if agent floods stdout
- Improvement path: Buffer chunks for 10-50ms before sending; add backpressure detection

**Store persistence synchronous for every operation:**
- Issue: `src/main/store.ts:40` calls `writeFile()` synchronously (implicitly through await) on each `save()`; called on every workspace change
- Files: `src/main/store.ts`, every call to `upsertWorkspace()` and `removeWorkspace()`
- Impact: Creating many workspaces in quick succession causes disk I/O stalls; no batching
- Improvement path: Implement debounced save (e.g., batch writes within 500ms); use `fs.promises.writeFile` with timeout

## Fragile Areas

**Git worktree lifecycle management:**
- Files: `src/main/workspaces.ts:19-63`, `src/main/workspaces.ts:65-76`, `src/main/git.ts:44-66`
- Why fragile: Worktree creation and cleanup is a multi-step process (create branch, create worktree, spawn PTY, optional stdin). If any step fails mid-way (e.g., create branch succeeds but worktree add fails), orphaned branch/directory remains; `archiveWorkspace` is best-effort cleanup but may leave `.orchestra/worktrees/` entries
- Safe modification: Add explicit transaction/rollback pattern; store worktree creation state in `store.json`; implement cleanup on app startup for dangling entries
- Test coverage: Zero; high-risk for silent failures

**PTY session lifecycle with no reference counting:**
- Files: `src/main/pty.ts:10-75`
- Why fragile: `sessions` map can get out of sync if onExit fires twice, or if stopPty is called concurrently; no cleanup on window close vs. explicit stopPty
- Safe modification: Use weak maps or explicit lifecycle guards; ensure `stopAll()` is idempotent
- Test coverage: None; potential for memory leaks

**Store JSON schema with no validation:**
- Files: `src/main/store.ts`
- Why fragile: No schema validation on load; if `.orchestra/store.json` is corrupted or manually edited, app loads silently with DEFAULT; lost workspace data on crash during save
- Safe modification: Add zod or joi schema validation; implement atomic writes with temp file + rename pattern
- Test coverage: None

**IPC handler error propagation:**
- Files: `src/main/index.ts:46-122`
- Why fragile: IPC handlers throw errors, but no central error handler; renderer must catch individually; some errors silently ignored (e.g., archiveWorkspace line 71-73)
- Safe modification: Add ipcMain.on wrapper with logging; standardize error responses (HTTP-style codes or error objects)

## Known Bugs

**Modal input focus race condition:**
- Symptoms: When NewWorkspaceModal opens, autoFocus on branch input may not fire; user types but input doesn't receive focus
- Files: `src/renderer/components/NewWorkspaceModal.tsx:65`
- Trigger: Rapid open/close of modal, or modal open during component remount
- Workaround: Click input manually

**DiffView empty state message wrapping:**
- Symptoms: "The agent hasn't modified any files in this worktree." text overflows on narrow windows
- Files: `src/renderer/components/DiffView.tsx:41`
- Trigger: Resize window to < 400px width
- Workaround: Widen window

**gitIgnore violations in worktree creation:**
- Symptoms: After creating a worktree, `~/.orchestra/worktrees/` is not gitignored in the parent repo; git status shows untracked entries
- Files: `src/main/workspaces.ts:27` (path is `~/.orchestra/worktrees/`, outside repo, so should be fine; but user may symlink or use unconventional setup)
- Trigger: If `.orchestra` is inside git repo, or if user has custom .gitignore behavior
- Workaround: Ensure `.orchestra/` is in repo .gitignore

## Test Coverage Gaps

**No tests for git operations:**
- What's not tested: createWorktree, getDiff (especially edge cases: merge-base failures, binary files, large files), removeWorktree, commitAll, pushBranch, createPullRequest
- Files: `src/main/git.ts`
- Risk: Branch creation could fail silently; diff could truncate without warning; push errors could leave dangling branches
- Priority: High

**No tests for PTY spawn and lifecycle:**
- What's not tested: startPty success, failure, onData/onExit callbacks, writePty, resizePty, stopPty, stopAll, race conditions
- Files: `src/main/pty.ts`
- Risk: Agent process could hang; data loss if onExit fires before onData; memory leaks if sessions not cleaned
- Priority: High

**No tests for IPC handlers:**
- What's not tested: All ipcMain.handle calls in `src/main/index.ts`; parameter validation, error handling, workspace lookup
- Files: `src/main/index.ts`
- Risk: Invalid workspace IDs silently fail; no audit of what renderer calls
- Priority: Medium

**No tests for store persistence:**
- What's not tested: Load/save, corrupt JSON recovery, concurrent write safety
- Files: `src/main/store.ts`
- Risk: Data loss on crash; corruption during concurrent access
- Priority: Medium

**No E2E tests:**
- What's not tested: End-to-end workflow: add repo, create workspace, agent runs, diff updates, commit, push, open PR
- Risk: Integration bugs (e.g., IPC message ordering, preload timing) only discovered in production
- Priority: High (for 0.2.0+)

## Scaling Limits

**Single window and worktree directory:**
- Current capacity: ~100 concurrent agents before UI becomes unresponsive (rough estimate)
- Limit: DiffView list gets unwieldy; `~/.orchestra/worktrees/` filesystem with 10K+ directories becomes slow
- Scaling path: Implement multi-window support for separate views; archive old worktrees to a manifest; consider distributed worktree storage

**Store.json file size:**
- Current capacity: ~1000 workspaces before JSON load/save becomes noticeably slow
- Limit: Each workspace entry is ~500 bytes; store is fully loaded into memory
- Scaling path: Switch to IndexedDB or SQLite for pagination; implement lazy-load of workspace metadata

**PTY session memory:**
- Current capacity: ~50 concurrent agents before terminal scrollback (10K lines each) consumes significant heap
- Limit: No per-agent memory limits; xterm.js scrollback buffer not capped per terminal instance
- Scaling path: Add configurable scrollback limit per agent; implement ring buffer with size cap

**IPC message queue:**
- Current capacity: High-throughput agents (> 1MB/s output) may overflow browser's IPC queue
- Limit: No backpressure or flow control; can't slow down PTY read if renderer is busy
- Scaling path: Add watermark-based pausing of PTY reads; batching of IPC messages

## Missing Critical Features

**No persistence of agent stdout/logs:**
- Problem: Agent terminal output is lost when agent exits or window closes; no way to review past agent work
- Blocks: Debugging failed agents, auditing what changes agents made, resuming work
- Suggested solution: Stream logs to `~/.orchestra/logs/<workspace-id>.log`; add log viewer UI; implement log rotation

**No agent status lifecycle:**
- Problem: Workspace status enum (line 1 of `src/shared/types.ts`) defines 'idle', 'running', 'waiting', 'error', 'stopped' but only 'running' is used; no actual tracking
- Blocks: UI can't show if agent is waiting, errored, or idle
- Suggested solution: Update pty.ts and workspaces.ts to emit status transitions; renderer displays status badge

**No graceful agent shutdown or pause:**
- Problem: Agents run to completion or are killed abruptly; no way to pause/resume or send signals
- Blocks: Long-running agents can't be interrupted mid-step without orphaning the terminal
- Suggested solution: Add ptyStop signal wrapper (SIGTERM → SIGKILL); implement agent command queue (pause/resume)

**No branch protection or merge conflict detection:**
- Problem: Can push to main/protected branches without warning; no conflict check before PR creation
- Blocks: Accidental force-pushes, merged PRs without review
- Suggested solution: Pre-push check for branch protection; git merge-base dry-run before PR

**No multi-repo orchestration:**
- Problem: Each workspace is independent; no way to spawn agents on related repos in sequence
- Blocks: Complex tasks spanning multiple repos (e.g., "update config in 5 repos, create PRs")
- Suggested solution: Add workflow/pipeline feature; implement repo grouping

## Dependencies at Risk

**node-pty native module rebuild requirement:**
- Risk: Requires `npm install && electron-rebuild` in dev; ABI compatibility issues when electron version changes
- Impact: Broken on fresh install if rebuild forgotten; native module crashes if ABI mismatch
- Migration plan: Pre-build binaries for major electron versions; document rebuild in README more prominently; consider fallback to `child_process.spawn` with manual TTY setup

**simple-git library:**
- Risk: Depends on git CLI; no fallback if `git` not in PATH
- Impact: Creates cryptic error messages if git isn't installed
- Migration plan: Add explicit git detection at startup; prompt user to install if missing

**electron-builder as dev dependency:**
- Risk: Large transitive deps; slow build times; brittle on different OS (macOS notarization, Windows signing)
- Impact: Build failures on CI; requires manual code signing setup
- Migration plan: Document in CONTRIBUTING.md; consider splitting into separate build script

## Notes for MVP

This is an MVP and several gaps are acceptable:

- ✅ **No test coverage** is expected; add tests as feature area stabilizes
- ✅ **No persistence of agent logs** is MVP; can be added in 0.2.0
- ✅ **No advanced git features** (conflict detection, branch protection checks) are MVP scope
- ✅ **Scaling limits** are acceptable for small number of concurrent agents (< 10)

However, **security and data loss risks should be addressed soon**:

- 🔴 **Env var leakage to agents** should be fixed before production use (high impact)
- 🔴 **Worktree orphaning on creation failure** should have recovery logic (data loss risk)
- 🟡 **No test coverage for git/pty** leaves critical paths vulnerable to regression

---

*Concerns audit: 2026-04-21*
