#!/usr/bin/env node
// PARITY GATE for #17 — the SDK-backed session discovery must see EXACTLY the
// sessions the old hand-rolled transcript-dir scan saw, on a REAL multi-account
// home.
//
// Why this exists as a script and not a unit test: the interesting failure mode
// is environmental (per-account `CLAUDE_CONFIG_DIR`s, promoted workspaces,
// sibling worktrees), so it can only be measured against a real
// ~/.config/orchestra store with real transcripts on disk. It is therefore NOT
// part of `pnpm run test` — run it explicitly:
//
//     node scripts/verify-session-discovery-parity.mjs
//
// It SKIPS (exit 0, loudly) rather than fails when there is no multi-account
// home to measure — a machine without one has nothing to say about parity, and
// a green tick there would be a vacuous pass.
//
// What it asserts, per workspace with transcripts on disk:
//   • set equality  — SDK-listed session ids == on-disk *.jsonl ids
//   • the pin works — listing with CLAUDE_CONFIG_DIR unset must NOT silently
//                     satisfy the comparison (positive control)
//   • both accounts are actually exercised (guards a single-account vacuous pass)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const STORE = path.join(os.homedir(), '.config/orchestra/orchestra/store.json');
const mangle = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const require_ = createRequire(import.meta.url);

function skip(why) {
  console.log(`SKIP — ${why}`);
  console.log('(nothing measured; this is not a pass)');
  process.exit(0);
}

if (!fs.existsSync(STORE)) skip(`no Orchestra store at ${STORE}`);

const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
const accounts = Object.fromEntries(
  (store.accounts ?? []).map((a) => [a.id, a.configDir.replace('~', os.homedir())]),
);
if (Object.keys(accounts).length < 2) skip('fewer than 2 accounts — not a multi-account home');

// Resolve the SDK the same way the app does (pure ESM, dynamic import).
const sdkPath = require_.resolve('@anthropic-ai/claude-agent-sdk');
const { listSessions } = await import(sdkPath);
const { scopeSessionsToWorktree } = await import('../src/shared/session-discovery.ts');

let workspaces = 0,
  sdkTotal = 0,
  scanTotal = 0,
  onlyScan = 0,
  onlySdk = 0,
  unpinnedTotal = 0;
const accountsSeen = new Set();
const failures = [];
const prev = process.env.CLAUDE_CONFIG_DIR;

try {
  for (const w of store.workspaces ?? []) {
    if (!w.worktreePath || !w.accountId || !accounts[w.accountId]) continue;
    const tdir = path.join(accounts[w.accountId], 'projects', mangle(w.worktreePath));
    if (!fs.existsSync(tdir)) continue;
    const scan = new Set(
      fs
        .readdirSync(tdir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.slice(0, -6)),
    );
    if (!scan.size) continue;

    // ARM: pinned to the workspace's account config dir (what the app does).
    process.env.CLAUDE_CONFIG_DIR = accounts[w.accountId];
    const raw = await listSessions({
      dir: w.worktreePath,
      includeWorktrees: false,
      includeProgrammatic: true,
    });
    const sdk = new Set(scopeSessionsToWorktree(raw, w.worktreePath).map((s) => s.sessionId));

    // CONTROL: unset -> resolves ~/.claude, which on a pinned-account home
    // holds nothing. If this matched, the pin would be doing no work and the
    // whole comparison would be meaningless.
    delete process.env.CLAUDE_CONFIG_DIR;
    const unpinned = await listSessions({
      dir: w.worktreePath,
      includeWorktrees: false,
      includeProgrammatic: true,
    });
    unpinnedTotal += unpinned.length;

    workspaces++;
    accountsSeen.add(w.accountId);
    sdkTotal += sdk.size;
    scanTotal += scan.size;
    const missA = [...scan].filter((x) => !sdk.has(x));
    const missB = [...sdk].filter((x) => !scan.has(x));
    onlyScan += missA.length;
    onlySdk += missB.length;
    if (missA.length || missB.length) {
      failures.push(`  ${w.name}\n    onlyScan=${missA.join(',')}\n    onlySdk=${missB.join(',')}`);
    }
  }
} finally {
  if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prev;
}

console.log(
  `measured: workspaces=${workspaces} accounts=${accountsSeen.size} ` +
    `sdk=${sdkTotal} scan=${scanTotal} onlyScan=${onlyScan} onlySdk=${onlySdk} ` +
    `unpinnedControl=${unpinnedTotal}`,
);

let bad = false;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) bad = true;
};

if (workspaces === 0) skip('no workspace had transcripts on disk');
check(scanTotal > 0, `positive control: the on-disk scan found sessions (${scanTotal})`);
check(accountsSeen.size >= 2, `both accounts exercised (${accountsSeen.size})`);
check(unpinnedTotal === 0, `control: unpinned CLAUDE_CONFIG_DIR sees nothing (${unpinnedTotal})`);
check(onlyScan === 0, `SDK missed nothing the scan found (${onlyScan})`);
check(onlySdk === 0, `SDK invented nothing the scan lacks (${onlySdk})`);
check(sdkTotal === scanTotal, `set sizes equal (${sdkTotal} == ${scanTotal})`);

if (failures.length) {
  console.log('\nmismatches:');
  for (const f of failures) console.log(f);
}
console.log(bad ? '\nPARITY FAILED' : '\nPARITY OK');
process.exit(bad ? 1 : 0);
