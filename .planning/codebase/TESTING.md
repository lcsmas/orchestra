# Testing Patterns

**Analysis Date:** 2026-04-21

## Test Infrastructure Status

**Testing Framework:** Not present

**Current State:** This codebase has **no tests**. No test files, test runner configuration, or testing dependencies are present.

**What Needs to Be Added:**
1. Test framework (Jest, Vitest, or other)
2. Test assertion library (built-in or separate)
3. Mocking library (if integration testing)
4. Test configuration file
5. Test file locations and naming conventions
6. Coverage tooling (optional)

## Why Tests Are Absent

This is an early-stage Electron application (v0.1.0) with a small codebase. The project prioritizes feature development over test coverage at this stage.

## Testable Modules

The codebase has several modules that would benefit from testing:

### 1. Git Operations (`src/main/git.ts`)
**What to test:**
- `detectDefaultBranch()` - Branch detection fallback logic
- `isGitRepo()` - Git repository validation
- `createWorktree()` - Worktree creation with error handling
- `removeWorktree()` - Cleanup with fallback to forced removal
- `getDiff()` - Diff parsing and file collection logic
- `commitAll()`, `pushBranch()` - Git operations
- `createPullRequest()` - PR creation via CLI

**Why it matters:** Core business logic; errors here break workspace operations

**Test approach:**
- Mock `simple-git` library
- Mock file system operations
- Test fallback behavior (e.g., branch detection falls through to 'main')
- Test error handling (missing branches, failed operations)

### 2. Store Persistence (`src/main/store.ts`)
**What to test:**
- `load()` - File read and JSON parsing
- `save()` - JSON serialization and file write
- `addRepo()`, `removeRepo()` - Repo CRUD
- `upsertWorkspace()` - Workspace updates (insert/update)
- `removeWorkspace()` - Workspace deletion
- Deduplication logic in `addRepo()` (doesn't add duplicate paths)

**Why it matters:** Data persistence; data loss would be critical

**Test approach:**
- Mock file system (`fs/promises`)
- Test merge behavior (new data merged with defaults)
- Test error recovery (malformed JSON defaults to empty state)
- Test idempotency (multiple saves preserve state)

### 3. Workspace Management (`src/main/workspaces.ts`)
**What to test:**
- `createWorkspace()` - Full workspace setup
- `archiveWorkspace()` - Cleanup and removal
- `openInEditor()` - Editor launching logic

**Why it matters:** User-facing operations; incorrect setup wastes time

**Test approach:**
- Mock git operations
- Mock PTY startup
- Mock shell/editor launching
- Test workspace name generation with special characters
- Test error fallback (if editor fails, open path instead)

### 4. Zustand Store (`src/renderer/store.ts`)
**What to test:**
- `load()` - Async loading from IPC
- `createWorkspace()` - State update on creation
- `archive()` - State filtering and updates
- Event listener registration/cleanup

**Why it matters:** UI state; incorrect state causes UI bugs

**Test approach:**
- Mock `window.orchestra` IPC API
- Test state transitions
- Test error handling (catch blocks with alerts)
- Test live updates from main process

### 5. React Components (`src/renderer/components/*.tsx`)
**What to test:**
- `App.tsx` - Layout and view switching
- `Sidebar.tsx` - List rendering and selection
- `DiffView.tsx` - Diff loading and file selection
- `NewWorkspaceModal.tsx` - Form submission and validation
- `PRModal.tsx` - PR creation flow
- `Terminal.tsx` - Terminal rendering

**Why it matters:** User interface; UI bugs directly impact users

**Test approach:**
- Use React Testing Library for component tests
- Mock store with test data
- Test user interactions (clicks, form submission)
- Test conditional rendering (empty states, loading states)
- Test error boundaries or error alerts

## Recommended Testing Setup

### 1. Choose a Framework

**Option A: Vitest (Recommended)**
- Fast (native ESM, single-threaded by default)
- Great TypeScript support
- Works well with Vite (already in use)
- Lower setup overhead

**Option B: Jest**
- Industry standard
- Mature ecosystem
- More configuration needed

### 2. Install Dependencies

```bash
# For Vitest approach
npm install --save-dev vitest @vitest/ui

# Testing utilities
npm install --save-dev @testing-library/react @testing-library/user-event
npm install --save-dev jsdom  # DOM environment for component tests

# Mocking
npm install --save-dev vi  # Built into vitest
npm install --save-dev @vitest/spy

# Types
npm install --save-dev @testing-library/jest-dom @vitest/globals
```

### 3. Configuration File

Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test/',
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
      ],
    },
  },
});
```

### 4. Update package.json

Add test scripts:

```json
{
  "scripts": {
    "test": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest --coverage"
  }
}
```

### 5. Test File Locations

**Pattern to adopt:** Co-located with source files

```
src/
├── main/
│   ├── git.ts
│   ├── git.test.ts           // Test next to implementation
│   ├── store.ts
│   ├── store.test.ts
│   └── ...
├── renderer/
│   ├── components/
│   │   ├── Sidebar.tsx
│   │   ├── Sidebar.test.tsx
│   │   └── ...
│   ├── store.ts
│   ├── store.test.ts
│   └── ...
└── shared/
    ├── types.ts              // No tests needed
    └── ipc.ts
```

## Test Structure Template

### Unit Test (Git Operations)

```typescript
// src/main/git.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectDefaultBranch, getDiff } from './git';

// Mock simple-git
vi.mock('simple-git');

describe('git operations', () => {
  describe('detectDefaultBranch', () => {
    it('should return origin/HEAD when available', async () => {
      // Arrange
      const mockGit = /* mocked simpleGit instance */;
      
      // Act
      const result = await detectDefaultBranch('/some/repo');
      
      // Assert
      expect(result).toBe('main');
    });

    it('should fall through to main/master/develop', async () => {
      // Arrange - git.raw() throws for first two, succeeds for 'main'
      
      // Act
      const result = await detectDefaultBranch('/some/repo');
      
      // Assert
      expect(result).toBe('main');
    });

    it('should return main as last resort', async () => {
      // Arrange - all git calls fail
      
      // Act
      const result = await detectDefaultBranch('/some/repo');
      
      // Assert
      expect(result).toBe('main');
    });
  });
});
```

### Component Test (React)

```typescript
// src/renderer/components/Sidebar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from './Sidebar';

// Mock the store
vi.mock('../store', () => ({
  useStore: () => ({
    workspaces: [
      { id: '1', name: 'test', status: 'running', agent: 'claude', branch: 'main' },
    ],
    activeId: '1',
    setActive: vi.fn(),
  }),
}));

describe('Sidebar', () => {
  it('should render workspace list', () => {
    // Arrange & Act
    render(<Sidebar onNew={() => {}} />);
    
    // Assert
    expect(screen.getByText('test')).toBeInTheDocument();
  });

  it('should call onNew when + New button clicked', async () => {
    // Arrange
    const onNew = vi.fn();
    const user = userEvent.setup();
    render(<Sidebar onNew={onNew} />);
    
    // Act
    await user.click(screen.getByText('+ New'));
    
    // Assert
    expect(onNew).toHaveBeenCalled();
  });

  it('should set active workspace on click', async () => {
    // Similar structure for state changes
  });
});
```

### Store Test (Zustand)

```typescript
// src/renderer/store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useStore } from './store';

// Mock window.orchestra IPC
vi.stubGlobal('window', {
  orchestra: {
    listRepos: vi.fn(() => Promise.resolve([])),
    listWorkspaces: vi.fn(() => Promise.resolve([])),
    createWorkspace: vi.fn(() => Promise.resolve({ id: '1', .../* workspace */ })),
    archiveWorkspace: vi.fn(),
    onWorkspaceUpdate: vi.fn(() => () => {}),
  },
});

describe('Renderer Store', () => {
  beforeEach(() => {
    // Reset store state between tests
    useStore.setState({
      repos: [],
      workspaces: [],
      activeId: null,
      loaded: false,
    });
  });

  it('should load repos and workspaces', async () => {
    // Arrange
    const state = useStore.getState();
    
    // Act
    await state.load();
    
    // Assert
    expect(useStore.getState().loaded).toBe(true);
  });

  it('should create workspace and set as active', async () => {
    // Test workspace creation flow
  });
});
```

## Coverage Goals

**Recommended minimum coverage:**
- Statements: 70%
- Branches: 65%
- Functions: 70%
- Lines: 70%

**Priority order for new tests:**
1. **High:** Git operations (`src/main/git.ts`) - Critical business logic, many error paths
2. **High:** Store persistence (`src/main/store.ts`) - Data loss risk
3. **Medium:** Workspace management (`src/main/workspaces.ts`) - Complex setup logic
4. **Medium:** Zustand store (`src/renderer/store.ts`) - State consistency
5. **Low:** React components - Harder to test, visual testing may be better

## Running Tests (Once Implemented)

```bash
# Run all tests
npm test

# Watch mode (re-run on file changes)
npm test -- --watch

# Run specific file
npm test src/main/git.test.ts

# View UI dashboard
npm run test:ui

# Generate coverage report
npm run test:coverage
```

## Mocking Strategy

**What to Mock:**
- File system operations (`fs/promises`)
- Child process execution (`child_process`)
- Simple-git operations (git wrapper)
- Electron IPC calls (`ipcRenderer`, `ipcMain`)
- Window/browser APIs (file pickers, dialogs)
- External CLI tools (gh, claude, codex)

**What NOT to Mock:**
- TypeScript type definitions
- Internal utility functions (let them run for integration)
- Basic JavaScript operations

## Testing Gaps & Risks

**Currently Untested Areas:**
- All git operations (complex fallback logic)
- File I/O and persistence (data loss risk)
- IPC channel communication (UI/main process interaction)
- Workspace lifecycle (creation, updates, deletion)
- Error paths (most try/catch blocks untested)
- React component interaction patterns
- State synchronization between renderer and main process

**Risk Assessment:**
- **High Risk:** Git operations fail silently or with unclear errors
- **High Risk:** Store corruption or data loss from bad JSON
- **Medium Risk:** UI state diverges from main process state
- **Medium Risk:** Workspace cleanup fails, leaving orphaned files

---

*Testing analysis: 2026-04-21*
