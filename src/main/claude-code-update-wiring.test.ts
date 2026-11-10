import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '../..', p), 'utf8');

test('« Mise à jour disponible » wiring: channels in lockstep, started + stopped with the app, mounted above the sidebar footer, desktop only', () => {
  const host = read('src/main/claude-code-update-host.ts'), preload = read('src/preload/index.ts'), index = read('src/main/index.ts');
  for (const [name, channel] of [['PULL', 'state'], ['PUSH', 'update'], ['RUN', 'run'], ['ACK', 'ack']]) {
    assert.match(host, new RegExp(`CLAUDE_CODE_UPDATE_${name}_CHANNEL = 'claudeCodeUpdate:${channel}'`));
  }
  assert.match(preload, /claudeCodeUpdateState: \(\) => ipcRenderer\.invoke\('claudeCodeUpdate:state'\)/);
  assert.match(preload, /ipcRenderer\.on\('claudeCodeUpdate:update', listener\)/);
  assert.match(preload, /runClaudeCodeUpdate: \(\) => ipcRenderer\.invoke\('claudeCodeUpdate:run'\)/);
  assert.match(preload, /ackClaudeCodeUpdate: \(\) => ipcRenderer\.invoke\('claudeCodeUpdate:ack'\)/);
  assert.match(read('src/main/api-handlers.ts'), /\| 'claudeCodeUpdateState'\s*\| 'runClaudeCodeUpdate'\s*\| 'ackClaudeCodeUpdate'/, 'not in the generic served table');
  assert.match(index, /^registerClaudeCodeUpdateIpc\(\);/m);
  assert.match(index, /^\s+startClaudeCodeUpdate\(\);/m);
  assert.match(index, /^\s+stopClaudeCodeUpdate\(\);/m);
  // above the footer and above the two warning strips (their own harnesses anchor on « strip, then footer »)
  const sb = read('src/renderer/components/Sidebar.tsx');
  const at = (needle: string) => { const i = sb.indexOf(needle); assert.ok(i >= 0 && sb.indexOf(needle, i + 1) < 0, `${needle} appears exactly once`); return i; };
  assert.ok(at('<UsageBars />') < at('<ClaudeCodeUpdateStrip />') && at('<ClaudeCodeUpdateStrip />') < at('<PauseUnreadableStrip />') && at('<PauseUnreadableStrip />') < at('<div className="sidebar-footer">'));
  // the human's gesture, on the desktop: neither the phone nor an agent (hooks socket / CLI) can see or start it
  for (const f of ['src/main/acces-mobile-routes.ts', 'src/acces-mobile/page.ts', 'src/main/hooks-server.ts', 'src/cli/index.ts']) {
    assert.doesNotMatch(read(f), /claudeCodeUpdate|claude-code-update/i, `${f} stays out of it`);
  }
  // the command runs under no Compte and is `claude update`, nothing else
  assert.match(host, /runClaudeUpdate\(bin, \{ env: updateCommandEnv\(\), cwd: os\.homedir\(\), timeoutMs: UPDATE_TIMEOUT_MS \}\)/);
  assert.match(read('src/main/claude-code-update.ts'), /spawn\(bin, \['update'\], \{ env, cwd, stdio: \['ignore', 'pipe', 'pipe'\] \}\)/);
});
