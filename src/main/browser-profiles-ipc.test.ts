// Profils navigateur (#400, spec story 26): ONLY the human attaches, switches or creates a profile. The registrar
// refuses any sender that is not the app's own window top frame — a panel page, another window, a sub-frame, an
// unknown frame — on EVERY write channel, with nothing reaching the service. Mutants: scripts/mutate-browser-profiles.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_PROFILE_IPC_CHANNELS, registerBrowserProfilesIpc, type ProfileIpcEvent } from './browser-profiles-ipc.ts';
import type { BrowserProfilesService } from './browser-profiles.ts';
import type { BrowserProfileResult } from '../shared/types.ts';

const OK: BrowserProfileResult = { ok: true, profiles: [] };

function rig(mainId: number | null = 5) {
  const handlers = new Map<string, (e: ProfileIpcEvent, ...a: any[]) => unknown>();
  const served: string[] = [];
  const log: string[] = [];
  const svc: BrowserProfilesService = {
    list: () => [],
    create: async (n) => (served.push(`create:${String(n)}`), OK),
    rename: async (i, n) => (served.push(`rename:${String(i)}:${String(n)}`), OK),
    remove: async (i) => (served.push(`delete:${String(i)}`), OK),
    assign: async (w, p) => (served.push(`assign:${String(w)}:${String(p)}`), OK),
  };
  registerBrowserProfilesIpc({
    ipc: { handle: (c, fn) => void handlers.set(c, fn) },
    getMainWebContentsId: () => mainId,
    service: svc,
    log: { warn: (m) => void log.push(`warn:${m}`), error: (m) => void log.push(`error:${m}`) },
  });
  return { handlers, served, log };
}

const frame = {};
/** The app window's own renderer: sender 5, calling from its top frame. */
const human = (): ProfileIpcEvent => ({ sender: { id: 5, mainFrame: frame }, senderFrame: frame });
/** A panel page / another window: a different webContents. */
const panelPage = (): ProfileIpcEvent => ({ sender: { id: 9, mainFrame: frame }, senderFrame: frame });
/** An iframe inside the app window. */
const subFrame = (): ProfileIpcEvent => ({ sender: { id: 5, mainFrame: frame }, senderFrame: {} });
/** The frame was destroyed / unknown. */
const noFrame = (): ProfileIpcEvent => ({ sender: { id: 5, mainFrame: frame }, senderFrame: null });

/** The main window's id but NO frame on either side: `undefined === undefined` must not admit it (review F6 of #400). */
const bareFrame = (): ProfileIpcEvent => ({ sender: { id: 5 }, senderFrame: undefined });

const CALLS: Array<[string, any[]]> = [
  ['browserProfiles:create', ['Staging']],
  ['browserProfiles:rename', ['bp-aaaaaaaaaaaa', 'X']],
  ['browserProfiles:delete', ['bp-aaaaaaaaaaaa']],
  ['browser:profileAttach', ['ws1', 'bp-aaaaaaaaaaaa']],
];

test('the channel table marks exactly the four writers; every channel in it is registered', () => {
  const r = rig();
  assert.deepEqual(
    BROWSER_PROFILE_IPC_CHANNELS.filter((c) => c.writes).map((c) => c.channel).sort(),
    CALLS.map(([c]) => c).sort(),
  );
  assert.deepEqual([...r.handlers.keys()].sort(), BROWSER_PROFILE_IPC_CHANNELS.map((c) => c.channel).sort());
});

for (const [channel, args] of CALLS) {
  test(`${channel}: the human's own window is served`, async () => {
    const r = rig();
    const res = (await r.handlers.get(channel)!(human(), ...args)) as BrowserProfileResult;
    assert.equal(res.ok, true);
    assert.equal(r.served.length, 1);
  });

  for (const [who, mk] of [['a panel page / other window', panelPage], ['a sub-frame of the app window', subFrame], ['an unknown frame', noFrame], ['a main-window sender with NO frame on either side (undefined === undefined)', bareFrame]] as const) {
    test(`${channel}: ${who} is REFUSED and nothing reaches the service`, async () => {
      const r = rig();
      const res = (await r.handlers.get(channel)!(mk(), ...args)) as BrowserProfileResult;
      assert.equal(res.ok, false);
      assert.equal((res as { reason: string }).reason, 'not-human');
      assert.deepEqual(r.served, [], 'the service was never called');
      assert.ok(r.log.some((l) => l.startsWith('warn:') && l.includes(channel)), 'the refusal is logged');
    });
  }

  test(`${channel}: refused while there is no main window at all (fail closed)`, async () => {
    const r = rig(null);
    const res = (await r.handlers.get(channel)!(human(), ...args)) as BrowserProfileResult;
    assert.equal((res as { reason: string }).reason, 'not-human');
    assert.deepEqual(r.served, []);
  });
}

test('the read channel (list) is not a write and is served to any sender', async () => {
  const r = rig();
  assert.deepEqual(await r.handlers.get('browserProfiles:list')!(panelPage()), []);
});

test('an unexpected service failure becomes a refusal the UI can show — the invoke never rejects', async () => {
  const handlers = new Map<string, (e: ProfileIpcEvent, ...a: any[]) => unknown>();
  registerBrowserProfilesIpc({
    ipc: { handle: (c, fn) => void handlers.set(c, fn) },
    getMainWebContentsId: () => 5,
    service: {
      list: () => [],
      create: async () => { throw new Error('boom'); },
      rename: async () => OK, remove: async () => OK, assign: async () => OK,
    },
    log: { warn() {}, error() {} },
  });
  const res = (await handlers.get('browserProfiles:create')!(human(), 'x')) as BrowserProfileResult;
  assert.equal(res.ok, false);
  assert.equal((res as { reason: string }).reason, 'failed');
  assert.match((res as { message: string }).message, /boom/);
});
