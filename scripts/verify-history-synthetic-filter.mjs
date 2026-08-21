#!/usr/bin/env node
/* E2E gate for the history-backfill synthetic-frame filter (real built app,
 * isolated ORCHESTRA_HOME, headless sway, CDP).
 *
 * The CLI persists the wire's `isSynthetic` as the transcript envelope's
 * `isMeta`. The live normalize path drops synthetic user TEXT, but the on-disk
 * backfill did not — so after an app restart every skill invocation rendered
 * its whole SKILL.md body ("Base directory for this skill: …"), plus
 * "Continue from where you left off." wake prompts, `[Image: …]` placeholders
 * and compact summaries, as giant USER bubbles ("skills show as messages from
 * the user after restart", observed on the real bloc2 transcript 2026-08-21).
 *
 * This gate seeds a transcript carrying every offending frame shape next to
 * real turns, opens the structured view on the REAL sdkHistory → fold →
 * StructuredView path, and asserts in the LIVE DOM that:
 *   - the real user turn and assistant reply render (positive control — the
 *     pane did paint content, so the absences below are meaningful),
 *   - the reconstructed `/cmd args` bubble renders (commands are NOT synthetic),
 *   - NO synthetic frame text appears anywhere in the pane,
 *   - the compact summary surfaced as a notice, not a user bubble.
 *
 * Usage: node scripts/verify-history-synthetic-filter.mjs   (repo root, after
 *        `npx vite build`)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const REPO = process.cwd();
const RUN = path.join(os.tmpdir(), `histfilter-e2e-5bcf5445-${process.pid}`);
const HOME = path.join(RUN, 'home');
const PORT = 9490 + (process.pid % 90);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, pred, ms, step = 300) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + what);
    await sleep(step);
  }
}

// ── harness: sway ───────────────────────────────────────────────────────────
fs.mkdirSync(HOME, { recursive: true });
const swayCfg = path.join(RUN, 'sway.cfg');
fs.writeFileSync(swayCfg, 'output HEADLESS-1 resolution 1600x1000\n');
const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
const t0 = Date.now();
const sway = spawn('sway', ['-c', swayCfg], {
  env: {
    ...process.env,
    WLR_BACKENDS: 'headless',
    WLR_LIBINPUT_NO_DEVICES: '1',
    WAYLAND_DISPLAY: '',
    SWAYSOCK: path.join(RUN, 'sway.sock'),
  },
  stdio: 'ignore',
});
const wayland = await waitFor(
  'sway wayland socket',
  () =>
    fs
      .readdirSync(runtimeDir)
      .filter((f) => /^wayland-\d+$/.test(f))
      .find((f) => fs.statSync(path.join(runtimeDir, f)).mtimeMs >= t0 - 1000),
  10000,
);
console.log(`[harness] sway up on ${wayland}`);

// ── seed store (one scratch workspace with a persisted structured session) ──
const WSID = 'e2e-hist-filter-1';
const SESS = 'e2e-sess-histfilter';
const wsDir = path.join(RUN, `scratch-${WSID}`);
fs.mkdirSync(wsDir, { recursive: true });
const storeDir = path.join(HOME, 'userData', 'orchestra');
fs.mkdirSync(storeDir, { recursive: true });
fs.writeFileSync(
  path.join(storeDir, 'store.json'),
  JSON.stringify({
    repos: [],
    workspaces: [
      {
        id: WSID,
        name: 'hist-filter',
        kind: 'scratch',
        repoPath: '',
        worktreePath: wsDir,
        branch: 'hist-filter',
        baseBranch: '',
        createdAt: Date.now(),
        status: 'idle',
        agent: 'claude',
        sdkSessionId: SESS,
      },
    ],
  }),
);

// ── seed the transcript (real ~/.claude fallback dir — cleaned up in finally)
const mangle = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const tsDir = path.join(os.homedir(), '.claude', 'projects', mangle(wsDir));
fs.mkdirSync(tsDir, { recursive: true });
const at = (min) => new Date(Date.now() - min * 60_000).toISOString();
const SKILL_BODY = 'Base directory for this skill: /home/x/skills/loop\n\n# /loop — schedule a recurring prompt\nParse the input…';
const lines = [
  // Real typed turn + reply — the positive control.
  { type: 'user', uuid: 'u1', timestamp: at(30), message: { role: 'user', content: 'real question from the human' } },
  { type: 'assistant', uuid: 'a1', timestamp: at(29), message: { role: 'assistant', content: [{ type: 'text', text: 'real assistant answer' }] } },
  // Slash-command invocation — NOT synthetic; must reconstruct as `/loop tick tock`.
  {
    type: 'user', uuid: 'u2', timestamp: at(20),
    message: { role: 'user', content: '<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>tick tock</command-args>' },
  },
  // The skill-body expansion (isMeta) — the reported bug.
  { type: 'user', uuid: 'u3', isMeta: true, timestamp: at(20), message: { role: 'user', content: SKILL_BODY } },
  // Wake continuation (isMeta, block form).
  { type: 'user', uuid: 'u4', isMeta: true, timestamp: at(15), message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] } },
  // Image coordinate placeholder (isMeta).
  { type: 'user', uuid: 'u5', isMeta: true, timestamp: at(14), message: { role: 'user', content: '[Image: original 2022x1254, displayed at 2000x1240.]' } },
  // Compact summary — must surface as a notice, never a user bubble.
  {
    type: 'user', uuid: 'u6', isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: at(10),
    message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context…' },
  },
  { type: 'assistant', uuid: 'a2', timestamp: at(9), message: { role: 'assistant', content: [{ type: 'text', text: 'post-compact reply' }] } },
];
fs.writeFileSync(path.join(tsDir, `${SESS}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// ── app + CDP ───────────────────────────────────────────────────────────────
const appEnv = { ...process.env };
for (const k of ['APPIMAGE', 'APPDIR', 'OWD', 'ARGV0']) delete appEnv[k];
Object.assign(appEnv, {
  WAYLAND_DISPLAY: wayland,
  ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
  ORCHESTRA_OZONE: 'wayland',
  ORCHESTRA_OZONE_RELAUNCHED: '1',
  ORCHESTRA_HOME: HOME,
  ORCHESTRA_DEBUG_PORT: String(PORT),
});
const app = spawn(
  path.join(REPO, 'node_modules/electron/dist/electron'),
  ['.', '--ozone-platform=wayland'],
  { cwd: REPO, env: appEnv, stdio: 'ignore' },
);

async function connectCdp(port) {
  const url = await waitFor(
    'CDP target',
    async () => {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
        if (page && !page.url.includes('app.asar')) return page.webSocketDebuggerUrl;
      } catch { /* not up yet */ }
      return null;
    },
    30000,
    500,
  );
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const my = ++id;
      pending.set(my, { resolve, reject });
      ws.send(JSON.stringify({ id: my, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
    return r.result?.value;
  };
  return { send, ev, close: () => ws.close() };
}

let cdp;
try {
  cdp = await connectCdp(PORT);
  const href = await cdp.ev('location.href');
  check('driving this worktree, not an installed build', !href.includes('app.asar'), href);

  // Open the workspace's structured view — triggers the real sdkHistory backfill.
  await waitFor('renderer store seam', () => cdp.ev(`typeof window.__orchestraSetState === 'function'`), 15000);
  await waitFor('workspace loaded in renderer', () => cdp.ev(`(window.__zustandState?.workspaces ?? []).length >= 1 || true`), 2000).catch(() => {});
  await cdp.ev(`window.__orchestraSetState({ activeId: ${JSON.stringify(WSID)}, view: 'structured' })`);

  // The folded session, after the backfill lands.
  const session = await waitFor(
    'history backfill folded into the session',
    async () => {
      const s = await cdp.ev(`(window.__readAgentSession ? window.__readAgentSession(${JSON.stringify(WSID)}) : null)`);
      return s && s.historyBackfilled && (s.messages?.length ?? 0) > 0 ? s : null;
    },
    20000,
  );

  const msgs = session.messages;
  const texts = msgs.map((m) => m.text ?? '');
  const userTexts = msgs.filter((m) => m.role === 'user').map((m) => m.text ?? '');

  // Positive controls — the pane holds real content, so absences below mean
  // "filtered", not "nothing loaded".
  check('real user turn folded', userTexts.includes('real question from the human'), JSON.stringify(userTexts));
  check('assistant replies folded', texts.includes('real assistant answer') && texts.includes('post-compact reply'));
  check('command invocation reconstructs as /loop tick tock (not synthetic)', userTexts.includes('/loop tick tock'));

  // The fix — no synthetic frame may fold as a user bubble.
  check('no skill body bubble', !userTexts.some((t) => t.includes('Base directory for this skill')), JSON.stringify(userTexts));
  check('no continuation-prompt bubble', !userTexts.some((t) => t.includes('Continue from where you left off')));
  check('no image-placeholder bubble', !userTexts.some((t) => t.startsWith('[Image:')));
  check('no compact-summary bubble', !userTexts.some((t) => t.includes('This session is being continued')));
  const boundary = msgs.find((m) => m.noticeKind === 'compact-boundary');
  check('compact summary surfaced as a compact-boundary notice', !!boundary, JSON.stringify(boundary ?? null));

  // DOM half — what actually renders in the pane (the fold could be right and
  // the pane wrong). innerText of the message list must carry the real turns
  // and none of the synthetic text.
  const dom = await waitFor(
    'message list rendered',
    async () => {
      const v = await cdp.ev(`(() => {
        const list = document.querySelector('.av-message-list');
        if (!list) return null;
        const t = list.innerText;
        return t && t.includes('real question from the human') ? t : null;
      })()`);
      return v;
    },
    15000,
  );
  check('DOM: real turns render', dom.includes('real assistant answer') && dom.includes('/loop tick tock'));
  check('DOM: no skill body', !dom.includes('Base directory for this skill'));
  check('DOM: no continuation prompt', !dom.includes('Continue from where you left off'));
  check('DOM: no compact-summary text', !dom.includes('This session is being continued'));
  check('DOM: compact-boundary notice renders', dom.includes('Conversation compacted'));

  // Screenshot (the paint half).
  const r = await Promise.race([
    cdp.send('Page.captureScreenshot', { format: 'png' }),
    sleep(8000).then(() => null),
  ]);
  const shotPath = path.join(RUN, 'structured-history-filtered.png');
  if (r?.data) fs.writeFileSync(shotPath, Buffer.from(r.data, 'base64'));
  check('screenshot captured (paint half)', !!r?.data, shotPath);
  if (r?.data) {
    const hash = crypto.createHash('md5').update(Buffer.from(r.data, 'base64')).digest('hex');
    console.log(`[artifact] screenshot: ${shotPath} (md5 ${hash})`);
  }
} finally {
  try { app.kill('SIGTERM'); } catch { /* already gone */ }
  try { sway.kill('SIGTERM'); } catch { /* already gone */ }
  try { fs.rmSync(tsDir, { recursive: true, force: true }); } catch { /* leave for manual cleanup */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
