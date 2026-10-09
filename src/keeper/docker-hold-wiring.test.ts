// #321 R13 (verifier M1): the PRODUCTION wiring of the fleet-wide release slot and the fleet's line in keeper/index.ts. The built-keepers case ('TWO keepers share ONE release slot') cannot tell the two apart — either
// piece alone spaces two creates by the settle — so a `lease:` or `fleet:` left unwired survived every unit test (mutants K01/K02) and only the real-dockerd rig `hold_two_keepers` killed them. These source pins close that gap
// (same idiom as the other *-wiring tests): the gate receives BOTH, and each is built from the file the OTHER keepers share.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = fs.readFileSync(path.join(REPO, 'src', 'keeper', 'index.ts'), 'utf8');
const body = (decl: string): string => {
  const i = SRC.indexOf(decl);
  assert.ok(i >= 0, `${decl} exists in keeper/index.ts`);
  const j = SRC.indexOf('\n}\n', i);
  return SRC.slice(i, j);
};

test('#321 K01/K02: the keeper\'s hold gate is given the release slot (`lease`) AND the fleet\'s line (`fleet`), both built from the SAME holdState', () => {
  const gate = body('function createKeeperHoldGate(holdState: string): HoldGate {');
  assert.match(gate, /\n\s*lease: createKeeperLease\(holdState\),/, 'K01: the gate is handed the fleet-wide release slot');
  assert.match(gate, /\n\s*fleet: createKeeperFleetLine\(holdState\),/, 'K02: the gate is handed the fleet\'s line');
  assert.match(gate, /stateFile: holdState,/);
  assert.match(gate, /holdFile: relayHoldFile\(sockPath\),/, 'what THIS keeper holds is published beside the others\' (the line reads them)');
});

test('#321 K01: the slot is the lease file BESIDE the app\'s state file, owned by this keeper\'s workspace and pid, over the shared fs effects', () => {
  const lease = body('function createKeeperLease(holdState: string) {');
  assert.match(lease, /createReleaseLease\(\{ file: admissionLeaseFile\(holdState\), owner: wsId, pid: process\.pid, log: klog, io: leaseIo\(\) \}\)/);
});

test('#321 K02: the line reads the OTHER keepers\' `<ws>.docker.hold` files, knows its own by name, and queues behind a slot in motion (the same lease file)', () => {
  const line = body('function createKeeperFleetLine(holdState: string) {');
  assert.match(line, /createFleetLine\(\{ ownHoldFile: relayHoldFile\(sockPath\), ownWs: wsId, pid: process\.pid, leaseFile: admissionLeaseFile\(holdState\), io: leaseIo\(\) \}\)/);
});

test('#321 K01/K02: the gate is built ONLY for a spawn frame that carries `holdState` and handed to the relay (no state ⇒ the relay never holds)', () => {
  const w = body('async function withDockerRelay(');
  assert.match(w, /const gate = holdState \? createKeeperHoldGate\(holdState\) : null;/);
  assert.match(w, /createDockerRelay\(\{[^}]*\.\.\.\(gate \? \{ hold: gate \} : \{\}\)[^}]*\}\)/, 'the relay gets the gate');
  assert.match(SRC, /withDockerRelay\(f\.dockerRelay\.runId, capEnv, f\.dockerRelay\.holdState\)/, 'the frame\'s holdState reaches it');
});
