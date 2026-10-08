// #291 — source-binding gate (the resume-guard-binding.test.ts pattern): agent-sdk.ts cannot load under `node --test`,
// so this reads the SHIPPED source and asserts the relay decision actually reaches the keeper's spawn frame. The
// decision itself is proven in docker-relay-switch.test.ts / shared/docker-relay.test.ts; a green decision suite says
// nothing if the one `makeKeeperSpawn(` call site never passes it, or the facade never puts it on the frame.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentSdk = readFileSync(path.join(here, 'agent-sdk.ts'), 'utf8');
const keeperClient = readFileSync(path.join(here, 'keeper-client.ts'), 'utf8');
const live = (src: string, needle: string): boolean =>
  src.split('\n').some((l) => l.includes(needle) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));

test('the ONE keeper-spawn site passes the run-switch decision (frozen switch → relay spec) as the facade\'s 3rd argument', () => {
  assert.equal(agentSdk.match(/makeKeeperSpawn\(/g)?.length, 1, 'exactly one call site (the import line has no paren)');
  // #320 appended a 4th argument (the memory cap) on the following lines: the relay decision is still the 3rd, and the call still ends `) as never,`.
  assert.ok(live(agentSdk, '}, dockerRelaySpecFor(sdkEnv.ORCHESTRA_RUN_ID, remote),'), 'makeKeeperSpawn must receive dockerRelaySpecFor(<the run id the CLI sees>, remote)');
  assert.ok(live(agentSdk, "from './docker-relay-switch.ts'"));
  // must-FAIL arm: a body that merely imports it must not satisfy "wired"
  assert.ok(!live("// }, dockerRelaySpecFor(sdkEnv.ORCHESTRA_RUN_ID, remote),", '}, dockerRelaySpecFor('));
});

test('the facade puts dockerRelay on the spawn frame ONLY when given one (absent ⇒ today\'s frame)', () => {
  assert.ok(live(keeperClient, '...(dockerRelay ? { dockerRelay } : {}),'), 'spawn frame must carry dockerRelay conditionally');
  assert.ok(live(keeperClient, 'dockerRelay?: DockerRelaySpec,'), 'makeKeeperSpawn must accept the optional spec');
});
