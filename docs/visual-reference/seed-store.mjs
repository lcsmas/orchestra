#!/usr/bin/env node
/**
 * Visual-reference fixture seed (M4-V0).
 *
 * Writes the Electron-side `store.json` that MIRRORS the GTK app's
 * `MockBackend` fixture (native/orchestra-gtk/src/backend/mock.rs —
 * `mock_workspaces()` / `mock_repos()` / `mock_accounts()`), field for field.
 *
 * WHY a mirror rather than a shared file: the GTK side serves its fixture from
 * compiled-in Rust (ORCHESTRA_GTK_MOCK=1), the Electron side reads a JSON store
 * off disk. Both frontends deserialize the SAME wire `Workspace` type, so the
 * JSON below is byte-comparable with the Rust `json!` literals. If mock.rs
 * changes, update this file in the same change or the reference pair stops
 * comparing like with like.
 *
 * The repo paths are deliberately NON-EXISTENT (/home/user/repos/...): the
 * boot-path orphan pruner (src/main/workspaces.ts:658 pruneOrphanedWorkspaces)
 * skips any repo whose path does not exist, so the seeded rows survive to first
 * paint instead of being torn down as orphans.
 *
 * Usage: node docs/visual-reference/seed-store.mjs <ORCHESTRA_HOME>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const home = process.argv[2];
if (!home) {
  console.error('usage: seed-store.mjs <ORCHESTRA_HOME>');
  process.exit(1);
}

const ORCHESTRA_REPO = '/home/user/repos/orchestra';
const MOBILE_CLUB_REPO = '/home/user/repos/mobile-club';
const SANDBOX_A = 'ws://sandbox-a:8787';

// Same anchor as mock.rs `let base = 1_752_800_000_000_i64`.
const base = 1_752_800_000_000;

/** Defaults applied to every fixture row, mirroring mock.rs's `w(...)`. */
const w = (extra) => ({
  baseBranch: 'master',
  createdAt: base,
  agent: 'claude',
  status: 'idle',
  kind: 'worktree',
  ...extra,
});

const workspaces = [
  // ── Orchestrator tree: root + git child (+ cross-repo grandchild) + scratch child.
  w({
    id: 'orch-1',
    kind: 'orchestrator',
    status: 'running',
    name: 'orchestrator · gtk4-port',
    branch: 'gtk4-port-coordinator',
    repoPath: '',
    worktreePath: '/home/user/.orchestra/scratch/orch-1',
    contextTokens: 412_000,
  }),
  w({
    id: 'ws-child-a',
    parentId: 'orch-1',
    status: 'running',
    name: 'orchestra · m2-sidebar',
    branch: 'm2-sidebar',
    repoPath: ORCHESTRA_REPO,
    worktreePath: '/home/user/.orchestra/worktrees/m2-sidebar',
    contextTokens: 84_500,
  }),
  w({
    id: 'ws-grandchild',
    parentId: 'ws-child-a',
    status: 'idle',
    name: 'mobile-club · api-fixtures',
    branch: 'api-fixtures',
    repoPath: MOBILE_CLUB_REPO,
    worktreePath: '/home/user/.orchestra/worktrees/api-fixtures',
  }),
  w({
    id: 'orch-scratch-kid',
    parentId: 'orch-1',
    kind: 'scratch',
    status: 'waiting',
    markedUnread: true,
    name: 'scratch · verifier',
    branch: 'verifier',
    repoPath: '',
    worktreePath: '/home/user/.orchestra/scratch/orch-scratch-kid',
  }),
  // ── Scratch tree: root + one spawned git child.
  w({
    id: 'scratch-1',
    kind: 'scratch',
    status: 'idle',
    name: 'scratch · api-spelunking',
    branch: 'api-spelunking',
    repoPath: '',
    worktreePath: '/home/user/.orchestra/scratch/scratch-1',
  }),
  w({
    id: 'ws-from-scratch',
    parentId: 'scratch-1',
    status: 'running',
    name: 'orchestra · spike-vte-feed',
    branch: 'spike-vte-feed',
    repoPath: ORCHESTRA_REPO,
    worktreePath: '/home/user/.orchestra/worktrees/spike-vte-feed',
  }),
  // ── orchestra repo roots: one per pill state.
  // ws-1/ws-2 carry a PINNED accountId — the row badge only exercises its
  // label/tint path when an account is actually assigned (an unpinned row just
  // renders "default" and masks the badge styling entirely).
  w({
    id: 'ws-1',
    status: 'running',
    name: 'orchestra · fix-status-dot',
    branch: 'fix-status-dot',
    repoPath: ORCHESTRA_REPO,
    worktreePath: '/home/user/.orchestra/worktrees/fix-status-dot',
    unpushedAhead: 3,
    contextTokens: 127_000,
    accountId: 'acc-work',
  }),
  w({
    id: 'ws-2',
    status: 'waiting',
    name: 'orchestra · usage-poll-retry',
    branch: 'usage-poll-retry',
    repoPath: ORCHESTRA_REPO,
    worktreePath: '/home/user/.orchestra/worktrees/usage-poll-retry',
    mergedAt: base,
    queuedPrompts: [
      {
        id: 'q1',
        text: 'Run the full migration and report row counts.',
        queuedAt: 1_752_800_100_000,
      },
      {
        id: 'q2',
        text: 'Then open a PR summarising the schema changes.',
        queuedAt: 1_752_800_200_000,
      },
    ],
    accountId: 'acc-perso',
  }),
  w({
    id: 'ws-3',
    status: 'idle',
    name: 'orchestra · chime-volume',
    branch: 'chime-volume',
    repoPath: ORCHESTRA_REPO,
    worktreePath: '/home/user/.orchestra/worktrees/chime-volume',
    mergedAt: base,
    releasedAt: base,
    releasedVersions: ['0.5.88', '0.5.89'],
    branchManuallySet: true,
  }),
  w({
    id: 'ws-4',
    status: 'error',
    name: 'orchestra · flaky-e2e-hunt',
    branch: 'flaky-e2e-hunt',
    repoPath: ORCHESTRA_REPO,
    worktreePath: '/home/user/.orchestra/worktrees/flaky-e2e-hunt',
    setupStatus: 'failed',
    setupError: 'pnpm install exited 1',
  }),
  w({
    id: 'ws-5',
    status: 'stopped',
    markedUnread: true,
    name: 'orchestra · nmc-261-terminal-glyphs',
    branch: 'nmc-261-terminal-glyphs',
    repoPath: ORCHESTRA_REPO,
    worktreePath: '/home/user/.orchestra/worktrees/nmc-261-terminal-glyphs',
    setupStatus: 'running',
  }),
  // ── mobile-club repo: local + two sandbox-hosted rows (host groups).
  w({
    id: 'ws-mc-1',
    status: 'idle',
    name: 'mobile-club · checkout-retry',
    branch: 'checkout-retry',
    repoPath: MOBILE_CLUB_REPO,
    worktreePath: '/home/user/.orchestra/worktrees/checkout-retry',
  }),
  w({
    id: 'ws-mc-sb1',
    status: 'running',
    name: 'mobile-club · order-webhooks',
    branch: 'order-webhooks',
    repoPath: MOBILE_CLUB_REPO,
    worktreePath: '/workspaces/order-webhooks',
    host: { kind: 'sandbox', endpoint: SANDBOX_A },
  }),
  w({
    id: 'ws-mc-sb2',
    status: 'waiting',
    name: 'mobile-club · loyalty-points',
    branch: 'loyalty-points',
    repoPath: MOBILE_CLUB_REPO,
    worktreePath: '/workspaces/loyalty-points',
    host: { kind: 'sandbox', endpoint: SANDBOX_A },
  }),
  // ── Archived (multi-select / bulk-delete fodder).
  w({
    id: 'ws-arch-1',
    status: 'stopped',
    archived: true,
    archivedAt: base,
    name: 'orchestra · old-logo-pass',
    branch: 'old-logo-pass',
    repoPath: ORCHESTRA_REPO,
    worktreePath: '/home/user/.orchestra/worktrees/old-logo-pass',
  }),
  w({
    id: 'ws-arch-2',
    status: 'stopped',
    archived: true,
    archivedAt: base,
    name: 'orchestra · abandoned-spike',
    branch: 'abandoned-spike',
    repoPath: ORCHESTRA_REPO,
    worktreePath: '/home/user/.orchestra/worktrees/abandoned-spike',
  }),
  w({
    id: 'ws-arch-3',
    status: 'stopped',
    archived: true,
    archivedAt: base,
    name: 'mobile-club · perf-experiment',
    branch: 'perf-experiment',
    repoPath: MOBILE_CLUB_REPO,
    worktreePath: '/home/user/.orchestra/worktrees/perf-experiment',
  }),
];

const repos = [
  {
    path: ORCHESTRA_REPO,
    name: 'orchestra',
    defaultBranch: 'master',
    remoteUrl: 'https://github.com/lcsmas/orchestra',
    scripts: { setup: 'pnpm install', run: 'pnpm run dev' },
  },
  {
    path: MOBILE_CLUB_REPO,
    name: 'mobile-club',
    defaultBranch: 'develop',
  },
];

// mock.rs `mock_accounts()`. ws-1 → acc-work, ws-2 → acc-perso (see the
// accountId pins above, which is how the Electron side carries the mapping
// mock.rs keeps in `mock_workspace_accounts()`).
const accounts = [
  {
    id: 'acc-work',
    label: 'work',
    configDir: '~/.claude-work',
    scratchDefault: true,
    inherit: { settings: true, statusline: true },
  },
  { id: 'acc-perso', label: 'perso', configDir: '~/.claude-perso' },
  { id: 'acc-mc', label: 'mobile-club', configDir: '${HOME}/.claude-mc' },
  { id: 'acc-broken', label: 'broken', configDir: '~/.claude-broken' },
];

// One finished run so the self-tune scheduler does NOT spawn a headless claude
// ~15s into the capture (same guard the live-drive script uses).
const selfTuneRuns = [
  {
    id: 'seed',
    trigger: 'manual',
    status: 'ok',
    startedAt: base,
    finishedAt: base,
    steps: [],
  },
];

const dir = path.join(home, 'userData', 'orchestra');
mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'store.json');
writeFileSync(
  out,
  JSON.stringify({ repos, workspaces, accounts, selfTuneRuns }, null, 2),
);
console.log(
  `seeded ${out}: ${workspaces.length} workspaces, ${repos.length} repos, ${accounts.length} accounts`,
);
