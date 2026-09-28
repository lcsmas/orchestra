import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Issue #197 — BOUND the boot-wedge self-heal, then ESCALATE.
//
// Drives the REAL `watchdogTick` (session-watchdog.ts) against a REAL faked-CLI
// boot-wedged session through the REAL agent-sdk over a REAL bus (G3: not a pure
// helper). Same subprocess pattern as `session-watchdog.test.ts` — the module
// pulls in `./platform`/`./store`/`agent-sdk.ts`, which can't be imported bare
// under the strip-types runner, so the rig runs as a child and this file asserts
// on its JSON verdict.
//
// The three arms map 1:1 to the ticket's required arms:
//   • bounded  — must-FAIL today: N+1 wedged starts → N+1 restarts, no
//     escalation. The FIX caps at MAX_BOOT_RESTARTS and escalates ONCE.
//   • recovers — a session that recovers on restart k<N is NOT escalated.
//   • reset    — the counter resets after a real turn (proof of life), and a
//     LATER wedge episode escalates again.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RIG = path.join(REPO, 'scripts', 'e2e-boot-heal-bound.mjs');
const REGISTER = path.join(REPO, 'scripts', '.r2-register.mjs');

function runArm(arm: string): Record<string, unknown> {
  const out = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--import', REGISTER, RIG, arm],
    {
      encoding: 'utf8',
      timeout: 180_000,
      cwd: REPO,
      env: { ...process.env, WEDGE_HOME: `/tmp/boot-heal-197-unit-${arm}-${process.pid}` },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  const line = out.trim().split('\n').filter(Boolean).pop();
  // An EMPTY result must never read as a pass (a crashed rig prints nothing).
  assert.ok(line, `arm ${arm} produced no output — the rig did not run`);
  return JSON.parse(line) as Record<string, unknown>;
}

test('the boot-heal rig and its register hook exist', () => {
  assert.ok(fs.existsSync(RIG), `${RIG} missing`);
  assert.ok(fs.existsSync(REGISTER), `${REGISTER} missing`);
});

test('BOUNDED: caps at MAX_BOOT_RESTARTS fresh starts, then escalates ONCE', () => {
  // The must-FAIL arm's positive side: the field ~75s × ∞ loop becomes "3
  // restarts then STOP + one bus escalation to the coordinator + a visible
  // wedged mark". On master (no bound, no escalation path) this arm reads
  // escalations=0 / wedgedMark=false → ok:false (verified against origin/master
  // in a throwaway worktree at nomination time).
  const r = runArm('bounded') as {
    ok: boolean;
    bound: number;
    totalRestarts: number;
    escalationSeries: number[];
    finalEscalations: number;
    escalationBody: string | null;
    wedgedMarkSet: boolean;
  };
  assert.equal(r.totalRestarts, r.bound, 'exactly MAX_BOOT_RESTARTS fresh restarts, then stop');
  assert.equal(r.finalEscalations, 1, 'exactly ONE escalation row to the coordinator');
  assert.equal(r.wedgedMarkSet, true, 'the workspace is marked visibly wedged');
  // Edge-triggered: the escalation-count series must PLATEAU at 1, never climb —
  // one escalation per wedge, not one per tick.
  assert.ok(
    r.escalationSeries.every((n) => n <= 1),
    `escalation must fire once, not per tick: ${JSON.stringify(r.escalationSeries)}`,
  );
  // The body carries the D2 diagnostic — the restart count at minimum.
  assert.match(String(r.escalationBody), new RegExp(`${r.bound} fresh restarts`));
  assert.equal(r.ok, true);
});

test('CO-FIRE (F1): a never-started session with parked mail STILL escalates', () => {
  // reviewer-1bfa79ee F1: a never-started session (firstMessageSeen=false) with
  // parked INBOX mail on a >15-min workspace trips BOTH decideBootWedge AND #88's
  // workspaceQueueStall, so `stalled` is truthy. Keying the #197 give-up on a
  // stall-loses discriminator (`bootWedge && !stalled`) masked the escalation —
  // it fell to the generic flap-limit OS toast, the fleet-invisible surface #197
  // exists to kill. The fix keys on `isBootWedge` PRESENCE. Same assertion as
  // `bounded`, but with parked mail seeded; RED on the pre-fix discriminator
  // (in-place mutant `bootWedge && !stalled`: co_fire → escalations 0 / ok:false,
  // while bounded stays green — verified).
  const r = runArm('co_fire') as {
    ok: boolean;
    bound: number;
    totalRestarts: number;
    finalEscalations: number;
    escalationBody: string | null;
    wedgedMarkSet: boolean;
  };
  assert.equal(r.totalRestarts, r.bound, 'exactly MAX_BOOT_RESTARTS fresh restarts, then stop');
  assert.equal(r.finalEscalations, 1, 'the escalation fires DESPITE the co-firing #88 stall');
  assert.equal(r.wedgedMarkSet, true, 'the workspace is marked visibly wedged');
  assert.match(String(r.escalationBody), new RegExp(`${r.bound} fresh restarts`));
  assert.equal(r.ok, true);
});

test('RECOVERS: a session that comes back on restart k<N is NEVER escalated', () => {
  const r = runArm('recovers') as {
    ok: boolean;
    bound: number;
    totalRestarts: number;
    finalEscalations: number;
    wedgedMarkSet: boolean;
  };
  assert.equal(r.finalEscalations, 0, 'a recovered session is never escalated');
  assert.equal(r.wedgedMarkSet, false, 'never marked wedged');
  assert.ok(r.totalRestarts < r.bound, 'recovered before reaching the bound');
  assert.equal(r.ok, true);
});

test('RESET: proof of life clears the counter; a later wedge escalates again', () => {
  const r = runArm('reset') as {
    ok: boolean;
    secondEpisodeEscalated: boolean;
    revivedClearedMark: boolean;
  };
  assert.equal(r.revivedClearedMark, true, 'the wedged mark clears on a first stream message');
  assert.equal(r.secondEpisodeEscalated, true, 'a fresh wedge episode escalates again (counter reset)');
  assert.equal(r.ok, true);
});
