// The published shebang (#!/usr/bin/env node) is injected by the build via the
// rollup output banner in vite.cli.config.ts, not kept in source — esbuild's
// transpile step errors on an in-source shebang once the banner is also added.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// Standalone Node.js CLI client for the Orchestra Electron app. It speaks plain
// HTTP POST over the app's Unix socket using Node's `http.request` with the
// `{ socketPath }` option — no Electron, no extra npm deps, no `curl`.
//
// Every route answers JSON of shape `{ ok: boolean, ... }` or
// `{ ok: false, error }`. On `ok: false` (or a non-2xx status) we print the
// error to stderr and exit 1; on success we exit 0.

interface OrchestraResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

interface PeerInfo {
  id: string;
  branch: string;
  repo: string;
  status: string;
  running?: boolean;
  lastTask?: string;
  /** Present only when `--stats` was requested; null = not computable. */
  diff?: { files: number; insertions: number; deletions: number } | null;
}

/**
 * Resolve the Orchestra Unix socket path with this exact precedence:
 *   1. the ORCHESTRA_SOCK environment variable, if set;
 *   2. else the contents of the well-known pointer file at
 *      `~/.orchestra/sock`, whose body is the absolute socket path (trimmed);
 *   3. else throw — Orchestra does not appear to be running.
 */
function getSocketPath(): string {
  // (1) Explicit override always wins.
  const fromEnv = process.env.ORCHESTRA_SOCK;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  // (2) Well-known pointer file: its *contents* are the socket path. Honor
  // ORCHESTRA_HOME so a dev terminal reaches the dev app — same override the
  // app's hooks-server applies when writing this file.
  const pointer = process.env.ORCHESTRA_HOME
    ? path.join(process.env.ORCHESTRA_HOME, 'sock')
    : path.join(os.homedir(), '.orchestra', 'sock');
  try {
    const contents = fs.readFileSync(pointer, 'utf8').trim();
    if (contents) return contents;
  } catch {
    /* missing pointer file falls through to the not-running error */
  }
  // (3) Neither source available.
  throw new Error('Orchestra does not appear to be running (no socket found)');
}

/** POST `body` as JSON to `route` over the Unix socket and parse the JSON reply. */
function request(route: string, body: Record<string, unknown>): Promise<OrchestraResponse> {
  const socketPath = getSocketPath();
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: 'POST',
        path: route,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          let parsed: OrchestraResponse;
          try {
            parsed = JSON.parse(data) as OrchestraResponse;
          } catch {
            reject(new Error(`invalid JSON response (HTTP ${status}): ${data.slice(0, 200)}`));
            return;
          }
          // Surface a non-2xx status even if the body lacks an explicit error.
          if (status < 200 || status >= 300) {
            reject(new Error(parsed.error ?? `request failed (HTTP ${status})`));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on('error', (err) => {
      reject(new Error(`could not reach Orchestra socket at ${socketPath}: ${err.message}`));
    });
    req.end(payload);
  });
}

/** Render an array of row objects as a simple left-aligned column table. */
function table(rows: Array<Record<string, string>>, columns: string[]): string {
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((r) => (r[col] ?? '').length)),
  );
  const pad = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  const header = pad(columns);
  const sep = pad(columns.map((_, i) => '-'.repeat(widths[i])));
  const lines = rows.map((r) => pad(columns.map((col) => r[col] ?? '')));
  return [header, sep, ...lines].join('\n');
}

const USAGE = `Orchestra CLI — talk to a running Orchestra app over its Unix socket.

Usage:
  orchestra peers [--stats]                      List the other agent workspaces
                                                 (--stats: + committed diff vs base per peer)
  orchestra read <id> [--lines N]                Print a workspace's transcript
  orchestra message <id> <text...>               Send a prompt to a workspace
  orchestra spawn --task <text> [--repo <path>] [--base <branch>] [--model <model>] [--detached]
                                                 Spawn a new worktree + agent
                                                 (--model: pin the agent's model, e.g. haiku/sonnet/opus;
                                                  --detached: top-level, not nested under the caller)
  orchestra rename <id> <branch>                 Rename a workspace's branch
  orchestra set-base <id> <branch>               Retarget the base branch (Diff/merge target)
  orchestra promote <id>                         Promote a scratch session into an orchestrator
  orchestra attach <id> <parentId>               Nest an existing workspace under an orchestrator
  orchestra detach <id>                          Pop a workspace back out to its own section
  orchestra verify-landed <id> [--into <branch>] Check every commit on a workspace's branch tip
                                                 landed on the target (default: YOUR branch);
                                                 exit 0 = landed, 1 = unmerged commits remain
  orchestra whoami                               Print THIS workspace's own record (id, branch,
                                                 kind, orchestrator role, parent, repo, base)
  orchestra add-repo <path>                       Register a repo by path
  orchestra delete <id> [--yes]                  Delete a workspace (worktree + branch)
  orchestra accounts                              List configured Claude accounts (id + label)
  orchestra migrate-account <id> <accountId>     Migrate a workspace to another account
  orchestra migrate-account <id> --default       Migrate a workspace back to the default login
  orchestra login-url <url>                      (internal) route an account-login browser-open
                                                 to the app's isolated login window
  orchestra --help                               Show this help

Socket discovery (in order):
  1. the ORCHESTRA_SOCK environment variable, if set;
  2. else the contents of ~/.orchestra/sock (the absolute socket path);
  3. else the command fails — Orchestra is not running.`;

/**
 * The caller's own workspace id, when the CLI runs inside an Orchestra agent
 * PTY (orchestra sets $ORCHESTRA_WS_ID there). Routes use it as `from` to
 * exclude yourself from `peers`, attribute a `message` so the peer can reply
 * back, and nest a `spawn`ed worktree under its spawner. A plain human shell
 * has no such env var, so `from` is simply omitted — unchanged behaviour. The
 * route layer (hooks-server) treats a missing `from` as "no caller identity".
 */
/**
 * Resolve the caller's workspace id from an env bag (pure; exported for tests).
 *
 * ORCHESTRA_WS_ID is the primary identity source in a terminal PTY. But in a
 * structured-view (SDK) session it is spool-ownership-gated — buildSdkEnv
 * (agent-sdk.ts) withholds it whenever a terminal PTY already owns the activity
 * spool for this workspace, to avoid two writers corrupting the sidebar status
 * dot. When withheld, identity must still resolve, or `orchestra rename`/`peers`/
 * `message`/`spawn` break in the structured view (the empty-`$ORCHESTRA_WS_ID` →
 * `usage:` failure). ORCHESTRA_WS_ID_IDENTITY is set UNCONDITIONALLY by
 * buildSdkEnv and is never read by the spool hook, so it decouples identity from
 * spool ownership. Precedence: ORCHESTRA_WS_ID wins when both are present (they
 * agree; the PTY case sets only the former), else fall back to the identity var.
 */
export function resolveSelfWorkspaceId(env: {
  ORCHESTRA_WS_ID?: string;
  ORCHESTRA_WS_ID_IDENTITY?: string;
}): string | undefined {
  const id = env.ORCHESTRA_WS_ID || env.ORCHESTRA_WS_ID_IDENTITY;
  return id && id.trim() ? id.trim() : undefined;
}

function selfWorkspaceId(): string | undefined {
  return resolveSelfWorkspaceId(process.env);
}

/** Pull `--flag value` out of args, returning the value and the leftover args. */
function takeFlag(args: string[], flag: string): { value?: string; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { rest: args };
  const value = args[idx + 1];
  const rest = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { value, rest };
}

/** Pull a valueless `--flag` out of args, returning its presence and the leftover args. */
function takeBoolFlag(args: string[], flag: string): { present: boolean; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false, rest: args };
  return { present: true, rest: [...args.slice(0, idx), ...args.slice(idx + 1)] };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  switch (command) {
    case 'peers': {
      const { present: stats, rest } = takeBoolFlag(args, '--stats');
      void rest;
      const res = await request('/peers', { from: selfWorkspaceId(), stats });
      if (!res.ok) fail(res.error ?? 'failed to list peers');
      const peers = (res.peers as PeerInfo[] | undefined) ?? [];
      if (peers.length === 0) {
        process.stdout.write('No peer workspaces.\n');
        return;
      }
      const rows = peers.map((p) => ({
        id: p.id,
        branch: p.branch,
        repo: p.repo,
        status: p.status,
        // `--stats` columns: committed diff vs the peer's base. '?' = not
        // computable (non-git peer or missing ref) — distinct from real zeros.
        ...(stats
          ? {
              files: p.diff ? String(p.diff.files) : '?',
              '+/-': p.diff ? `+${p.diff.insertions}/-${p.diff.deletions}` : '?',
            }
          : {}),
      }));
      const columns = stats
        ? ['id', 'branch', 'repo', 'status', 'files', '+/-']
        : ['id', 'branch', 'repo', 'status'];
      process.stdout.write(`${table(rows, columns)}\n`);
      return;
    }

    case 'read': {
      const { value: lines, rest } = takeFlag(args, '--lines');
      const id = rest[0];
      if (!id) fail('usage: orchestra read <id> [--lines N]');
      const body: Record<string, unknown> = { id };
      if (lines !== undefined) {
        const n = Number(lines);
        if (!Number.isFinite(n)) fail('--lines must be a number');
        body.lines = n;
      }
      const res = await request('/read', body);
      if (!res.ok) fail(res.error ?? 'failed to read transcript');
      if (res.branch) process.stdout.write(`# ${res.branch as string}\n`);
      process.stdout.write(`${(res.transcript as string) ?? ''}\n`);
      return;
    }

    case 'message': {
      const id = args[0];
      const text = args.slice(1).join(' ');
      if (!id || !text) fail('usage: orchestra message <id> <text...>');
      const res = await request('/message', { from: selfWorkspaceId(), to: id, text });
      if (!res.ok) fail(res.error ?? 'failed to deliver message');
      const delivery = (res.delivery as string | undefined) ?? 'ok';
      process.stdout.write(`Delivered (${delivery}).\n`);
      return;
    }

    case 'spawn': {
      const { value: task, rest: r1 } = takeFlag(args, '--task');
      const { value: repo, rest: r2 } = takeFlag(r1, '--repo');
      const { value: base, rest: r3 } = takeFlag(r2, '--base');
      const { value: model, rest: r4 } = takeFlag(r3, '--model');
      const { present: detached, rest: r5 } = takeBoolFlag(r4, '--detached');
      void r5;
      if (!task)
        fail(
          'usage: orchestra spawn --task <text> [--repo <path>] [--base <branch>] [--model <model>] [--detached]',
        );
      // `from` is always sent (it also drives repo inheritance server-side);
      // `detached` tells the server to skip only the parent nesting.
      const body: Record<string, unknown> = { task, from: selfWorkspaceId() };
      if (repo !== undefined) body.repoPath = path.resolve(repo);
      if (base !== undefined) body.baseBranch = base;
      if (model !== undefined) body.model = model;
      if (detached) body.detached = true;
      const res = await request('/spawn', body);
      if (!res.ok) fail(res.error ?? 'failed to spawn workspace');
      // `ok` alone is not proof: a spawn that failed partway (e.g. the git
      // worktree add collided with a stale checkout) has come back ok:true
      // with both fields undefined, and this printed
      // "Spawned undefined on branch undefined" — a SUCCESS line for a failed
      // spawn, which reads as fine in a log and sends nobody looking.
      if (typeof res.id !== 'string' || typeof res.branch !== 'string') {
        fail(
          `spawn reported success but returned no workspace (id=${String(res.id)}, ` +
            `branch=${String(res.branch)}) — check for a stale git worktree with that branch name`,
        );
      }
      process.stdout.write(`Spawned ${res.id} on branch ${res.branch}\n`);
      return;
    }

    case 'rename': {
      const id = args[0];
      const branch = args[1];
      if (!id || !branch) fail('usage: orchestra rename <id> <branch>');
      const res = await request('/rename', { id, branch });
      if (!res.ok) fail(res.error ?? 'failed to rename workspace');
      process.stdout.write(`Renamed to ${res.branch as string}\n`);
      return;
    }

    case 'set-base': {
      const id = args[0];
      const baseBranch = args[1];
      if (!id || !baseBranch) fail('usage: orchestra set-base <id> <branch>');
      // Retargets what the Diff view, diff stats and "merge into X" prompt
      // compute against. Stored state only — does NOT rebase the worktree.
      const res = await request('/setBase', { id, baseBranch });
      if (!res.ok) fail(res.error ?? 'failed to set base branch');
      process.stdout.write(`Base branch set to ${res.baseBranch as string}\n`);
      return;
    }

    case 'promote': {
      const id = args[0];
      if (!id) fail('usage: orchestra promote <id>');
      const res = await request('/promote', { id });
      if (!res.ok) fail(res.error ?? 'failed to promote workspace');
      process.stdout.write(
        `Promoted ${res.id as string}${res.branch ? ` (${res.branch as string})` : ''} to orchestrator\n`,
      );
      return;
    }

    case 'attach': {
      const id = args[0];
      const parentId = args[1];
      if (!id || !parentId) fail('usage: orchestra attach <id> <parentId>');
      const res = await request('/attach', { id, parentId });
      if (!res.ok) fail(res.error ?? 'failed to attach workspace');
      process.stdout.write(
        `Attached ${res.id as string} under orchestrator ${res.parentId as string}\n`,
      );
      return;
    }

    case 'detach': {
      const id = args[0];
      if (!id) fail('usage: orchestra detach <id>');
      // Omitting parentId tells /attach to clear it (detach to own section).
      const res = await request('/attach', { id });
      if (!res.ok) fail(res.error ?? 'failed to detach workspace');
      process.stdout.write(`Detached ${res.id as string}\n`);
      return;
    }

    case 'verify-landed': {
      // The coordinator close-out check: a child's "done"/"merged" report is a
      // claim, not a state (agents keep committing after they report), so this
      // asks git the only question that matters at close — is every commit on
      // the child's branch TIP reachable from the target branch? Exit code is
      // the verdict (0 landed / 1 not), so scripts and briefs can gate on it.
      const { value: into, rest } = takeFlag(args, '--into');
      const id = rest[0];
      if (!id) fail('usage: orchestra verify-landed <id> [--into <branch>]');
      const res = await request('/verifyLanded', { id, from: selfWorkspaceId(), into });
      if (!res.ok) fail(res.error ?? 'failed to verify');
      const unmerged = (res.unmerged as number | undefined) ?? 0;
      const branch = res.branch as string;
      const target = res.target as string;
      if (unmerged === 0) {
        process.stdout.write(
          `LANDED: every commit on ${branch} is on ${target} (0 unmerged)\n`,
        );
        return;
      }
      const commits = (res.commits as string[] | undefined) ?? [];
      process.stdout.write(
        `NOT LANDED: ${unmerged} commit(s) on ${branch} missing from ${target}:\n` +
          `${commits.map((c) => `  ${c}`).join('\n')}\n`,
      );
      process.exit(1);
    }

    case 'whoami': {
      // A workspace's view of its own record. Notably `parent`: an agent has
      // no other in-band way to learn it (peers excludes the caller, and a
      // child promoted BY its parent never sees the promotion) — this is what
      // makes tree-shape rules like "at most one sub-orchestrator level"
      // checkable by the agent they address.
      const id = selfWorkspaceId();
      if (!id) fail('not inside an Orchestra workspace ($ORCHESTRA_WS_ID is not set)');
      const res = await request('/whoami', { id });
      if (!res.ok) fail(res.error ?? 'failed to look up this workspace');
      const orchestrator = res.orchestrator === true;
      const kind = (res.kind as string | undefined) ?? 'worktree';
      const lines = [
        ['id', res.id as string],
        ['name', (res.name as string | undefined) ?? ''],
        ['branch', (res.branch as string | undefined) ?? ''],
        ['kind', kind],
        [
          'orchestrator',
          orchestrator ? (kind === 'worktree' ? 'yes (dual role)' : 'yes') : 'no',
        ],
        ['parent', (res.parentId as string | null | undefined) ?? 'none (top-level)'],
        ['repo', (res.repoPath as string | undefined) || '(none)'],
        ['base', (res.baseBranch as string | undefined) || '(none)'],
      ];
      const w = Math.max(...lines.map(([k]) => k.length));
      process.stdout.write(lines.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join('\n') + '\n');
      return;
    }

    case 'add-repo': {
      const target = args[0];
      if (!target) fail('usage: orchestra add-repo <path>');
      // Resolve to an absolute path before sending so the app receives an
      // unambiguous location regardless of the caller's cwd.
      const abs = path.resolve(target);
      const res = await request('/addRepo', { path: abs });
      if (!res.ok) fail(res.error ?? 'failed to add repo');
      // The app nests the added repo under a `repo` key:
      // { ok: true, repo: { path, name, defaultBranch, ... } }.
      const repo = (res.repo as Record<string, unknown> | undefined) ?? {};
      const name = (repo.name as string | undefined) ?? '';
      const repoPath = (repo.path as string | undefined) ?? abs;
      const defaultBranch = (repo.defaultBranch as string | undefined) ?? '';
      process.stdout.write(`Added repo ${name} (${defaultBranch}) at ${repoPath}\n`);
      return;
    }

    case 'delete': {
      const yes = args.includes('--yes') || args.includes('-y');
      const id = args.find((a) => a !== '--yes' && a !== '-y');
      if (!id) fail('usage: orchestra delete <id> [--yes]');
      // Deleting is destructive — it removes the git worktree and branch. Require
      // an explicit --yes so a stray `delete <id>` can't tear down a workspace,
      // while staying scriptable (no interactive prompt).
      if (!yes) {
        fail(
          `Refusing to delete workspace ${id} without confirmation.\n` +
            `This removes the git worktree and branch. Re-run with --yes to proceed:\n` +
            `  orchestra delete ${id} --yes`,
        );
      }
      const res = await request('/deleteWorkspace', { id });
      if (!res.ok) fail(res.error ?? 'failed to delete workspace');
      const branch = (res.branch as string | undefined) ?? '';
      process.stdout.write(`Deleted workspace ${res.id as string}${branch ? ` (${branch})` : ''}\n`);
      return;
    }

    case 'accounts': {
      const res = await request('/accounts', {});
      if (!res.ok) fail(res.error ?? 'failed to list accounts');
      const accounts =
        (res.accounts as Array<{ id: string; label: string; configDir: string }> | undefined) ?? [];
      if (accounts.length === 0) {
        process.stdout.write('No accounts configured (all workspaces use the default login).\n');
        return;
      }
      const rows = accounts.map((a) => ({ id: a.id, label: a.label, configDir: a.configDir }));
      process.stdout.write(`${table(rows, ['id', 'label', 'configDir'])}\n`);
      return;
    }

    case 'migrate-account': {
      const id = args[0];
      // `--default` (or a bare `-`) clears the pin → default login. Otherwise the
      // second positional is the target account id.
      const toDefault = args.includes('--default');
      const accountId = toDefault ? '' : args[1];
      if (!id || (!toDefault && !accountId)) {
        fail('usage: orchestra migrate-account <id> <accountId> | orchestra migrate-account <id> --default');
      }
      const res = await request('/migrateAccount', { id, accountId: accountId ?? '' });
      if (!res.ok) fail(res.error ?? 'failed to migrate account');
      const target = (res.accountId as string | null | undefined) ?? null;
      const label = target ?? 'default login';
      const resumed = res.resumed === true ? ' (resumed)' : '';
      process.stdout.write(`Migrated ${res.id as string} to ${label}${resumed}\n`);
      return;
    }

    case 'login-url': {
      // Internal: invoked by the xdg-open/open shim inside an account login
      // PTY (see main/cli-shim.ts installLoginBrowserShim). The account id
      // rides on the env the login PTY was spawned with.
      const url = args[0];
      const accountId = process.env.ORCHESTRA_LOGIN_ACCOUNT;
      if (!url) fail('usage: orchestra login-url <url>');
      if (!accountId) fail('ORCHESTRA_LOGIN_ACCOUNT is not set (not inside an account login PTY)');
      const res = await request('/loginUrl', { accountId, url });
      if (!res.ok) fail(res.error ?? 'failed to route login url');
      // Silent on success — this runs behind claude's browser-open, where any
      // stdout would leak into the login TUI.
      return;
    }

    default:
      fail(`unknown command: ${command}\n\n${USAGE}`);
  }
}

/**
 * Run the CLI against `argv` (the command + its args, WITHOUT the node/script
 * prefix). On success the process exits 0; `fail()` exits 1 on any error. This
 * is the entry point both the standalone `bin` and the Electron main process
 * (dual-mode: `Orchestra.AppImage cli …`) call, so the CLI logic lives in one
 * place and the shipped AppImage and a raw `node cli.js` behave identically.
 */
export async function runCli(argv: string[]): Promise<void> {
  try {
    await main(argv);
    process.exit(0);
  } catch (err: unknown) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// Auto-run only as the standalone `bin` (plain Node, `node cli.js …`). When
// this module is bundled into the Electron main process, `runCli()` is called
// explicitly from there instead — and `process.versions.electron` is set, so we
// must NOT also auto-run here (that would fire the CLI on every GUI launch).
//
// The `typeof require` guard keeps this inert under a raw-ESM loader (node
// --test --experimental-strip-types, where `require` is undefined and a bare
// reference would ReferenceError at import) so this module — and its exported
// pure helpers like resolveSelfWorkspaceId — stay unit-testable. Production
// ships as CJS (vite.cli.config.ts formats:['cjs']), where `require` exists and
// this fires exactly as before.
if (
  typeof require !== 'undefined' &&
  !process.versions.electron &&
  require.main === module
) {
  void runCli(process.argv.slice(2));
}
