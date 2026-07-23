// Conformance-fixture generator for the ui-rpc contract
// (docs/ui-rpc-protocol.md §7). Boots the REAL api-handlers table on the
// headless platform against a seeded, throwaway ORCHESTRA_HOME and captures:
//
//   native/orchestra-rpc/fixtures/method.<name>.json   {method, params, result}
//   native/orchestra-rpc/fixtures/event.<channel>.json {channel, args}
//   native/orchestra-rpc/fixtures/binary.ptyData.json  {id, dataBase64}
//   native/orchestra-rpc/fixtures/manifest.json        coverage + skip reasons
//
// The Rust orchestra-rpc crate deserializes every fixture into its typed
// structs and re-serializes losslessly — the drift gate between types.ts and
// the serde mirror. Build + run: `pnpm run fixtures:rpc` (bundled by
// vite.daemon.config.ts next to daemon.js).
//
// Determinism: everything lives under the FIXED path /tmp/orchestra-rpc-fixtures
// (wiped each run) with HOME redirected there, seeded records use fixed
// ids/timestamps, and a normalization pass rewrites the two unavoidable
// runtime-random shapes (freshly-minted UUIDs, Date.now() stamps) to fixed
// sentinels. Methods that would hit the network, spawn agents, open browser
// windows, or sample live machine state are skipped and listed (with reasons)
// in the manifest — their coverage belongs to live E2E, not serde fixtures.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ─── Isolated, fixed-path environment (before ANY handler runs) ─────────────
// Imports are hoisted above these statements, but every module resolves its
// paths lazily (by design — see store.ts), so mutating the env here is early
// enough for all captured calls.

const BASE = '/tmp/orchestra-rpc-fixtures';
const HOME = path.join(BASE, 'home');
const REPO = path.join(BASE, 'repo');

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
delete process.env.XDG_CONFIG_HOME;
delete process.env.ORCHESTRA_HOME; // default ~/.orchestra now falls under HOME
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.LINEAR_API_KEY;

import { initPlatform, platform, setUiClientSink } from '../src/main/platform';
import { createHeadlessPlatform } from '../src/main/platform/headless';
initPlatform(createHeadlessPlatform());

import { store } from '../src/main/store';
import { apiHandlers, type ApiHandlerTable } from '../src/main/api-handlers';
import { wireEventChannel } from '../src/shared/ui-rpc-protocol';
import type { OrchestraAPI } from '../src/shared/ipc';

const T = 1700000000000; // fixed epoch-ms stamp used by every seeded record
const OUT_DIR = path.resolve(process.cwd(), 'native', 'orchestra-rpc', 'fixtures');

// ─── Seed ───────────────────────────────────────────────────────────────────

function seed(): void {
  // A tiny real git repo so diff/branch methods capture non-empty shapes.
  fs.mkdirSync(REPO, { recursive: true });
  const git = (args: string[]) =>
    execFileSync('git', ['-C', REPO, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.com',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.com',
        GIT_AUTHOR_DATE: '2023-11-14T22:13:20Z',
        GIT_COMMITTER_DATE: '2023-11-14T22:13:20Z',
      },
    });
  execFileSync('git', ['init', '-b', 'main', REPO]);
  fs.writeFileSync(path.join(REPO, 'hello.txt'), 'one\ntwo\nthree\n');
  git(['add', '.']);
  git(['commit', '-m', 'fixture: initial commit']);
  // A dirty edit so getDiff/getDiffStats capture a modified-file shape.
  fs.writeFileSync(path.join(REPO, 'hello.txt'), 'one\nTWO\nthree\nfour\n');

  // Default login dir + a configured account's dir under the fake HOME.
  fs.mkdirSync(path.join(HOME, '.claude', 'skills', 'fixture-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(HOME, '.claude', 'LESSONS.md'),
    '# Lessons\n\n- [2023-11-14] fixture lesson one\n',
  );
  fs.mkdirSync(path.join(HOME, 'claude-fixture'), { recursive: true });

  // store.json + usage.json where the headless platform resolves userData.
  const userDataOrch = path.join(platform.getUserDataDir(), 'orchestra');
  fs.mkdirSync(userDataOrch, { recursive: true });
  const storeJson = {
    repos: [
      {
        path: REPO,
        name: 'repo',
        defaultBranch: 'main',
        scripts: { setup: 'echo setup', run: 'echo run' },
      },
    ],
    workspaces: [
      {
        id: 'ws-fixture-git',
        name: 'repo · main',
        repoPath: REPO,
        worktreePath: REPO,
        branch: 'main',
        baseBranch: 'main',
        createdAt: T,
        status: 'idle',
        agent: 'claude',
        branchManuallySet: true,
        port: 55100,
        setupStatus: 'ok',
        contextTokens: 123456,
        unpushedAhead: 0,
        hasInput: true,
      },
      {
        id: 'ws-fixture-scratch',
        name: 'scratch · fixture',
        kind: 'scratch',
        repoPath: '',
        worktreePath: path.join(HOME, '.orchestra', 'scratch', 'scratch-fixture'),
        branch: 'fixture',
        baseBranch: '',
        createdAt: T,
        status: 'waiting',
        agent: 'claude',
        port: 55101,
        setupStatus: 'ok',
        queuedPrompts: [{ id: 'prompt-fixture-1', text: 'queued fixture prompt', queuedAt: T }],
      },
      {
        id: 'ws-fixture-tmp',
        name: 'scratch · disposable',
        kind: 'scratch',
        repoPath: '',
        worktreePath: path.join(HOME, '.orchestra', 'scratch', 'scratch-disposable'),
        branch: 'disposable',
        baseBranch: '',
        createdAt: T,
        status: 'idle',
        agent: 'claude',
        port: 55102,
        setupStatus: 'ok',
      },
    ],
    accounts: [
      {
        id: 'acct-fixture-1',
        label: 'Fixture Account',
        configDir: '~/claude-fixture',
        scratchDefault: false,
      },
    ],
    selfTuneRuns: [
      {
        id: 'run-fixture-1',
        trigger: 'auto',
        status: 'ok',
        startedAt: T,
        finishedAt: T + 60_000,
        steps: [
          {
            id: 'fold',
            kind: 'fold',
            loginId: 'default',
            label: 'Default login',
            configDir: path.join(HOME, '.claude'),
            status: 'ok',
            startedAt: T,
            finishedAt: T + 60_000,
            exitCode: 0,
          },
        ],
        summary: '1 lesson added',
        lessons: { added: ['fixture lesson one'], removed: [], total: 1 },
      },
    ],
  };
  fs.writeFileSync(path.join(userDataOrch, 'store.json'), JSON.stringify(storeJson, null, 2));
  fs.writeFileSync(
    path.join(userDataOrch, 'usage.json'),
    JSON.stringify({
      fiveHour: { utilization: 42, resetsAt: '2023-11-15T00:00:00.000Z' },
      sevenDay: { utilization: 17, resetsAt: '2023-11-20T00:00:00.000Z' },
      extraUtilization: null,
      fable: { utilization: 5, resetsAt: '2023-11-20T00:00:00.000Z' },
      fetchedAt: T,
    }),
  );
}

// ─── Normalization ──────────────────────────────────────────────────────────
// Freshly-minted UUIDs and Date.now() stamps are the only runtime-random
// values a captured result can carry; rewrite them to fixed sentinels so
// regeneration is byte-stable. Seeded stamps are T (in the epoch window), so
// they normalize onto themselves.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASTE_RE = /paste-\d+-\d+\./;

function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    if (UUID_RE.test(value)) return '00000000-0000-4000-8000-000000000000';
    if (PASTE_RE.test(value)) return value.replace(PASTE_RE, 'paste-0-0.');
    return value;
  }
  if (typeof value === 'number' && value > 1.5e12 && value < 2.5e12) return T;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v);
    return out;
  }
  return value;
}

// ─── Capture ────────────────────────────────────────────────────────────────

const methodsCaptured: string[] = [];
const eventsCaptured: string[] = [];

function writeFixture(name: string, payload: unknown): void {
  fs.writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(payload, null, 2)}\n`);
}

async function captureMethod(
  method: keyof ApiHandlerTable,
  params: unknown[],
  variant?: string,
): Promise<void> {
  const handler = apiHandlers[method] as (...args: unknown[]) => unknown;
  const result = normalize(await handler(...params));
  const safe = String(method).replace(/[^a-zA-Z0-9_-]/g, '-') + (variant ? `.${variant}` : '');
  writeFixture(`method.${safe}.json`, { method, params: normalize(params), result: result ?? null });
  methodsCaptured.push(variant ? `${method} (${variant})` : method);
}

// Methods deliberately not captured, with the reason recorded in the manifest.
const SKIPPED: Record<string, string> = {
  createWorkspace: 'runs git worktree add with a random branch name (live E2E territory)',
  createScratchWorkspace: 'random adjective-noun label is not normalizable',
  createOrchestratorWorkspace: 'random adjective-noun label is not normalizable',
  deleteWorkspaces: 'covered by deleteWorkspace; batch variant adds no new result shape',
  importToSandbox: 'needs a live sandbox endpoint',
  ejectFromSandbox: 'needs a live sandbox endpoint',
  backupSandbox: 'needs a live sandbox endpoint',
  takeSandboxControl: 'needs a live sandbox connection',
  ptyStart: 'spawns a real claude agent',
  nvimStart: 'spawns a real nvim',
  restartAgent: 'no-op without a live PTY; captured as the idle no-op below',
  accountLoginStart: 'spawns a real `claude /login`',
  accountLoginOpenUrl: 'would open a real browser via xdg-open',
  openExternal: 'would open a real browser via xdg-open',
  revealLogs: 'would open a real file manager via xdg-open',
  startSelfTune: 'spawns the real self-tune pipeline',
  getWorktreeSizes: 'scans the real ~/.orchestra/worktrees (machine state)',
  sampleResources: 'samples the live process table (machine state)',
  syncRepoBase: 'network fetch (no origin in the fixture repo)',
  runScriptStart: 'spawns a real run-script PTY',
};

async function captureMethods(): Promise<void> {
  // Pure reads first.
  await captureMethod('getAppVersion', []);
  await captureMethod('app:info', []);
  await captureMethod('deps:status', []);
  await captureMethod('listRepos', []);
  await captureMethod('listWorkspaces', []);
  await captureMethod('listAccounts', []);
  await captureMethod('listRepoSyncStates', []);
  await captureMethod('listRepoBranches', [REPO]);
  await captureMethod('getUsage', []);
  await captureMethod('getAccountUsage', ['acct-fixture-1']);
  await captureMethod('getAllAccountUsage', []);
  await captureMethod('getWorkspaceAccounts', []);
  await captureMethod('getEnvStatus', []);
  await captureMethod('getLinearKeySource', []);
  await captureMethod('listGlobalInheritables', []);
  await captureMethod('listSelfTuneRuns', []);
  await captureMethod('getSelfTuneOutput', ['run-fixture-1']);
  await captureMethod('listSelfTuneReports', []);
  await captureMethod('readSelfTuneLessons', []);
  await captureMethod('openSelfTuneReport', ['default']); // no report → false, no opener
  await captureMethod('logPath', []);
  await captureMethod('log', ['info', 'fixture log line', { fixture: true }]);
  await captureMethod('getRepoScripts', [REPO]);
  await captureMethod('readSetupLog', ['ws-fixture-git']);
  await captureMethod('runScriptStatus', ['ws-fixture-git']);
  await captureMethod('runScriptScrollback', ['ws-fixture-git']);
  await captureMethod('runScriptStop', ['ws-fixture-git']); // no-op on a dead PTY
  await captureMethod('sandboxControlState', ['ws-fixture-git']);
  await captureMethod('pty:scrollback', ['ws-fixture-git']);

  // Git-backed reads (real repo, deterministic dirty state).
  await captureMethod('listBranches', ['ws-fixture-git']);
  await captureMethod('getDiff', ['ws-fixture-git']);
  await captureMethod('getDiffStats', ['ws-fixture-git']);

  // Scratch variants (empty shapes).
  await captureMethod('getDiff', ['ws-fixture-scratch'], 'scratch');
  await captureMethod('getDiffStats', ['ws-fixture-scratch'], 'scratch');
  await captureMethod('findPR', ['ws-fixture-scratch']);
  await captureMethod('verifyLinear', ['ws-fixture-scratch']);

  // PTY no-ops against a dead session (all valid results).
  await captureMethod('ptyWrite', ['ws-fixture-git', 'x']);
  await captureMethod('ptyResize', ['ws-fixture-git', 120, 32]);
  await captureMethod('ptyRepaint', ['ws-fixture-git', 120, 32]);
  await captureMethod('stopAgent', ['ws-fixture-git']);
  await captureMethod('restartAgent', ['ws-fixture-git']);

  // Safe mutations (deterministic against the seed; ordering matters).
  await captureMethod('flushQueuedPrompts', ['ws-fixture-git']); // empty queue → delivered 0
  await captureMethod('removeQueuedPrompt', ['ws-fixture-scratch', 'prompt-fixture-1']);
  await captureMethod('queuePrompt', ['ws-fixture-git', 'fixture prompt']);
  await captureMethod('setUnread', ['ws-fixture-git', true]);
  await captureMethod('markSeen', ['ws-fixture-scratch']);
  await captureMethod('renameBranch', ['ws-fixture-scratch', 'renamed-fixture']);
  await captureMethod('switchBranch', ['ws-fixture-git', 'main']); // same-branch no-op shape
  await captureMethod('mergeWorktree', ['ws-fixture-git']);
  await captureMethod('reorderWorkspaces', [['ws-fixture-scratch', 'ws-fixture-git', 'ws-fixture-tmp']]);
  await captureMethod('reorderRepos', [[REPO]]);
  await captureMethod('setRepoScripts', [REPO, { setup: 'echo setup', run: 'echo run' }]);
  await captureMethod('setRepoDefaultBranch', [REPO, 'main']);
  await captureMethod('setAccounts', [
    [{ id: 'acct-fixture-1', label: 'Fixture Account', configDir: '~/claude-fixture' }],
  ]);
  await captureMethod('setRepoAccount', [REPO, 'acct-fixture-1']);
  await captureMethod('migrateWorkspaceAccount', ['ws-fixture-scratch', 'acct-fixture-1']);
  await captureMethod('refreshAccounts', []);
  await captureMethod('saveClipboardImage', ['image/png', new Uint8Array([137, 80, 78, 71])]);
  await captureMethod('checkLinearKey', ['']); // empty key → local validation error, no network
  await captureMethod('saveLinearKey', ['']); // empty → clears, no encryption path
  await captureMethod('clearLinearKey', []);
  // Promote / re-parent / demote, as one round trip that lands back where it
  // started. `ws-fixture-git` exercises the WORKTREE promotion path (keeps
  // `kind: 'worktree'`, gains `canOrchestrate`) rather than the scratch kind
  // swap, so the fixture pins the field the GTK sidebar reads. Attaching
  // ws-fixture-tmp under it needs that promotion to have happened first, and
  // demote then detaches the child again — leaving the store as the later
  // archive/delete captures expect.
  await captureMethod('promoteWorkspace', ['ws-fixture-git']);
  await captureMethod('setWorkspaceParent', ['ws-fixture-tmp', 'ws-fixture-git']);
  await captureMethod('setWorkspaceParent', ['ws-fixture-tmp', null], 'detach');
  await captureMethod('demoteWorkspace', ['ws-fixture-git']);
  await captureMethod('archiveWorkspace', ['ws-fixture-tmp']);
  await captureMethod('unarchiveWorkspace', ['ws-fixture-tmp']);
  await captureMethod('deleteWorkspace', ['ws-fixture-tmp']);
  await captureMethod('removeRepo', [path.join(BASE, 'no-such-repo')]); // unknown path → no-op
  await captureMethod('addRepo', [REPO]); // idempotent re-add returns the entry
}

// ─── Event samples ──────────────────────────────────────────────────────────
// One typed sample per `on*` channel, emitted through platform.broadcast so
// the capture rides the REAL fan-out path. The mapped type makes tsc enforce
// completeness: adding an `on*` member to OrchestraAPI breaks this build
// until a sample (and its Rust mirror) exists.

type EventMember = {
  [K in keyof OrchestraAPI]: K extends `on${string}` ? K : never;
}[keyof OrchestraAPI];

type EventArgs<K extends EventMember> = Parameters<Parameters<OrchestraAPI[K]>[0]>;

const EVENT_IPC_CHANNELS: Record<EventMember, string> = {
  onAccountLoginDone: 'accounts:loginDone',
  onPtyData: 'pty:data',
  onPtyExit: 'pty:exit',
  onPtyRestart: 'pty:restart',
  onPtyStopped: 'pty:stopped',
  onSandboxControl: 'sandbox:control',
  onSelfTuneUpdate: 'selfTune:update',
  onSelfTuneOutput: 'selfTune:output',
  onWorkspaceUpdate: 'workspace:update',
  onWorkspaceRemoved: 'workspace:removed',
  onWorkspacesRemoved: 'workspaces:removed',
  onWorkspacesDeleteProgress: 'workspaces:deleteProgress',
  onWorkspaceFocus: 'workspace:focus',
  onAgentFinished: 'agent:finished',
  onAgentNeedsInput: 'agent:needs-input',
  onAgentTool: 'agent:tool',
  onAgentContext: 'agent:context',
  onAgentEvent: 'agent:event',
  onBrowserEvent: 'browser:event',
  onRepoSyncState: 'repo:syncState',
  onUsageUpdate: 'usage:update',
  onAccountUsageUpdate: 'accounts:usageUpdate',
  onWorkspaceAccountsUpdate: 'accounts:workspaceAccounts',
  onReposUpdate: 'repos:update',
};

async function captureEvents(): Promise<void> {
  // Real values from the seeded store wherever possible.
  const ws = store.getWorkspace('ws-fixture-git')!;
  const samples: { [K in EventMember]: EventArgs<K> } = {
    onAccountLoginDone: ['acct-fixture-1'],
    onPtyData: ['ws-fixture-git', 'terminal output\r\n'], // wire form is binary; see binary.ptyData.json
    onPtyExit: ['ws-fixture-git', 0],
    onPtyRestart: ['ws-fixture-git'],
    onPtyStopped: ['ws-fixture-git'],
    onSandboxControl: [
      { endpoint: 'wss://sandbox.example:8443', driverId: 'client-1', driverName: 'lucas-laptop', isDriver: true },
    ],
    onSelfTuneUpdate: [store.selfTuneRuns[0]],
    onSelfTuneOutput: ['run-fixture-1', 'transcript chunk\n'],
    onWorkspaceUpdate: [ws],
    onWorkspaceRemoved: ['ws-fixture-tmp'],
    onWorkspacesRemoved: [['ws-fixture-tmp']],
    onWorkspacesDeleteProgress: [1, 3],
    onWorkspaceFocus: ['ws-fixture-git'],
    onAgentFinished: ['ws-fixture-git', false],
    onAgentNeedsInput: ['ws-fixture-git', false],
    onAgentTool: ['ws-fixture-git', 'Bash'],
    onAgentContext: ['ws-fixture-git', 123456],
    onAgentEvent: [
      'ws-fixture-git',
      { type: 'text-delta', seq: 0, at: 1_700_000_000_000, index: 0, text: 'Hello' },
    ],
    onBrowserEvent: [
      'ws-fixture-git',
      {
        wsId: 'ws-fixture-git',
        url: 'https://example.com/',
        title: 'Example Domain',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    ],
    onRepoSyncState: [
      {
        repoPath: REPO,
        baseBranch: 'main',
        behind: 0,
        ahead: 1,
        hasUpstream: true,
        syncedAt: T,
        syncing: false,
      },
    ],
    onUsageUpdate: [
      {
        fiveHour: { utilization: 42, resetsAt: '2023-11-15T00:00:00.000Z' },
        sevenDay: { utilization: 17, resetsAt: '2023-11-20T00:00:00.000Z' },
        extraUtilization: null,
        fable: { utilization: 5, resetsAt: '2023-11-20T00:00:00.000Z' },
        fetchedAt: T,
      },
    ],
    onAccountUsageUpdate: [
      {
        'acct-fixture-1': {
          accountId: 'acct-fixture-1',
          ok: false,
          data: null,
          errorKind: 'not-logged-in',
          errorMessage: 'account has not been logged in yet',
          fetchedAt: T,
        },
      },
    ],
    onWorkspaceAccountsUpdate: [
      {
        'ws-fixture-git': { workspaceId: 'ws-fixture-git', accountId: null, label: 'default login' },
      },
    ],
    onReposUpdate: [store.repos],
  };

  const captured = new Map<string, { channel: string; args: unknown[] }>();
  setUiClientSink({
    event: (ipcChannel, args) => {
      const wire = wireEventChannel(ipcChannel);
      if (wire && !captured.has(wire)) captured.set(wire, { channel: wire, args });
    },
    ptyData: (id, data) => {
      writeFixture('binary.ptyData.json', {
        id,
        dataBase64: Buffer.from(data, 'utf8').toString('base64'),
      });
    },
    anyFocused: () => false,
    clientCount: () => 1,
  });

  for (const member of Object.keys(samples) as EventMember[]) {
    const ipcChannel = EVENT_IPC_CHANNELS[member];
    const args = samples[member] as unknown[];
    if (member === 'onPtyData') {
      // PTY output never rides JSON events — capture the binary frame path.
      platform.broadcastPtyData(args[0] as string, args[1] as string);
      continue;
    }
    platform.broadcast(ipcChannel, ...args);
  }
  // The two M1-added channels flow through their dedicated seam entry points.
  platform.notify({
    wsId: 'ws-fixture-git',
    kind: 'finished',
    title: 'Agent finished',
    body: 'repo · main is ready for review',
  });
  platform.openAccountLoginUrl(
    'acct-fixture-1',
    'https://claude.ai/oauth/authorize?client_id=fixture',
    'Fixture Account',
  );

  setUiClientSink(null);
  for (const { channel, args } of captured.values()) {
    writeFixture(`event.${channel}.json`, { channel, args: normalize(args) });
    eventsCaptured.push(channel);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  seed();
  // Clear only the capture files this script owns (*.json). A blanket rm -rf
  // would also delete hand-written companions living in the fixtures dir —
  // the Rust crate's README.md — making a regen dirty the tree.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (name.endsWith('.json')) fs.rmSync(path.join(OUT_DIR, name), { force: true });
  }
  await store.load();
  await captureMethods();
  await captureEvents();
  writeFixture('manifest.json', {
    generatedBy: 'scripts/dump-rpc-fixtures.ts (pnpm run fixtures:rpc)',
    baseDir: BASE,
    methods: methodsCaptured.sort(),
    events: eventsCaptured.sort(),
    skipped: SKIPPED,
  });
  process.stdout.write(
    `wrote ${methodsCaptured.length} method + ${eventsCaptured.length} event fixtures to ${OUT_DIR}\n`,
  );
  // mergeWorktree left an 80ms submit timer behind; exit deliberately.
  process.exit(0);
}

void main().catch((e) => {
  process.stderr.write(`fixture dump failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
