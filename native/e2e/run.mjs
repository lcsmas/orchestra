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
import { createHash } from 'node:crypto';
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
/// Per-scenario time budget (ms).
///
/// DELIBERATELY PER-SCENARIO, not one global number. A single budget has to be
/// tuned for the slowest scenario (the reconnect drives legitimately need
/// ~180s+ because they span the client's give-up), which means a hang in a
/// 200ms scenario would wait three minutes to report. That is slow enough that
/// someone eventually RAISES the global budget instead of fixing the hang — the
/// timeout erodes itself. A per-scenario budget stays honest about what that
/// scenario should actually cost, so exceeding it means something.
const DEFAULT_BUDGET_MS = 60_000;

const scenario = (name, fn, { skip, budgetMs } = {}) =>
  scenarios.push({ name, fn, skip, budgetMs: budgetMs ?? DEFAULT_BUDGET_MS });

/// Standard probe for a scenario driving the GTK app: registers a capture that
/// reads the app's own surfaces at the cut. Pass extra fields (child pids, the
/// sockets in play) via `extra`.
///
/// Reads the banner and the footer, and — critically — asks the app for its
/// live ConnectionState, because banner-vs-state disagreement localises a
/// wedge: state Disconnected + banner still "reconnecting" ⇒ app-side
/// delivery/handling; state never left Reconnecting ⇒ client give-up path.
function appProbe(app, extra = () => ({})) {
  // FIELD PROVENANCE. "the rc socket was unreachable", "the widget was not
  // found", and "the label really is an empty string" are THREE DIFFERENT
  // FACTS. Collapsing them into one blank field is how an ambiguous capture
  // produces a confident wrong diagnosis — "banner was empty at the cut" reads
  // as "no banner was shown" when it may mean "we never managed to ask". Since
  // D1b is diagnosed from exactly these fields, every one carries how it was
  // obtained: {status: 'value'|'not-found'|'probe-failed', value?, error?}.
  const field = async (widget, prop) => {
    let r;
    try {
      r = await app.rc.get(widget, prop);
    } catch (e) {
      return { status: 'probe-failed', error: `rc call threw: ${e.message}` };
    }
    if (!r) return { status: 'probe-failed', error: 'no reply from rc socket' };
    if (!r.ok) {
      // The harness says "no widget named …" when it is absent; anything else
      // is a genuine failure to ask.
      return /no widget named/i.test(r.error || '')
        ? { status: 'not-found', error: r.error }
        : { status: 'probe-failed', error: r.error || 'rc returned ok:false' };
    }
    return { status: 'value', value: r.value };
  };

  return async () => {
    const banner = await field('backend-banner-text', 'label');
    const out = {
      // rc liveness is itself a signal: a wedged GTK main loop stops answering.
      // Derived from whether we could ASK, never from what we got back.
      rcSocketAnswers: banner.status !== 'probe-failed',
      banner,
      // The banner LABEL is not reset when the banner is hidden on attach, so a
      // stale string can linger invisibly — reveal state disambiguates "showing
      // this to the user" from "hiding a leftover".
      bannerRevealed: await field('backend-banner', 'visible'),
      footer: await field('status-text', 'label'),
      connectionState: await field('debug-connection-state', 'label'),
      ...extra(),
    };
    // THE CAPTURE MUST FAIL LOUDLY TOO: a partial capture that looks complete
    // is the same trap one layer in. Surface which fields we failed to obtain
    // rather than emitting a block with quiet holes in it.
    const broken = Object.entries(out)
      .filter(([, v]) => v && v.status === 'probe-failed')
      .map(([k, v]) => `${k}: ${v.error}`);
    if (broken.length) out.CAPTURE_INCOMPLETE = broken;
    return out;
  };
}

/// A scenario that blew its budget. Carries the state captured at the cut.
class ScenarioTimeout extends Error {
  constructor(name, budgetMs, capture) {
    super(`exceeded its ${budgetMs}ms budget`);
    this.name = 'ScenarioTimeout';
    this.scenario = name;
    this.capture = capture;
  }
}

/// State captured at the moment we stop waiting.
///
/// The point is to make the give-up a REPORT rather than a verdict. A wedge
/// currently yields no signal at all (0.0% CPU, empty log), so the cut is the
/// one guaranteed moment we can look at the app — this turns a lucky ad-hoc
/// probe into an automatic one.
///
/// `connectionState` and `banner` are captured SIDE BY SIDE because their
/// DISAGREEMENT is the diagnostic: banner is the symptom, ConnectionState is
/// the cause, and which one is stale says where the fault lives.
async function captureAtCut(probe) {
  if (!probe) return { note: 'scenario registered no probe — nothing to capture' };
  try {
    return await Promise.race([
      probe(),
      new Promise((res) => setTimeout(() => res({ note: 'probe itself timed out' }), 5_000)),
    ]);
  } catch (e) {
    return { note: `probe threw: ${e.message}` };
  }
}

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
      { desc: 'refusal dialog title' },
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
      { desc: 'version-warning dialog' },
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
      { desc: 'attached footer after warning' },
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
      { desc: 'attached-to-spawned-daemon footer' },
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
      { desc: 'missing-dependency dialog' },
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
      { desc: 'still attached after Continue Anyway' },
    );
    return `"${title}" shown with Electron's copy + buttons; Continue Anyway keeps it attached (${footer})`;
  } finally {
    app.stop();
    await backend.close();
  }
});

// ---------------------------------------------------------------------------
// SELF-TEST of the timeout instrument (M4 D2a). Deliberately hangs with a live
// app so the harness's own timeout+capture is exercised for real.
//
// This exists because the timeout is an INSTRUMENT, and the question that has
// bitten this project repeatedly applies to it too: how would we know if it
// were lying? A capture that silently recorded empty strings would look like
// evidence and constrain nothing. So this scenario asserts the capture fires
// AND that it read real values off a real app.
//
// It is opt-in (skipped unless E2E_SELFTEST=1) because a deliberate hang costs
// its whole budget — but it must be RUNNABLE on demand, not deleted, so the
// instrument can be re-proven whenever it changes.
// ---------------------------------------------------------------------------
scenario(
  'selftest-timeout-capture',
  async ({ sway, ctl }) => {
    const home = mkTmp('selftest-home');
    const uiSock = path.join(mkTmp('selftest-sock'), 'ui.sock');
    const backend = await startFakeBackend(uiSock, {
      proto: 1,
      appVersion: APP_VERSION,
      backendKind: 'daemon',
    });
    const app = await launchGtk({
      sway,
      label: 'selftest',
      env: { ORCHESTRA_HOME: home, ORCHESTRA_UI_SOCK: uiSock },
    });
    ctl.probe = appProbe(app, () => ({ note: 'selftest: deliberate hang' }));
    try {
      await waitFor(
        async () => {
          const r = await app.rc.get('status-text', 'label').catch(() => null);
          return r && r.ok && /backend: daemon/i.test(r.value || '') ? r.value : null;
        },
        { desc: 'attach before hanging' },
      );
      // Hang forever. The runner's budget must cut this and capture state.
      await new Promise(() => {});
    } finally {
      app.stop();
      await backend.close();
    }
  },
  {
    budgetMs: 8_000,
    skip: () =>
      process.env.E2E_SELFTEST === '1'
        ? null
        : 'instrument self-test — set E2E_SELFTEST=1 to run (deliberately hangs for its full budget)',
  },
);

// ---------------------------------------------------------------------------
// D1b DIAGNOSTIC: what actually happens when the daemon moves to a new socket?
//
// Records the SEQUENCE of (ConnectionState, banner) across the whole window
// rather than sampling where a state is expected — the real wedge has no
// window at all (it never recovers), so any cadence tuned to a short-lived
// state would miss it entirely. Each DISTINCT pair is logged with a timestamp;
// the transitions, or their absence, carry the verdict:
//
//   • state reaches Disconnected, app does not recover  ⇒ app-side
//     start_retry_loop / rediscovery
//   • state never leaves Reconnecting past the give-up  ⇒ client give-up path
//     in orchestra-rpc
//
// Diagnostic only: asserts nothing about recovery, so it reports rather than
// fails. Opt-in because it deliberately runs long.
// ---------------------------------------------------------------------------
scenario(
  'diagnose-reconnect-wedge',
  async ({ sway, ctl }) => {
    const home = mkTmp('diag-home');
    const sockA = path.join(home, 'ui-a.sock');
    const sockB = path.join(home, 'ui-b.sock');
    let backend = await startFakeBackend(sockA, {
      proto: 1,
      appVersion: APP_VERSION,
      backendKind: 'daemon',
    });
    fs.writeFileSync(path.join(home, 'ui-sock'), sockA + '\n');
    const app = await launchGtk({ sway, label: 'diag', env: { ORCHESTRA_HOME: home } });

    const seq = [];
    let last = '';
    const sample = async () => {
      const cap = await appProbe(app)();
      const state = cap.connectionState.status === 'value' ? cap.connectionState.value : `<${cap.connectionState.status}>`;
      const banner = cap.banner.status === 'value' ? cap.banner.value : `<${cap.banner.status}>`;
      const footer = cap.footer.status === 'value' ? cap.footer.value : `<${cap.footer.status}>`;
      const key = `${state}|${banner}|${footer}`;
      if (key !== last) {
        last = key;
        seq.push({ t: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, state, banner, footer });
      }
      return cap;
    };
    ctl.probe = async () => ({ sequence: seq, note: 'D1b diagnostic — see sequence' });

    const t0 = Date.now();
    try {
      await waitFor(
        async () => {
          const r = await app.rc.get('status-text', 'label').catch(() => null);
          return r && r.ok && /backend: daemon/i.test(r.value || '') ? r.value : null;
        },
        { desc: 'initial attach' },
      );
      await sample();

      // Daemon "restarts" on a NEW socket: close the old listener entirely
      // (so nothing can redial it), then serve a different path and repoint.
      await backend.close();
      fs.rmSync(sockA, { force: true });
      backend = await startFakeBackend(sockB, {
        proto: 1,
        appVersion: APP_VERSION,
        backendKind: 'daemon',
      });
      fs.writeFileSync(path.join(home, 'ui-sock'), sockB + '\n');

      // Watch for 200s — past the client's 180s give-up — sampling every 250ms.
      const deadline = Date.now() + 200_000;
      while (Date.now() < deadline) {
        await sample();
        await sleep(250);
      }
      return `sequence (${seq.length} distinct states):\n      ${seq
        .map((s) => `${s.t} state=${s.state} banner="${s.banner}" footer="${s.footer}"`)
        .join('\n      ')}`;
    } finally {
      app.stop();
      await backend.close();
    }
  },
  {
    budgetMs: 260_000,
    skip: () =>
      process.env.E2E_DIAGNOSE === '1'
        ? null
        : 'D1b diagnostic — set E2E_DIAGNOSE=1 to run (watches for 200s past the give-up)',
  },
);

// ---------------------------------------------------------------------------
// POSITIVE CONTROL for the timeout capture (M4 D2a). Hangs deliberately while
// the app sits in a state whose values are ALREADY KNOWN VERBATIM — D1a's
// reconnecting window — and asserts the capture reports THOSE.
//
// "The capture ran without error" is not evidence; a fabricator returning
// defaults would also run without error. Calibrating against known values is
// the mutation-test shape applied to an INSTRUMENT: if it reports the real
// strings it is reading live state, if it reports blanks or defaults it lies.
// D1a conveniently left a target whose exact copy is pinned by its own test.
// ---------------------------------------------------------------------------
scenario(
  'selftest-capture-reads-known-state',
  async ({ sway, ctl }) => {
    const home = mkTmp('cal-home');
    const uiSock = path.join(mkTmp('cal-sock'), 'ui.sock');
    const backend = await startFakeBackend(uiSock, {
      proto: 1,
      appVersion: APP_VERSION,
      backendKind: 'daemon',
    });
    const app = await launchGtk({
      sway,
      label: 'cal',
      env: { ORCHESTRA_HOME: home, ORCHESTRA_UI_SOCK: uiSock },
    });
    // TWO-STATE calibration. Reproducing ONE known state could just be echoing
    // a constant — right answer, wrong reason. So we capture in the ATTACHED
    // state first (footer names the daemon, banner hidden), then again mid
    // RECONNECT (footer "reconnecting…", banner showing attempt copy), and
    // require BOTH to match AND to differ from each other. A constant-emitter
    // passes neither.
    const calibration = { attached: null, reconnecting: null };
    const snapshot = () => appProbe(app)();
    ctl.probe = async () => {
      // NOTE the reconnecting snapshot is taken WHILE that state holds (below),
      // not here. The window is ~1s — the fake backend's listener stays up
      // after dropConnections(), so the client redials almost immediately — and
      // an earlier version of this calibration read at the cut 8s later, by
      // which time the app had legitimately returned to Connected. The capture
      // was correct; the calibration's assumption was not. Timing the read to
      // the state you mean to calibrate against is the whole trick.
      const cap = await snapshot();
      cap.atCutState = 'captured after the app had already recovered (expected)';
      const a = calibration.attached ?? {};
      const r = calibration.reconnecting ?? {};

      // Attached-state expectations. NOTE the banner there is HIDDEN, so the
      // right answer is "not revealed" — NOT an empty string, and NOT a probe
      // failure. If those three collapsed into one blank this check could not
      // be written, which is why provenance had to land before the format did.
      const attachedOk =
        a.footer?.status === 'value' &&
        /backend: daemon/i.test(a.footer.value) &&
        a.connectionState?.status === 'value' &&
        a.connectionState.value === 'Connected' &&
        a.bannerRevealed?.status === 'value' &&
        a.bannerRevealed.value === false;

      // Reconnecting-state expectations. Deliberately NOT asserting the banner
      // TEXT here: the snapshot is taken the moment the state label flips, and
      // within that same handler the state label is written BEFORE the banner
      // copy — so the banner can still hold the previous string for an instant.
      // The banner is a lagging indicator; ConnectionState is authoritative.
      // (Asserting the banner text here failed while the capture was perfectly
      // correct — a calibration bug, not a capture bug.) D1a separately pins
      // the banner copy itself, polling until it settles.
      const reconnectingOk =
        r.footer?.status === 'value' &&
        /backend: reconnecting…/i.test(r.footer.value) &&
        r.connectionState?.status === 'value' &&
        /^Reconnecting\{/.test(r.connectionState.value);

      // The two captures must actually DIFFER — a constant would match at most
      // one, but this makes the requirement explicit rather than incidental.
      const differ =
        a.footer?.value !== r.footer.value ||
        a.connectionState?.value !== r.connectionState.value;

      cap.CALIBRATION = {
        attachedState: calibration.attached,
        // Show the judged snapshot, not just the verdict — a calibration that
        // reports pass/fail without the evidence it judged is unauditable.
        reconnectingState: calibration.reconnecting,
        attachedMatchesKnown: attachedOk,
        reconnectingMatchesKnown: reconnectingOk,
        statesDiffer: differ,
        verdict:
          attachedOk && reconnectingOk && differ
            ? 'READS LIVE STATE (two distinct known states reproduced)'
            : 'DID NOT REPRODUCE BOTH KNOWN STATES',
      };
      return cap;
    };
    try {
      await waitFor(
        async () => {
          const r = await app.rc.get('status-text', 'label').catch(() => null);
          return r && r.ok && /backend: daemon/i.test(r.value || '') ? r.value : null;
        },
        { desc: 'attach before dropping' },
      );
      // KNOWN STATE #1: fully attached. Footer names the daemon, banner hidden.
      calibration.attached = await snapshot();
      // Enter KNOWN STATE #2 (D1a's window), then hang inside it so the cut
      // lands there.
      backend.dropConnections();
      // Snapshot INSIDE the ~1s window, the moment the app reports it. Waiting
      // for the cut would read a recovered app (see the note in ctl.probe).
      calibration.reconnecting = await waitFor(
        async () => {
          const cap = await snapshot();
          return cap.connectionState.status === 'value' &&
            /^Reconnecting\{/.test(cap.connectionState.value)
            ? cap
            : null;
        },
        { desc: 'the reconnecting window', intervalMs: 25 },
      );
      await new Promise(() => {}); // hang; the budget cuts us here
    } finally {
      app.stop();
      await backend.close();
    }
  },
  {
    budgetMs: 8_000,
    skip: () =>
      process.env.E2E_SELFTEST === '1'
        ? null
        : 'instrument self-test — set E2E_SELFTEST=1 to run (deliberately hangs for its full budget)',
  },
);

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
      { desc: 'initial attach' },
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
      { desc: 'the reconnecting window', intervalMs: 50 },
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
scenario(
  'reconnect-new-socket-path',
  async ({ sway, ctl }) => {
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
  // If this scenario hangs (the M4 D1b wedge), the runner's budget cuts it and
  // this probe records WHY: ConnectionState and banner side by side.
  ctl.probe = appProbe(app, () => ({
    sockA,
    sockB,
    pointerNow: fs.existsSync(path.join(home, 'ui-sock'))
      ? fs.readFileSync(path.join(home, 'ui-sock'), 'utf8').trim()
      : '<pointer absent>',
    sockBExists: fs.existsSync(sockB),
  }));

  try {
    await waitFor(
      async () => {
        const r = await app.rc.get('status-text', 'label').catch(() => null);
        return r && r.ok && /backend: daemon/i.test(r.value || '') ? r.value : null;
      },
      { desc: 'initial attach to socket A' },
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
      { desc: 're-attach after the socket moved' },
    );
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    return `re-attached to the moved socket in ~${secs}s (old behavior: ~180s give-up)`;
    } finally {
      app.stop();
      await backend.close();
    }
  },
  // Past the client's 180s give-up (BackoffPolicy max_elapsed_ms), because the
  // give-up is ON the recovery path here: the app only drops the backend and
  // re-runs discovery once Disconnected arrives. A budget under 180s would cut
  // before the mechanism under test could possibly fire.
  { budgetMs: 240_000 },
);

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
      { desc: 'initial attach' },
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
      { desc: 're-attach on the same path' },
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
      await waitFor(() => fs.existsSync(path.join(home, 'ui-sock')), { desc: 'first daemon ui-sock' });
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

// ---------------------------------------------------------------------------
// Scenario: the two form modals (repo scripts + Linear API key) OPEN, RENDER
// and their actions REACH THE BACKEND.
//
// WHAT MAKES THESE NON-VACUOUS. Both assert a TRANSITION, never a state that
// might already hold:
//
//   • repo-scripts: the modal is not in the widget tree before the click and
//     IS after (open transition), and the SAVED VALUE is read back from the
//     backend and must DIFFER from what was loaded (mutation transition). An
//     "ok: true" from the save call proves nothing — a sibling agent found an
//     action that returned ok while doing nothing, so the verdict here comes
//     from re-reading getRepoScripts, not from the save's return.
//   • linear: getLinearKeySource must go "none" → "stored" across the save.
//     Asserting "is it stored?" alone would pass against a fixture that had
//     always been stored.
//
// Screenshots are hashed and duplicates FAIL: a drive step that silently
// no-ops still "captures" a PNG, so byte-identical shots are the tell that a
// click did nothing (this repo has shipped that exact bug before).
// ---------------------------------------------------------------------------

/** Flatten a list_widgets reply into a Set of widget names.
 *
 *  The reply is `{ ok, widgets: [<toplevel tree>...] }` and each node is
 *  `{ name, type, visible, children? }` (remote_control.rs:260-273). Getting
 *  that key wrong does not fail loudly — the walker just returns an empty set
 *  and every `waitFor` on it times out, which reads exactly like an app hang.
 *  Hence `sanityCheckNames` below. */
function widgetNames(reply) {
  const names = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.name) names.add(node.name);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  (reply?.widgets || []).forEach(walk);
  return names;
}

async function namesOf(app) {
  return widgetNames(await app.rc.listWidgets());
}

/// Positive control for the walker itself: assert it can see a widget that is
/// unconditionally present. Without this, an empty set is indistinguishable
/// from "the app rendered nothing", and the scenario blames the app for a bug
/// in its own instrument.
async function sanityCheckNames(app) {
  const names = await waitFor(
    async () => {
      const n = await namesOf(app);
      return n.size > 0 ? n : null;
    },
    { desc: 'list_widgets returns a non-empty tree (walker sanity check)' },
  );
  assert(
    names.has('main-window'),
    `widget walker sees ${names.size} names but not 'main-window' — the walker or the ` +
      `reply shape is wrong, not the app: ${[...names].slice(0, 20).join(', ')}`,
  );
  return names;
}

scenario('repo-scripts-modal-opens-and-saves', async ({ sway }) => {
  const home = mkTmp('scripts-home');
  const app = await launchGtk({
    sway,
    label: 'scripts',
    env: { ORCHESTRA_HOME: home, ORCHESTRA_GTK_MOCK: '1' },
  });
  const shots = [];
  try {
    await sanityCheckNames(app);
    await waitFor(async () => (await namesOf(app)).has('sidebar-footer'), {
      desc: 'sidebar rendered',
    });

    // PRE-STATE: the modal must NOT already exist, or "it is open" proves
    // nothing about the click.
    const before = await namesOf(app);
    assert(
      !before.has('repo-scripts-modal'),
      'repo-scripts modal must be absent before the click (else the open assertion is vacuous)',
    );
    // Per-repo gear button: `repo-scripts-<repo name>` (widgets.rs). The mock
    // fixture's orchestra repo is the one carrying seeded scripts.
    const gear = 'repo-scripts-orchestra';
    assert(before.has(gear), `no ${gear} in the tree: ${[...before].slice(0, 40).join(', ')}`);

    await app.rc.click(gear);
    await waitFor(async () => (await namesOf(app)).has('repo-scripts-modal'), {
      desc: 'repo-scripts modal opens',
    });

    // It RENDERED, not merely exists: the three editors and both pickers are
    // in the tree, so a modal that opened empty would fail here.
    const open = await namesOf(app);
    for (const w of [
      'repo-scripts-setup',
      'repo-scripts-run',
      'repo-scripts-archive',
      'repo-scripts-branch',
      'repo-scripts-account',
      'repo-scripts-save',
    ]) {
      assert(open.has(w), `repo-scripts modal is missing ${w}`);
    }

    const shot = path.join(SHOT_DIR, 'repo-scripts-modal.png');
    const r = await app.rc.screenshot(shot, 'repo-scripts-modal');
    assert(r.ok, `screenshot failed: ${JSON.stringify(r)}`);
    shots.push(shot);

    // MUTATION: set a new setup script, save, then read it back FROM THE
    // BACKEND. The read-back is the assertion — the save's own return is not.
    //
    // Written via the modal's `scripts.set` action rather than the `type` op:
    // a TextView is not a GtkEditable and the headless seat has no keyboard.
    // Resolved on a widget INSIDE the group's owner (actions resolve UP the
    // widget tree), hence the editor's own name as the target.
    const marker = '# e2e-marker\necho hello';
    const setRes = await app.rc.send({
      op: 'action',
      action: 'scripts.set',
      param: `setup|${marker}`,
      name: 'repo-scripts-setup',
    });
    assert(setRes.ok, `scripts.set failed: ${JSON.stringify(setRes)}`);
    // Confirm the editor actually took the text before crediting the save —
    // otherwise a no-op action would save the ORIGINAL value and the
    // round-trip assertion below could pass on the seeded fixture.
    const typed = await app.rc.get('repo-scripts-setup', 'label');
    assert(
      typed.ok && String(typed.value || '').includes('echo hello'),
      `editor did not take the new text: ${JSON.stringify(typed)}`,
    );
    await app.rc.click('repo-scripts-save');
    await waitFor(async () => !(await namesOf(app)).has('repo-scripts-modal'), {
      desc: 'modal closes after a successful save',
    });

    // Re-open and confirm the value came back — same drive path a user takes.
    await app.rc.click(gear);
    await waitFor(async () => (await namesOf(app)).has('repo-scripts-setup'), {
      desc: 'repo-scripts modal re-opens',
    });
    const readBack = await app.rc.get('repo-scripts-setup', 'label');
    assert(
      readBack.ok && String(readBack.value || '').includes('echo hello'),
      `saved setup script did not round-trip through the backend: ${JSON.stringify(readBack)}`,
    );

    const shot2 = path.join(SHOT_DIR, 'repo-scripts-modal-saved.png');
    await app.rc.screenshot(shot2, 'repo-scripts-modal');
    shots.push(shot2);
    assertDistinctShots(shots);

    return `modal opened, saved, and the value round-tripped via getRepoScripts (${shots.length} shots)`;
  } finally {
    app.stop();
  }
});

scenario('linear-settings-modal-opens-and-saves', async ({ sway }) => {
  const home = mkTmp('linear-home');
  const app = await launchGtk({
    sway,
    label: 'linear',
    env: { ORCHESTRA_HOME: home, ORCHESTRA_GTK_MOCK: '1' },
  });
  const shots = [];
  try {
    await sanityCheckNames(app);
    await waitFor(async () => (await namesOf(app)).has('footer-linear'), {
      desc: 'sidebar footer with the Linear button',
    });

    const before = await namesOf(app);
    assert(
      !before.has('linear-settings'),
      'linear modal must be absent before the click (else the open assertion is vacuous)',
    );

    await app.rc.click('footer-linear');
    await waitFor(async () => (await namesOf(app)).has('linear-settings'), {
      desc: 'linear modal opens',
    });

    const open = await namesOf(app);
    for (const w of ['linear-key-input', 'linear-key-test', 'linear-key-save', 'linear-key-source']) {
      assert(open.has(w), `linear modal is missing ${w}`);
    }

    // PRE-STATE: the mock starts with NO key, so the source line says so.
    // This is what makes the post-save assertion a transition.
    const srcBefore = await app.rc.get('linear-key-source', 'label');
    assert(
      /No key configured/i.test(srcBefore.value || ''),
      `expected the no-key state before saving, got: ${JSON.stringify(srcBefore)}`,
    );

    const shot = path.join(SHOT_DIR, 'linear-settings-modal.png');
    const r = await app.rc.screenshot(shot, 'linear-settings');
    assert(r.ok, `screenshot failed: ${JSON.stringify(r)}`);
    shots.push(shot);

    // A key the mock's checkLinearKey ACCEPTS (it validates the prefix rather
    // than ignoring the param), so this exercises check → save → source flip.
    await app.rc.type('lin_api_e2e_valid_key', 'linear-key-input');
    await app.rc.click('linear-key-save');

    // BOUNDED, and deliberately so. The save path is synchronous against the
    // mock, so the flip lands in well under a second; letting this ride the
    // 60s scenario budget means a broken save reports as an uninformative
    // TIMED OUT (verified — that is exactly what the mutation run produced)
    // instead of naming the state it got stuck in.
    await waitFor(
      async () => {
        const s = await app.rc.get('linear-key-source', 'label').catch(() => null);
        return s && s.ok && /saved in Orchestra/i.test(s.value || '') ? s.value : null;
      },
      {
        timeoutMs: 5_000,
        desc:
          'key source transitions none → stored (still reads as unsaved ⇒ the save never ' +
          'reached the backend)',
      },
    );

    // The remove button is revealed only for a STORED key — a second,
    // independent witness that the save actually landed in the backend.
    const afterSave = await namesOf(app);
    assert(afterSave.has('linear-key-remove'), 'remove button should appear once a key is stored');

    const shot2 = path.join(SHOT_DIR, 'linear-settings-modal-saved.png');
    await app.rc.screenshot(shot2, 'linear-settings');
    shots.push(shot2);
    assertDistinctShots(shots);

    return `modal opened; key source transitioned none → stored (${shots.length} shots)`;
  } finally {
    app.stop();
  }
});

// ---- assert + main ----------------------------------------------------------

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/// Hash every captured PNG and FAIL on a duplicate.
///
/// A drive step that silently no-ops (clicking something already in the target
/// state) still produces a screenshot, so a set of shots can look like N proven
/// surfaces while proving fewer. Byte-identical captures are the mechanical
/// tell. Also fails an EMPTY file: a capture that wrote nothing is not evidence.
function assertDistinctShots(paths) {
  const seen = new Map();
  for (const p of paths) {
    assert(fs.existsSync(p), `screenshot missing: ${p}`);
    const buf = fs.readFileSync(p);
    assert(buf.length > 0, `screenshot is empty: ${p}`);
    const hash = createHash('sha256').update(buf).digest('hex');
    const prior = seen.get(hash);
    assert(
      !prior,
      `screenshots are byte-identical (${path.basename(prior || '')} vs ${path.basename(p)}) — ` +
        `a drive step probably no-opped`,
    );
    seen.set(hash, p);
  }
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
    // A scenario may register a probe (see `ctl.probe`) that the timeout calls
    // to snapshot app state at the cut.
    const ctl = { probe: null };
    let timer = null;
    try {
      const detail = await Promise.race([
        s.fn({ sway, ctl }),
        new Promise((_, reject) => {
          timer = setTimeout(async () => {
            reject(new ScenarioTimeout(s.name, s.budgetMs, await captureAtCut(ctl.probe)));
          }, s.budgetMs);
        }),
      ]);
      const ms = Date.now() - t0;
      console.log(`PASS  ${s.name}  (${ms}ms)\n      ${detail || ''}\n`);
      passed++;
    } catch (e) {
      const ms = Date.now() - t0;
      // A TIMED-OUT SCENARIO IS A FAILING SCENARIO — never a skip.
      //
      // Skipping is the tempting shortcut ("we couldn't test this, move on"),
      // and it would recreate absence-read-as-signal ONE LEVEL UP inside the
      // very tool built to remove it: the suite goes green, nobody notices the
      // scenario stopped proving anything, and we are back to interpreting
      // silence. So: FAIL, non-zero exit, and print what we saw at the cut.
      if (e instanceof ScenarioTimeout) {
        console.log(
          `FAIL  ${s.name}  (${ms}ms)\n      TIMED OUT — ${e.message}\n` +
            `      state at cut: ${JSON.stringify(e.capture, null, 2).replace(/\n/g, '\n      ')}\n`,
        );
      } else {
        console.log(`FAIL  ${s.name}  (${ms}ms)\n      ${e.message}\n`);
      }
      failed++;
    } finally {
      if (timer) clearTimeout(timer);
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
