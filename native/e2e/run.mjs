// E2E scenario runner for the native GTK app (plan §8.5/§8.6).
//
//   node native/e2e/run.mjs            # run all scenarios
//   node native/e2e/run.mjs <name>...  # run named scenarios only
//
// Drives the REAL orchestra-gtk binary via its remote-control socket inside a
// private headless sway (see harness.mjs). Scenarios that depend on an
// unmerged workstream (the persistent RpcBackend transport that carries live
// workspace/PTY traffic) SKIP with a reason rather than fail — the harness is
// here so they light up the moment that wiring lands.
//
// Exit code: 0 if every non-skipped scenario passed, 1 otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import {
  REPO_ROOT,
  resolveGtkBin,
  startHeadlessSway,
  launchGtk,
  mkTmp,
  waitFor,
  sleep,
  installExitCleanup,
} from './harness.mjs';
import { startFakeBackend } from './fake-backend.mjs';

// The crate version = the repo package.json version (build.rs lockstep). The
// warning/attach scenarios compare against it.
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

const SHOT_DIR = process.env.E2E_SHOT_DIR || mkTmp('shots');

// ---- scenario registry ------------------------------------------------------

const scenarios = [];
const scenario = (name, fn, { skip } = {}) => scenarios.push({ name, fn, skip });

/** Find a widget node by name in the list_widgets tree. */
function findNode(tree, name) {
  for (const root of tree.widgets || []) {
    const hit = walk(root, name);
    if (hit) return hit;
  }
  return null;
  function walk(node, target) {
    if (node.name === target) return node;
    for (const c of node.children || []) {
      const h = walk(c, target);
      if (h) return h;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scenario: version-mismatch refusal (proto mismatch → refusal dialog, no
// attach). Runnable NOW — exercises probe_backend + app.rs AttachUpdate::Refused.
// ---------------------------------------------------------------------------
scenario('version-mismatch-refusal', async ({ sway }) => {
  const sockDir = mkTmp('mismatch');
  const uiSock = path.join(sockDir, 'ui.sock');
  const backend = await startFakeBackend(uiSock, { proto: 2, appVersion: '9.9.9', backendKind: 'daemon' });
  const home = mkTmp('mismatch-home');

  const app = await launchGtk({
    sway,
    label: 'mismatch',
    env: { ORCHESTRA_HOME: home, ORCHESTRA_UI_SOCK: uiSock },
  });

  try {
    // The refusal dialog is its own toplevel; wait for its title.
    const title = await waitFor(
      async () => {
        const r = await app.rc.get('dialog-title', 'label').catch(() => null);
        return r && r.ok && /Incompatible backend/i.test(r.value || '') ? r.value : null;
      },
      { desc: 'refusal dialog title', timeoutMs: 12_000 },
    );

    const body = await app.rc.get('dialog-body', 'label');
    assert(/protocol v2/i.test(body.value), `refusal dialog names server proto: ${body.value}`);
    assert(/v1\b/.test(body.value), `refusal dialog names our proto: ${body.value}`);

    // Banner must show the refusal, and NO backend attached (footer stays none).
    const banner = await app.rc.get('backend-banner-text', 'label');
    assert(/refused|incompatible/i.test(banner.value), `banner shows refusal: ${banner.value}`);
    const footer = await app.rc.get('status-text', 'label');
    assert(/backend: none/i.test(footer.value), `footer stays unattached: ${footer.value}`);

    // No name → the harness captures the topmost open dialog (its own
    // toplevel), so the shot shows the whole refusal dialog, not just a label.
    await app.rc.screenshot(path.join(SHOT_DIR, 'version-mismatch-refusal.png')).catch(() => {});
    return `refusal dialog shown ("${title}"), no attach`;
  } finally {
    app.stop();
    await backend.close();
  }
});

// ---------------------------------------------------------------------------
// Scenario: appVersion mismatch is NON-fatal (attach proceeds + warning).
// Runnable NOW.
// ---------------------------------------------------------------------------
scenario('appversion-warning-nonfatal', async ({ sway }) => {
  const sockDir = mkTmp('warn');
  const uiSock = path.join(sockDir, 'ui.sock');
  // proto matches (1) so we attach; appVersion differs → warning, not refusal.
  const backend = await startFakeBackend(uiSock, { proto: 1, appVersion: '0.0.1-old', backendKind: 'electron' });
  const home = mkTmp('warn-home');

  const app = await launchGtk({
    sway,
    label: 'warn',
    env: { ORCHESTRA_HOME: home, ORCHESTRA_UI_SOCK: uiSock },
  });

  try {
    const title = await waitFor(
      async () => {
        const r = await app.rc.get('dialog-title', 'label').catch(() => null);
        return r && r.ok && /Version mismatch/i.test(r.value || '') ? r.value : null;
      },
      { desc: 'version-warning dialog', timeoutMs: 12_000 },
    );

    const body = await app.rc.get('dialog-body', 'label');
    assert(/0\.0\.1-old/.test(body.value), `warning names the backend version: ${body.value}`);
    assert(new RegExp(APP_VERSION.replace(/\./g, '\\.')).test(body.value), `warning names our version: ${body.value}`);

    // Dismiss the warning; the app MUST have attached (footer shows the backend).
    await app.rc.key('Return');
    const footer = await waitFor(
      async () => {
        const r = await app.rc.get('status-text', 'label').catch(() => null);
        return r && r.ok && /backend: electron/i.test(r.value || '') ? r.value : null;
      },
      { desc: 'attached footer after warning', timeoutMs: 6000 },
    );
    return `attached despite version warning ("${title}"), footer: ${footer}`;
  } finally {
    app.stop();
    await backend.close();
  }
});

// ---------------------------------------------------------------------------
// Scenario: daemon auto-spawn attaches (no socket → spawn via
// $ORCHESTRA_DAEMON_CMD → wait for ui-sock → attach). Runnable NOW: the fake
// daemon is a node script that starts a fake backend and writes the pointer.
// ---------------------------------------------------------------------------
scenario('daemon-auto-spawn', async ({ sway }) => {
  const home = mkTmp('spawn-home');
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  const uiSock = path.join(home, 'ui.sock');
  // A one-line daemon: start the fake backend, write <home>/ui-sock, idle.
  const daemonScript = path.join(mkTmp('spawn-cmd'), 'daemon.mjs');
  fs.writeFileSync(
    daemonScript,
    [
      `import { startFakeBackend } from ${JSON.stringify(path.join(REPO_ROOT, 'native', 'e2e', 'fake-backend.mjs'))};`,
      `import fs from 'node:fs';`,
      `const home = process.env.ORCHESTRA_HOME;`,
      `const sock = ${JSON.stringify(uiSock)};`,
      `await startFakeBackend(sock, { proto: 1, appVersion: ${JSON.stringify(APP_VERSION)}, backendKind: 'daemon' });`,
      `fs.writeFileSync(home + '/ui-sock', sock + '\\n');`,
      `setInterval(() => {}, 1e9);`,
    ].join('\n'),
  );

  const app = await launchGtk({
    sway,
    label: 'spawn',
    env: {
      ORCHESTRA_HOME: home,
      // Force the auto-spawn path: no ORCHESTRA_UI_SOCK, discovery fails first.
      ORCHESTRA_DAEMON_CMD: `node ${daemonScript}`,
    },
  });

  try {
    // Reaching a "backend: daemon" footer is itself the proof: the app
    // discovered no socket, ran $ORCHESTRA_DAEMON_CMD, waited for the ui-sock,
    // handshook, and attached. (The banner Revealer stays widget-visible with
    // its child un-revealed, so its `visible` prop can't distinguish the state
    // over the harness — the footer is the authoritative signal.)
    const footer = await waitFor(
      async () => {
        const r = await app.rc.get('status-text', 'label').catch(() => null);
        return r && r.ok && /backend: daemon/i.test(r.value || '') ? r.value : null;
      },
      { desc: 'attached-to-spawned-daemon footer', timeoutMs: 20_000 },
    );
    // The spawn log must exist under the isolated home (proves we spawned it
    // there, not into the real ~/.orchestra).
    assert(
      fs.existsSync(path.join(home, 'logs', 'daemon-spawn.log')),
      'daemon-spawn.log written under the isolated ORCHESTRA_HOME',
    );
    return `auto-spawned daemon and attached, footer: ${footer}`;
  } finally {
    app.stop();
  }
});

// ---------------------------------------------------------------------------
// Scenario: startup dependency warning (M3 P0). The Electron app blocks with a
// "Missing Dependencies" dialog (Continue Anyway / Quit) when git/gh/claude are
// missing; the GTK app had NO deps:status caller at all. After attach it must
// probe deps:status and show the same dialog with the same copy.
// ---------------------------------------------------------------------------
scenario('missing-dependency-warning', async ({ sway }) => {
  const home = mkTmp('deps-home');
  const uiSock = path.join(mkTmp('deps-sock'), 'ui.sock');
  // A backend that reports two missing tools.
  const backend = await startFakeBackend(uiSock, {
    proto: 1,
    appVersion: APP_VERSION,
    backendKind: 'daemon',
    methods: {
      'deps:status': {
        git: true,
        gh: false,
        claude: false,
        messages: ['gh is not installed — PR features will not work', 'claude is not installed'],
      },
    },
  });

  const app = await launchGtk({
    sway,
    label: 'deps',
    env: { ORCHESTRA_HOME: home, ORCHESTRA_UI_SOCK: uiSock },
  });

  try {
    const title = await waitFor(
      async () => {
        const r = await app.rc.get('dialog-title', 'label').catch(() => null);
        return r && r.ok && /Missing Dependencies/i.test(r.value || '') ? r.value : null;
      },
      { desc: 'missing-dependency dialog', timeoutMs: 15_000 },
    );
    const body = await app.rc.get('dialog-body', 'label');
    // Electron's exact message line + both backend-supplied detail messages.
    assert(
      /Orchestra requires the following tools:/i.test(body.value),
      `dialog uses Electron's message copy: ${body.value}`,
    );
    assert(/gh is not installed/.test(body.value), `dialog lists the gh message: ${body.value}`);
    assert(/claude is not installed/.test(body.value), `dialog lists the claude message: ${body.value}`);
    // Electron's buttons: Continue Anyway (confirm) / Quit (cancel).
    const confirmBtn = await app.rc.get('dialog-confirm', 'label');
    const cancelBtn = await app.rc.get('dialog-cancel', 'label');
    assert(/Continue Anyway/i.test(confirmBtn.value || ''), `confirm button: ${confirmBtn.value}`);
    assert(/Quit/i.test(cancelBtn.value || ''), `cancel button: ${cancelBtn.value}`);

    await app.rc.screenshot(path.join(SHOT_DIR, 'missing-dependency-warning.png')).catch(() => {});

    // "Continue Anyway" dismisses and leaves the app attached.
    await app.rc.click('dialog-confirm');
    const footer = await waitFor(
      async () => {
        const r = await app.rc.get('status-text', 'label').catch(() => null);
        return r && r.ok && /backend: daemon/i.test(r.value || '') ? r.value : null;
      },
      { desc: 'still attached after Continue Anyway', timeoutMs: 8000 },
    );
    return `"${title}" shown with Electron's copy + buttons; Continue Anyway keeps it attached (${footer})`;
  } finally {
    app.stop();
    await backend.close();
  }
});

// ---------------------------------------------------------------------------
// Scenario: the UI must not contradict itself while reconnecting (M4 D1a,
// gate criterion 5). The client owns the retry, so `self.backend` stays Some
// during a reconnect and only Disconnected clears it — which made the footer
// keep claiming "backend: daemon v0.5.84" while the banner said connecting.
//
// The assertion fires DURING the reconnecting window, not after recovery: an
// end-state-only check passes trivially and proves nothing.
// ---------------------------------------------------------------------------
scenario('footer-not-stale-while-reconnecting', async ({ sway }) => {
  const home = mkTmp('stalefooter-home');
  const uiSock = path.join(mkTmp('stalefooter-sock'), 'ui.sock');
  const backend = await startFakeBackend(uiSock, {
    proto: 1,
    appVersion: APP_VERSION,
    backendKind: 'daemon',
  });

  const app = await launchGtk({
    sway,
    label: 'stalefooter',
    env: { ORCHESTRA_HOME: home, ORCHESTRA_UI_SOCK: uiSock },
  });

  try {
    // Attached: footer names the daemon.
    const attached = await waitFor(
      async () => {
        const r = await app.rc.get('status-text', 'label').catch(() => null);
        return r && r.ok && /backend: daemon/i.test(r.value || '') ? r.value : null;
      },
      { desc: 'initial attach', timeoutMs: 20_000 },
    );

    // Drop the live connection WITHOUT closing the listener: the client goes to
    // Reconnecting (and can succeed again later — we only need the window).
    backend.dropConnections();

    // Catch the app INSIDE the reconnecting window and assert the two surfaces
    // agree. Poll fast: the window is real but short.
    const observed = await waitFor(
      async () => {
        const b = await app.rc.get('backend-banner-text', 'label').catch(() => null);
        if (!b || !b.ok || !/reconnect/i.test(b.value || '')) return null;
        const f = await app.rc.get('status-text', 'label').catch(() => null);
        return f && f.ok ? { banner: b.value, footer: f.value } : null;
      },
      { desc: 'the reconnecting window', timeoutMs: 30_000, intervalMs: 50 },
    );

    // THE BUG: footer claiming a live backend while the banner says reconnecting.
    assert(
      !/backend: (daemon|electron)\b/i.test(observed.footer),
      `footer must not claim an attached backend while reconnecting — ` +
        `banner="${observed.banner}" footer="${observed.footer}"`,
    );
    await app.rc
      .screenshot(path.join(SHOT_DIR, 'footer-not-stale-while-reconnecting.png'))
      .catch(() => {});
    return `during reconnect: banner="${observed.banner}" footer="${observed.footer}" (was "${attached}")`;
  } finally {
    app.stop();
    await backend.close();
  }
});

// ---------------------------------------------------------------------------
// Scenario: reconnect to a NEW socket path (M3 P1). The daemon's socket is
// pid-derived, so a backend restart moves it. RpcBackend::connect builds its
// client with RpcClient::discover, so every reconnect attempt re-resolves the
// pointer — the app must re-attach within seconds, NOT sit on the dead path
// for the client's full ~3 min give-up.
// ---------------------------------------------------------------------------
scenario('reconnect-new-socket-path', async ({ sway }) => {
  const home = mkTmp('reattach-home');
  const sockA = path.join(home, 'ui-a.sock');
  const sockB = path.join(home, 'ui-b.sock');

  // Backend #1 on sockA; pointer names it.
  let backend = await startFakeBackend(sockA, {
    proto: 1,
    appVersion: APP_VERSION,
    backendKind: 'daemon',
  });
  fs.writeFileSync(path.join(home, 'ui-sock'), sockA + '\n');

  // No ORCHESTRA_UI_SOCK: discovery must go through the POINTER file, which is
  // what moves when the backend restarts.
  const app = await launchGtk({ sway, label: 'reattach', env: { ORCHESTRA_HOME: home } });

  try {
    await waitFor(
      async () => {
        const r = await app.rc.get('status-text', 'label').catch(() => null);
        return r && r.ok && /backend: daemon/i.test(r.value || '') ? r.value : null;
      },
      { desc: 'initial attach to socket A', timeoutMs: 20_000 },
    );

    // Restart the backend on a DIFFERENT path and repoint the pointer file —
    // exactly what a daemon restart under a new pid does.
    await backend.close();
    fs.rmSync(sockA, { force: true });
    backend = await startFakeBackend(sockB, {
      proto: 1,
      appVersion: APP_VERSION,
      backendKind: 'daemon',
    });
    fs.writeFileSync(path.join(home, 'ui-sock'), sockB + '\n');

    // Must re-attach FAST (well inside the client's give-up). A generous 30 s
    // bound still fails loudly if the old pinned-path behavior regresses (that
    // path only recovers after ~3 min).
    const t0 = Date.now();
    await waitFor(
      async () => {
        const r = await app.rc.get('status-text', 'label').catch(() => null);
        return r && r.ok && /backend: daemon/i.test(r.value || '') ? r.value : null;
      },
      { desc: 're-attach after the socket moved', timeoutMs: 30_000 },
    );
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    return `re-attached to the moved socket in ~${secs}s (old behavior: ~180s give-up)`;
  } finally {
    app.stop();
    await backend.close();
  }
});

// ---------------------------------------------------------------------------
// Scenario: same-path reconnect is UNREGRESSED (the other direction the M3 fix
// must not break). The backend restarts on the SAME socket path; discovery
// returns that same path, so the app re-attaches as before.
// ---------------------------------------------------------------------------
scenario('reconnect-same-socket-path', async ({ sway }) => {
  const home = mkTmp('samepath-home');
  const sock = path.join(home, 'ui.sock');

  let backend = await startFakeBackend(sock, {
    proto: 1,
    appVersion: APP_VERSION,
    backendKind: 'daemon',
  });
  fs.writeFileSync(path.join(home, 'ui-sock'), sock + '\n');

  const app = await launchGtk({ sway, label: 'samepath', env: { ORCHESTRA_HOME: home } });

  try {
    await waitFor(
      async () => {
        const r = await app.rc.get('status-text', 'label').catch(() => null);
        return r && r.ok && /backend: daemon/i.test(r.value || '') ? r.value : null;
      },
      { desc: 'initial attach', timeoutMs: 20_000 },
    );

    // Bounce the backend on the SAME path (pointer unchanged).
    await backend.close();
    fs.rmSync(sock, { force: true });
    await sleep(500);
    backend = await startFakeBackend(sock, {
      proto: 1,
      appVersion: APP_VERSION,
      backendKind: 'daemon',
    });

    const t0 = Date.now();
    await waitFor(
      async () => {
        const r = await app.rc.get('status-text', 'label').catch(() => null);
        return r && r.ok && /backend: daemon/i.test(r.value || '') ? r.value : null;
      },
      { desc: 're-attach on the same path', timeoutMs: 30_000 },
    );
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    return `same-path reconnect unregressed (~${secs}s)`;
  } finally {
    app.stop();
    await backend.close();
  }
});

// ---------------------------------------------------------------------------
// Scenario: backend-lock mutual exclusion (a second backend refuses to start
// while one owns the home). Uses the REAL daemon (dist-electron/daemon.js) —
// SKIPS if it isn't built, since the lock logic under test lives there.
// ---------------------------------------------------------------------------
scenario(
  'backend-lock-mutual-exclusion',
  async () => {
    const daemonJs = path.join(REPO_ROOT, 'dist-electron', 'daemon.js');
    const home = mkTmp('lock-home');
    // Start daemon #1, wait for its ui-sock, then start #2 and assert it
    // refuses with the "already owns" message and exits non-zero.
    const first = spawnDaemon(daemonJs, home);
    try {
      await waitFor(() => fs.existsSync(path.join(home, 'ui-sock')), {
        desc: 'first daemon ui-sock',
        timeoutMs: 15_000,
      });
      const second = runDaemonToExit(daemonJs, home);
      assert(second.code !== 0, `second daemon exits non-zero (got ${second.code})`);
      assert(/already owns/i.test(second.output), `second daemon reports lock: ${second.output.slice(0, 400)}`);
      return `second backend refused the home (exit ${second.code})`;
    } finally {
      first.stop();
    }
  },
  {
    skip: () =>
      fs.existsSync(path.join(REPO_ROOT, 'dist-electron', 'daemon.js'))
        ? null
        : 'dist-electron/daemon.js not built — run `pnpm run build:daemon` (lock logic lives in the TS backend)',
  },
);

// ---------------------------------------------------------------------------
// Scenario: coexistence — Electron + GTK attached to the SAME home, a change
// visible in both within 1s and a PTY typed from either rendering in both.
// SKIPPED: the single-consumer fan-out this depends on is now MERGED and is
// already covered end-to-end against a real daemon by the B1 live-daemon
// scripts (native/orchestra-gtk/scripts/sidebar_{live_drive,late_attach}.sh —
// see README). What remains is driving BOTH an Electron instance and the GTK
// app simultaneously and asserting cross-mirroring, which needs an Electron
// build in the loop; that's future work, not a gap in the merged transport.
// ---------------------------------------------------------------------------
scenario(
  'coexistence-live-update',
  async () => {
    throw new Error('unreachable: skipped');
  },
  {
    skip: () =>
      'Electron+GTK SIMULTANEOUS mirroring needs an Electron instance in the loop (future work). ' +
      'The underlying single-consumer fan-out IS merged and is covered against a real daemon by ' +
      'native/orchestra-gtk/scripts/sidebar_{live_drive,late_attach}.sh (see README).',
  },
);

// ---- assert + main ----------------------------------------------------------

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// Minimal daemon spawn helpers (only used by the backend-lock scenario).
function spawnDaemon(daemonJs, home) {
  const child = spawn('node', [daemonJs], {
    env: { ...process.env, ORCHESTRA_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  return {
    stop() {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
    },
  };
}
function runDaemonToExit(daemonJs, home) {
  try {
    const output = execFileSync('node', [daemonJs], {
      env: { ...process.env, ORCHESTRA_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 10_000,
    });
    return { code: 0, output };
  } catch (e) {
    return { code: e.status ?? 1, output: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

async function main() {
  // Reap any compositor/app we start, even on a throw or Ctrl-C — otherwise a
  // failed run leaves stray processes and stale wayland sockets behind, and the
  // NEXT run can pick a dead display and hang.
  installExitCleanup();
  const only = process.argv.slice(2);
  const selected = only.length ? scenarios.filter((s) => only.includes(s.name)) : scenarios;
  if (!selected.length) {
    console.error(`no scenarios matched ${JSON.stringify(only)}`);
    console.error(`available: ${scenarios.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  console.log(`orchestra-gtk: ${resolveGtkBin()}`);
  console.log(`app version:   ${APP_VERSION}`);
  console.log(`screenshots:   ${SHOT_DIR}\n`);

  // Bring up ONE headless sway for the whole run (scenarios needing a window
  // share it; backend-only scenarios ignore it).
  let sway = null;
  const needsDisplay = selected.some((s) => !s.skip || !s.skip());
  if (needsDisplay) {
    try {
      sway = await startHeadlessSway();
      console.log(`headless sway: WAYLAND_DISPLAY=${sway.waylandDisplay}\n`);
    } catch (e) {
      console.error(`could not start headless sway: ${e.message}`);
      process.exit(1);
    }
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const s of selected) {
    const reason = s.skip ? s.skip() : null;
    if (reason) {
      console.log(`SKIP  ${s.name}\n      ${reason}\n`);
      skipped++;
      continue;
    }
    const t0 = Date.now();
    try {
      const detail = await s.fn({ sway });
      const ms = Date.now() - t0;
      console.log(`PASS  ${s.name}  (${ms}ms)\n      ${detail || ''}\n`);
      passed++;
    } catch (e) {
      const ms = Date.now() - t0;
      console.log(`FAIL  ${s.name}  (${ms}ms)\n      ${e.message}\n`);
      failed++;
    }
  }
  if (sway) sway.stop();

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
