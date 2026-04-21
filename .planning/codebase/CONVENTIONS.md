# Coding Conventions

**Analysis Date:** 2026-04-21

## Naming Patterns

**Files:**
- Components: `PascalCase.tsx` (e.g., `Sidebar.tsx`, `NewWorkspaceModal.tsx`, `DiffView.tsx`)
- Utilities/logic: `camelCase.ts` (e.g., `store.ts`, `git.ts`, `pty.ts`, `workspaces.ts`)
- Types: `camelCase.ts` (e.g., `types.ts`, `ipc.ts`)
- Entry points: `index.ts` or `index.tsx` or `main.tsx`

**Functions:**
- camelCase for all functions: `createWorkspace()`, `detectDefaultBranch()`, `getDiff()`, `commitAll()`
- Private/internal functions: Same camelCase convention, no underscore prefix
- Async functions follow same pattern: `async function startPty()`, `async function saveStore()`

**Variables:**
- camelCase for all variables: `mainWindow`, `activeId`, `repoPath`, `worktreePath`
- Constants in camelCase or UPPER_SNAKE_CASE: `ORCHESTRA_ROOT`, `DEFAULT`, `VITE_DEV_SERVER_URL`
- Destructured state variables with descriptive names: `const { workspaces, activeId, setActive } = useStore()`

**Types/Interfaces:**
- PascalCase for types and interfaces: `WorkspaceStatus`, `Workspace`, `DiffFile`, `StoreShape`
- Type aliases for unions: `type WorkspaceStatus = 'idle' | 'running' | 'waiting' | 'error' | 'stopped'`
- Interface names follow `CamelCase` with no prefix: `interface Props`, `interface State`, `interface Session`

## Code Style

**Formatting:**
- No explicit formatter configured (no `.prettierrc`, `eslint`, or `biome.json` in project root)
- Manual style follows consistent conventions across codebase:
  - 2-space indentation (observed throughout)
  - Semicolons used consistently
  - Single quotes in code, template literals where appropriate
  - Trailing commas in objects/arrays
  - Consistent spacing around operators

**Linting:**
- ESLint configured in `package.json` with command: `npm run lint`
- Runs with: `eslint src --ext .ts,.tsx`
- No `.eslintrc` config file present - uses default ESLint configuration or Vite/TypeScript defaults
- TypeScript strict mode enabled (`"strict": true` in `tsconfig.json`)

## Import Organization

**Order:**
1. External/Node.js modules first: `import { app } from 'electron'`, `import path from 'node:path'`
2. Sibling imports from shared modules: `import type { Workspace } from '../shared/types'`
3. Relative imports: `import { useStore } from '../store'`
4. Type imports: `import type { Props, State }` (using `import type` for types only)

**Pattern:**
- All imports grouped at top of file
- External libraries before relative paths
- Type imports separated with `import type` keyword (ES2020+ convention)
- No barrel exports used; imports reference exact files

**Path Aliases:**
- Single alias configured: `@shared/*` → `src/shared/*`
- Used in imports: `import type { Workspace } from '@shared/types'`
- Not widely adopted across codebase; mostly uses relative paths like `../shared/types`

## Error Handling

**Patterns:**
- Try/catch with empty catches for graceful degradation: 
  ```typescript
  try {
    await git.revparse(['--verify', b]);
    return b;
  } catch {
    /* next */
  }
  ```
- Fallback values in catch blocks: `return 'main'` (default branch detection)
- Suppress errors with comment: `catch { /* ignore */ }` or `catch { /* best-effort */ }`
- User-facing errors wrapped with context: `throw new Error(\`${absPath} is not a git repo\`)`
- No custom error classes; standard Error with descriptive messages
- Async/await with try/finally for cleanup:
  ```typescript
  try {
    // operation
  } finally {
    if (alive) setLoading(false);
  }
  ```

**State consistency:**
- Watch variables (e.g., `alive` flag) to prevent state updates after unmount:
  ```typescript
  let alive = true;
  // ...
  return () => {
    alive = false;
    clearInterval(interval);
  };
  ```

## Logging

**Framework:** `console` (no external logging library)

**Patterns:**
- No explicit logging in production code
- Error messages passed to users via alerts: `alert(\`Could not add repo: ${(e as Error).message}\`)`
- Development debug output via `openDevTools()` when running in Vite dev server
- Errors handled silently with fallback behavior (git operations, file reads)

## Comments

**When to Comment:**
- Comments rare; code is generally self-documenting
- Explanatory comments for complex operations:
  ```typescript
  // Create branch from base, then worktree.
  // Compare worktree (including uncommitted) against merge-base with baseBranch.
  ```
- Comments mark major sections: `// ---------- IPC ----------`, `// ---------- Lifecycle ----------`
- Edge cases or non-obvious behavior:
  ```typescript
  // Fall through to next branch candidate
  // best-effort cleanup
  ```

**JSDoc/TSDoc:**
- Not used; no `@param`, `@returns`, or `@throws` annotations
- Type annotations on function signatures provide documentation

## Function Design

**Size:**
- Functions kept small and focused; most are 10-40 lines
- Longer functions (50+ lines) break logic into helper functions
- Example: `getDiff()` (136 lines) uses `parseNumstat()`, `safeRaw()`, `safeShow()`, `readWorking()`, `truncate()`

**Parameters:**
- Destructured in function parameters for React components: `function Sidebar({ onNew }: Props)`
- Named parameters via objects for complex functions:
  ```typescript
  export async function startPty(opts: {
    id: string;
    cwd: string;
    command: string;
    args: string[];
    cols: number;
    rows: number;
    window: BrowserWindow;
  })
  ```
- Simple functions use direct parameters: `function truncate(s: string, max = 300_000)`

**Return Values:**
- Explicit return types on public functions: `async function detectDefaultBranch(): Promise<string>`
- Return statements clear; no implicit undefined returns
- Fallback/default returns: `return ''` for safe error handling

## Module Design

**Exports:**
- Named exports preferred: `export class Store`, `export function createWorkspace()`, `export async function getDiff()`
- Single default export used only in entry points: `export function App()`, `export default` not used
- Type exports separated: `export type WorkspaceStatus = ...`, `export interface Workspace { ... }`
- Singleton instances exported as named exports: `export const store = new Store()`

**Barrel Files:**
- Not used; imports reference specific files directly
- No `index.ts` re-exports from sibling modules

## State Management

**Zustand Store:**
- Store created with `create<State>()` hook in `src/renderer/store.ts`
- Actions defined inline in store creator: `setActive: (id) => set({ activeId: id })`
- Async actions mix `set()` and `get()`: 
  ```typescript
  archive: async (id) => {
    await window.orchestra.archiveWorkspace(id);
    const s = get();
    const remaining = s.workspaces.filter((w) => w.id !== id);
    set({ workspaces: remaining, activeId: remaining[0]?.id ?? null });
  }
  ```
- No reducers; mutations via `set()` calls
- Live updates from main process via event listeners: `window.orchestra.onWorkspaceUpdate()`

**Class-based State:**
- `Store` class (`src/main/store.ts`) wraps JSON persistence
- Public methods for mutations: `addRepo()`, `upsertWorkspace()`, `removeWorkspace()`
- Internal data accessed via getters: `get repos()`, `get workspaces()`
- No reactive framework; manual `save()` calls after mutations

## React Conventions

**Functional Components:**
- All components are functional (no class components)
- Props destructured in function signature: `function Sidebar({ onNew }: Props)`
- No default props; optional properties in interface

**Hooks:**
- `useState()` for local state
- `useEffect()` for side effects with proper cleanup:
  ```typescript
  useEffect(() => {
    // setup
    return () => {
      // cleanup
    };
  }, [dependencies]);
  ```
- Custom `useStore()` hook for global state (Zustand)
- No custom hooks defined; all logic external or in store

**Re-renders:**
- Manual dependency arrays in useEffect
- Component memoization not used (no React.memo)
- Key props used in lists: `key={w.id}`, `key={f.path}`

## TypeScript Strictness

**Compiler Options:**
- `"strict": true` - All strict checks enabled
- `"strictNullChecks": true` - Null/undefined checking enforced
- `"strictFunctionTypes": true` - Function parameter contravariance checked
- `"forceConsistentCasingInFileNames": true` - Case-sensitive file imports
- `"noImplicitAny": true` (default with strict) - No implicit any types
- `"esModuleInterop": true` - CommonJS/ES module interop

**Type Annotations:**
- All function parameters typed: `function createWorkspace(input: CreateWorkspaceInput)`
- All return types explicit on public functions: `async function commitAll(): Promise<void>`
- No `any` types used; `unknown` used sparingly with assertions
- Type casting: `as Error`, `as 'claude' | 'codex'` when necessary

**Null Safety:**
- Optional chaining: `diffs[0]?.path ?? null`
- Null coalescing: `const { workspaces, activeId } = useStore() ?? []`
- Non-null assertions: `document.getElementById('root')!`
- Proper Optional types: `id?: string`, `lastTask?: string`

---

*Convention analysis: 2026-04-21*
