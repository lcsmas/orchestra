import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseClaudeMdImports } from '../shared/claude-md-imports.ts';

// parseClaudeMdImports decides which extra files get symlinked into a login
// dir alongside CLAUDE.md. Claude Code resolves @imports relative to the
// file's location, so missing one import means that file silently never loads
// for the alternate account.
test('parseClaudeMdImports: bare-filename imports are collected in order', () => {
  const md = '@RTK.md\n@LESSONS.md\n\n## Debugging Discipline\n\n- some rule\n';
  assert.deepEqual(parseClaudeMdImports(md), ['RTK.md', 'LESSONS.md']);
});

test('parseClaudeMdImports: ignores non-import lines and inline mentions', () => {
  const md = 'see @RTK.md for details\nemail me @lucas\n- @LESSONS.md trailing words\n';
  assert.deepEqual(parseClaudeMdImports(md), []);
});

test('parseClaudeMdImports: rejects path-traversal and separator imports', () => {
  const md = '@../outside.md\n@dir/file.md\n@dir\\file.md\n@.hidden\n@ok-name.md\n';
  assert.deepEqual(parseClaudeMdImports(md), ['ok-name.md']);
});

test('parseClaudeMdImports: tolerates surrounding whitespace and CRLF', () => {
  const md = '  @RTK.md  \r\n@LESSONS.md\r\n';
  assert.deepEqual(parseClaudeMdImports(md), ['RTK.md', 'LESSONS.md']);
});

// ---- #235: a missing/unreadable SOURCE must never strip a login dir ----------
//
// Drives the REAL `syncAccountInheritance` (esbuild-bundled; `./store` + `./logger`
// stubbed) against SCRATCH dirs only. SAFETY: `assertScratch` refuses any path
// under the real HOME's `.claude*` or `$CLAUDE_CONFIG_DIR` — never boot or point
// anything at a live Claude dir.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Captured BEFORE any HOME override.
const REAL_HOMES = [os.homedir(), os.userInfo().homedir].map((h) => path.resolve(h));
const REAL_CFG = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : null;
const SCRATCH_ROOT = path.join(repoRoot, 'node_modules', '.cache', `a8-inherit-${process.pid}`);

const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};

/** realpath of the deepest existing ancestor + the not-yet-existing remainder. */
function resolveReal(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) {
    rest.unshift(path.basename(cur));
    cur = path.dirname(cur);
  }
  return path.join(fs.realpathSync(cur), ...rest);
}

function lexicallyLive(abs: string): boolean {
  for (const home of REAL_HOMES) {
    const rel = path.relative(home, abs);
    if (isInside(home, abs) && rel !== '' && rel.split(path.sep)[0].startsWith('.claude')) {
      return true;
    }
  }
  return REAL_CFG !== null && isInside(REAL_CFG, abs);
}

function isLiveClaudeDir(p: string): boolean {
  const abs = path.resolve(p);
  return lexicallyLive(abs) || lexicallyLive(resolveReal(abs)); // lexical first: no fs touch on a live path
}

function assertScratch(p: string): void {
  assert.ok(!isLiveClaudeDir(p), `SAFETY: refusing ${p} — resolves under a live Claude dir`);
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  assert.ok(
    isInside(resolveReal(SCRATCH_ROOT), resolveReal(p)),
    `SAFETY: refusing ${p} — not under the scratch root ${SCRATCH_ROOT}`,
  );
}

type Inherit = { settings?: boolean; statusline?: boolean; skills?: string[]; mcpServers?: string[] };
type Acct = { id: string; label: string; configDir: string; inherit?: Inherit };
type LogRec = { level: string; msg: string };

type SyncOpts = { userDeselected?: boolean; caller?: string };
type Mod = {
  syncAccountInheritance(a: Acct, opts?: SyncOpts): Promise<void>;
  syncAfterAccountsSave(before: Acct[], saved: Acct[]): Promise<void>;
};
let bundlePromise: Promise<Mod> | null = null;
function loadInherit() {
  return (bundlePromise ??= (async () => {
    const require_ = createRequire(path.join(repoRoot, 'package.json'));
    let esbuild: { build: (o: unknown) => Promise<unknown> };
    try {
      esbuild = require_('esbuild');
    } catch {
      const hit = fs.globSync(path.join(repoRoot, 'node_modules/.pnpm/esbuild@*/node_modules/esbuild'));
      if (!hit.length) throw new Error('esbuild not resolvable — run `pnpm install` (a skip would be a false green)');
      esbuild = require_(hit[0]);
    }
    assertScratch(SCRATCH_ROOT);
    const entry = path.join(SCRATCH_ROOT, 'entry.ts');
    const out = path.join(SCRATCH_ROOT, 'account-inherit.bundle.cjs');
    fs.writeFileSync(
      entry,
      `export { syncAccountInheritance, syncAfterAccountsSave } from ${JSON.stringify(path.join(repoRoot, 'src/main/account-inherit.ts'))};\n`,
    );
    const stubs: Record<string, string> = {
      store: '(globalThis as any).__a8Store ??= { accounts: [] as unknown[] };\nexport const store = (globalThis as any).__a8Store;',
      logger:
        "const rec = (level: string) => (msg: unknown) => { (globalThis as any).__a8Logs.push({ level, msg: String(msg) }); };\n" +
        "export const log = { warn: rec('warn'), info: rec('info'), error: rec('error'), debug: rec('debug') };",
    };
    await esbuild.build({
      entryPoints: [entry],
      outfile: out,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
      plugins: [
        {
          name: 'a8-stubs',
          setup(b: any) {
            b.onResolve({ filter: /^\.\/(store|logger)$/ }, (a: any) =>
              a.importer.endsWith('account-inherit.ts') ? { path: a.path.slice(2), namespace: 'a8-stub' } : undefined,
            );
            b.onLoad({ filter: /.*/, namespace: 'a8-stub' }, (a: any) => ({ contents: stubs[a.path], loader: 'ts' }));
          },
        },
      ],
    });
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.includes('.orchestra-inherited.json'), 'bundle must contain the REAL account-inherit.ts');
    return createRequire(out)(out);
  })());
}

after(() => {
  // Guarded: only ever removes the scratch root (chmod back so a 000 dir can go).
  assertScratch(SCRATCH_ROOT);
  for (const f of fs.globSync(path.join(SCRATCH_ROOT, '**', '.claude'))) {
    try { fs.chmodSync(f, 0o755); } catch { /* not a dir */ }
  }
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

interface Rig { home: string; login: string; }
let rigN = 0;
function newRig(): Rig {
  const home = path.join(SCRATCH_ROOT, `t${++rigN}`, 'home');
  fs.mkdirSync(home, { recursive: true });
  assertScratch(home);
  return { home, login: path.join(home, '.claude-mc') };
}

const put = (p: string, body: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

/** The global source: `~/.claude/*` plus `~/.claude.json` (the MCP source). */
function makeSource(home: string): void {
  const g = path.join(home, '.claude');
  put(path.join(g, 'settings.json'), '{"model":"opus"}\n');
  put(path.join(g, 'CLAUDE.md'), '@RTK.md\n@LESSONS.md\n\n# global\n');
  put(path.join(g, 'RTK.md'), '# rtk\n');
  put(path.join(g, 'LESSONS.md'), '# lessons\n');
  put(path.join(g, 'statusline-command.sh'), '#!/bin/sh\necho hi\n');
  put(path.join(g, 'skills', 'frontend-design', 'SKILL.md'), '# fd\n');
  put(path.join(g, 'skills', 'handoff', 'SKILL.md'), '# handoff\n');
  put(
    path.join(home, '.claude.json'),
    JSON.stringify({ mcpServers: { github: { command: 'gh' }, 'linear-server': { url: 'u' }, 'chrome-devtools': { command: 'cd' } } }),
  );
}

const FULL: Inherit = {
  settings: true,
  statusline: true,
  skills: ['frontend-design', 'handoff'],
  mcpServers: ['github', 'linear-server', 'chrome-devtools'],
};
const LINKS = [
  'CLAUDE.md', 'LESSONS.md', 'RTK.md', 'settings.json', 'skills/frontend-design', 'skills/handoff', 'statusline-command.sh',
];

/** Run the REAL sync with HOME redirected to the scratch home; returns the WARN lines. */
async function runSync(rig: Rig, inherit?: Inherit, opts?: SyncOpts): Promise<string[]> {
  assertScratch(rig.home);
  assertScratch(rig.login);
  const m = await loadInherit();
  const prev = process.env.HOME;
  process.env.HOME = rig.home;
  try {
    assert.equal(os.homedir(), rig.home, 'HOME redirect must take effect');
    (globalThis as any).__a8Logs = [] as LogRec[];
    await m.syncAccountInheritance({ id: 'a', label: 'mc', configDir: rig.login, inherit }, opts);
    return ((globalThis as any).__a8Logs as LogRec[]).filter((l) => l.level === 'warn').map((l) => l.msg);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

/** Every entry of a dir: symlink target / file sha256 / dir marker. null when absent. */
function snapshot(dir: string): Record<string, string> | null {
  if (!fs.existsSync(dir)) return null;
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[r] = `L:${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) { out[r] = 'D'; walk(p, r); }
      else out[r] = `F:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
    }
  };
  walk(dir, '');
  return out;
}
const linksOf = (s: Record<string, string>): string[] =>
  Object.keys(s).filter((k) => s[k].startsWith('L:')).sort();
const mcpOf = (login: string): string[] =>
  Object.keys((JSON.parse(fs.readFileSync(path.join(login, '.claude.json'), 'utf8')) as any).mcpServers ?? {}).sort();
const manifestOf = (login: string): { symlinks: string[]; mcpServers: string[] } => {
  const m = JSON.parse(fs.readFileSync(path.join(login, '.orchestra-inherited.json'), 'utf8'));
  return { symlinks: [...m.symlinks].sort(), mcpServers: m.mcpServers }; // link order is insertion order — compare sorted
};

const manifestPath = (login: string): string => path.join(login, '.orchestra-inherited.json');
const stampOf = (login: string): string | undefined => JSON.parse(fs.readFileSync(manifestPath(login), 'utf8')).source;
/** A manifest as written before #235/D10 (no `source`). */
function unstamp(login: string): void {
  const m = JSON.parse(fs.readFileSync(manifestPath(login), 'utf8'));
  delete m.source;
  fs.writeFileSync(manifestPath(login), JSON.stringify(m, null, 2));
}

/** A login dir shaped like the live one: real sync with the source present, then
 *  user-owned state (own MCP server, project trust, a real file) the sync must keep. */
async function buildLiveMirror(rig: Rig): Promise<Record<string, string>> {
  makeSource(rig.home);
  put(path.join(rig.login, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"scratch"}}');
  assert.deepEqual(await runSync(rig, FULL), [], 'building the mirror must not warn');
  const cj = path.join(rig.login, '.claude.json');
  const d = JSON.parse(fs.readFileSync(cj, 'utf8'));
  d.projects = { '/scratch/proj': { hasTrustDialogAccepted: true } };
  d.mcpServers['my-own'] = { command: 'mine' };
  fs.writeFileSync(cj, JSON.stringify(d, null, 2));
  const snap = snapshot(rig.login)!;
  // Positive controls: the mirror really holds what the incident wiped.
  assert.deepEqual(linksOf(snap), LINKS, 'mirror: 7 inherited symlinks');
  assert.deepEqual(mcpOf(rig.login), ['chrome-devtools', 'github', 'linear-server', 'my-own'], 'mirror: injected + own MCP');
  assert.deepEqual(manifestOf(rig.login), { symlinks: LINKS, mcpServers: ['github', 'linear-server', 'chrome-devtools'] });
  return snap;
}

type Variant = 'absent' | 'file' | 'dangling' | 'eacces';
function breakSource(home: string, v: Variant): void {
  const g = path.join(home, '.claude');
  assertScratch(g);
  fs.rmSync(g, { recursive: true, force: true });
  if (v === 'file') put(g, 'not a directory');
  else if (v === 'dangling') fs.symlinkSync(path.join(home, 'nowhere'), g);
  else if (v === 'eacces') {
    fs.mkdirSync(g);
    fs.chmodSync(g, 0o000);
    assert.throws(() => fs.readdirSync(g), /EACCES/, 'precondition: source really is unreadable');
  }
}

const noteSourceWarn = (warns: string[], rig: Rig, what = '.claude'): void => {
  assert.equal(warns.length, 1, `exactly ONE warn, got ${warns.length}: ${JSON.stringify(warns)}`);
  // `… is missing`, not a bare prefix match: the login dir `<home>/.claude-mc` also starts with `<home>/.claude`.
  assert.ok(warns[0].includes(`${path.join(rig.home, what)} is missing`), `warn names the missing source: ${warns[0]}`);
};

// ---- must-FAIL on master: the login dir survives a missing/unreadable source ---

const NOOP_VARIANTS: Array<[string, Variant, boolean, { skip?: string }]> = [
  ['fake HOME: ~/.claude AND ~/.claude.json absent (the incident)', 'absent', false, {}],
  ['~/.claude absent, ~/.claude.json present', 'absent', true, {}],
  ['~/.claude is a regular file (ENOTDIR)', 'file', true, {}],
  ['~/.claude is a dangling symlink', 'dangling', true, {}],
  ['~/.claude mode 000 (EACCES)', 'eacces', true, process.getuid?.() === 0 ? { skip: 'root bypasses mode bits' } : {}],
];
for (const [name, variant, keepJson, opts] of NOOP_VARIANTS) {
  test(`#235 no-op on live mirror — ${name}`, opts, async () => {
    const rig = newRig();
    const before = await buildLiveMirror(rig);
    breakSource(rig.home, variant);
    if (!keepJson) fs.rmSync(path.join(rig.home, '.claude.json'));
    const warns = await runSync(rig, FULL);
    const after_ = snapshot(rig.login)!;
    assert.deepEqual(linksOf(after_), LINKS, 'symlinks not unlinked');
    assert.deepEqual(mcpOf(rig.login), ['chrome-devtools', 'github', 'linear-server', 'my-own'], 'MCP servers not removed');
    assert.deepEqual(manifestOf(rig.login), { symlinks: LINKS, mcpServers: ['github', 'linear-server', 'chrome-devtools'] }, 'manifest not reset');
    assert.deepEqual(after_, before, 'whole login dir byte-identical');
    noteSourceWarn(warns, rig);
    // Recoverable: source comes back → the next sync still works from the surviving manifest.
    try { fs.chmodSync(path.join(rig.home, '.claude'), 0o755); } catch { /* absent / dangling / file */ }
    fs.rmSync(path.join(rig.home, '.claude'), { recursive: true, force: true });
    makeSource(rig.home);
    assert.deepEqual(await runSync(rig, FULL), [], 'source back → no warn');
    assert.deepEqual(snapshot(rig.login), before, 'source back → same links/MCP/manifest');
  });
}

// One arm per destructive step, each reachable ONLY through that step.
test('#235 step: symlink PRUNE (removeOurSymlink) skipped — inherit empty, manifest lists links', async () => {
  const rig = newRig();
  const g = path.join(rig.home, '.claude');
  for (const rel of ['settings.json', 'skills/handoff']) {
    fs.mkdirSync(path.dirname(path.join(rig.login, rel)), { recursive: true });
    fs.symlinkSync(path.join(g, rel), path.join(rig.login, rel));
  }
  put(path.join(rig.login, '.orchestra-inherited.json'), JSON.stringify({ symlinks: ['settings.json', 'skills/handoff'], mcpServers: [] }));
  const before = snapshot(rig.login);
  const warns = await runSync(rig, undefined);
  assert.deepEqual(linksOf(snapshot(rig.login)!), ['settings.json', 'skills/handoff'], 'prune must not unlink');
  assert.deepEqual(snapshot(rig.login), before);
  noteSourceWarn(warns, rig);
});

test('#235 step: dangling-link DROP (ensureSymlink source-gone unlink) skipped — link still wanted', async () => {
  const rig = newRig();
  fs.mkdirSync(rig.login, { recursive: true });
  fs.symlinkSync(path.join(rig.home, '.claude', 'settings.json'), path.join(rig.login, 'settings.json'));
  put(path.join(rig.login, '.orchestra-inherited.json'), JSON.stringify({ symlinks: ['settings.json'], mcpServers: [] }));
  const before = snapshot(rig.login);
  const warns = await runSync(rig, { settings: true });
  assert.deepEqual(linksOf(snapshot(rig.login)!), ['settings.json'], 'wanted link must not be dropped');
  assert.deepEqual(snapshot(rig.login), before);
  noteSourceWarn(warns, rig);
});

test('#235 step: MCP removal (syncMcpServers toRemove) skipped — nothing wanted, manifest lists servers', async () => {
  const rig = newRig();
  put(path.join(rig.login, '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'gh' }, 'my-own': { command: 'm' } }, projects: { '/p': {} } }, null, 2));
  put(path.join(rig.login, '.orchestra-inherited.json'), JSON.stringify({ symlinks: [], mcpServers: ['github'] }));
  const before = snapshot(rig.login);
  const warns = await runSync(rig, undefined);
  assert.deepEqual(mcpOf(rig.login), ['github', 'my-own'], 'injected server must not be removed');
  assert.deepEqual(snapshot(rig.login), before);
  noteSourceWarn(warns, rig);
});

test('#235 step: MANIFEST write skipped — nothing else to change', async () => {
  const rig = newRig();
  put(path.join(rig.login, '.orchestra-inherited.json'), JSON.stringify({ symlinks: ['settings.json'], mcpServers: [] }));
  const before = snapshot(rig.login);
  const warns = await runSync(rig, undefined);
  assert.deepEqual(manifestOf(rig.login), { symlinks: ['settings.json'], mcpServers: [] }, 'manifest not reset');
  assert.deepEqual(snapshot(rig.login), before);
  noteSourceWarn(warns, rig);
});

test('#235 step: nothing is CREATED either — absent login dir stays absent', async () => {
  const rig = newRig();
  const warns = await runSync(rig, FULL);
  assert.equal(fs.existsSync(rig.login), false, 'no mkdir / manifest in a login dir we did not have');
  noteSourceWarn(warns, rig);
});

// ---- must-PASS: source present → behaviour unchanged ---------------------------

test('#235 source present: fresh login dir gets links + MCP + manifest, no warn', async () => {
  const rig = newRig();
  makeSource(rig.home);
  const warns = await runSync(rig, FULL);
  assert.deepEqual(warns, []);
  const snap = snapshot(rig.login)!;
  assert.deepEqual(linksOf(snap), LINKS);
  assert.equal(snap['settings.json'], `L:${path.join(rig.home, '.claude', 'settings.json')}`);
  assert.deepEqual(mcpOf(rig.login), ['chrome-devtools', 'github', 'linear-server']);
  assert.deepEqual(manifestOf(rig.login), { symlinks: LINKS, mcpServers: ['github', 'linear-server', 'chrome-devtools'] });
  assert.equal(stampOf(rig.login), path.join(rig.home, '.claude'), 'first sync on a FRESH account stamps its source');
});

test('#235 source present: a de-selected link/MCP server IS still pruned (intended prune)', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  const warns = await runSync(rig, { settings: true, skills: ['frontend-design'] });
  assert.deepEqual(warns, []);
  assert.deepEqual(linksOf(snapshot(rig.login)!), ['CLAUDE.md', 'LESSONS.md', 'RTK.md', 'settings.json', 'skills/frontend-design']);
  assert.deepEqual(mcpOf(rig.login), ['my-own'], 'injected servers gone, the user\'s own kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rig.login, '.claude.json'), 'utf8')).projects, { '/scratch/proj': { hasTrustDialogAccepted: true } });
  assert.deepEqual(manifestOf(rig.login), { symlinks: ['CLAUDE.md', 'LESSONS.md', 'RTK.md', 'settings.json', 'skills/frontend-design'], mcpServers: [] });
});

test('#235 source present: everything de-selected IN THE UI → every manifest link pruned', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  assert.deepEqual(await runSync(rig, undefined, { userDeselected: true }), []);
  assert.deepEqual(linksOf(snapshot(rig.login)!), []);
  assert.deepEqual(manifestOf(rig.login), { symlinks: [], mcpServers: [] });
});

test('#235 source present: a skill deleted from the source has its dangling link dropped', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  fs.rmSync(path.join(rig.home, '.claude', 'skills', 'handoff'), { recursive: true });
  assert.deepEqual(await runSync(rig, FULL), []);
  assert.deepEqual(linksOf(snapshot(rig.login)!), LINKS.filter((l) => l !== 'skills/handoff'));
  assert.deepEqual(manifestOf(rig.login).symlinks, LINKS.filter((l) => l !== 'skills/handoff'));
});

// ---- the MCP source (~/.claude.json) is a second source: same rule -------------

for (const [name, write] of [
  ['~/.claude.json absent', (p: string) => fs.rmSync(p)],
  ['~/.claude.json unparseable (torn read)', (p: string) => fs.writeFileSync(p, '{"mcpServers": {"github": {"comm')],
] as Array<[string, (p: string) => void]>) {
  test(`#235 MCP source missing — ${name}: MCP servers + manifest kept, ONE warn`, async () => {
    const rig = newRig();
    const before = await buildLiveMirror(rig);
    write(path.join(rig.home, '.claude.json'));
    const warns = await runSync(rig, FULL);
    assert.deepEqual(mcpOf(rig.login), ['chrome-devtools', 'github', 'linear-server', 'my-own'], 'MCP servers not removed');
    assert.deepEqual(manifestOf(rig.login).mcpServers, ['github', 'linear-server', 'chrome-devtools'], 'manifest MCP list kept');
    assert.deepEqual(snapshot(rig.login), before);
    noteSourceWarn(warns, rig, '.claude.json');
  });
}

test('#235 MCP source present but no servers → injected servers ARE removed (intended prune)', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  fs.writeFileSync(path.join(rig.home, '.claude.json'), '{}');
  await runSync(rig, FULL);
  assert.deepEqual(mcpOf(rig.login), ['my-own']);
  assert.deepEqual(manifestOf(rig.login).mcpServers, []);
});

// ---- D10: a login dir built from ANOTHER source is never rewritten -------------
//
// Incident geometry: the live account's links point into the REAL home's `.claude`; a fake-HOME
// app syncs it from `<fakeHOME>/.claude` — a readable source the app itself creates.

const SKELETON_JSON = '{"numStartups":1}';
const putSkeleton = (h: string): void => {
  put(path.join(h, '.claude', 'CLAUDE.md'), '@LESSONS.md\n');
  put(path.join(h, '.claude', 'LESSONS.md'), '# lessons (bootstrap)\n');
  fs.mkdirSync(path.join(h, '.claude', 'usage-data'));
};
const SHAPES: Array<[string, (fakeHome: string) => void]> = [
  ['S1 CLI-created (`claude -p`: backups/ sessions/ projects/ + server-less .claude.json)', (h) => {
    for (const d of ['backups', 'sessions', 'projects']) fs.mkdirSync(path.join(h, '.claude', d), { recursive: true });
    put(path.join(h, '.claude.json'), SKELETON_JSON);
  }],
  ['S2 self-tune skeleton (CLAUDE.md + LESSONS.md + usage-data/)', (h) => { putSkeleton(h); put(path.join(h, '.claude.json'), SKELETON_JSON); }],
  ['S3 empty ~/.claude', (h) => fs.mkdirSync(path.join(h, '.claude'), { recursive: true })],
  ['S4 CLAUDE.md only', (h) => put(path.join(h, '.claude', 'CLAUDE.md'), '# memory only\n')],
  ['S5 every file but no skills/ dir', (h) => { makeSource(h); fs.rmSync(path.join(h, '.claude', 'skills'), { recursive: true }); }],
];
const fakeOf = (real: Rig): Rig => {
  const fake = { home: path.join(path.dirname(real.home), 'fakehome'), login: real.login }; // absolute configDir, outside both homes
  fs.mkdirSync(fake.home);
  return fake;
};
const warnNames = (warns: string[], ...paths: string[]): void => {
  assert.equal(warns.length, 1, `exactly ONE warn, got ${JSON.stringify(warns)}`);
  // Boundary, not a bare substring: the login dir `<home>/.claude-mc` also starts with `<home>/.claude`.
  for (const p of paths) {
    assert.ok(new RegExp(`${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`).test(warns[0]), `warn names ${p}: ${warns[0]}`);
  }
};

for (const legacy of [false, true]) {
  for (const [name, shape] of SHAPES) {
    test(`#235/D10 ${legacy ? 'legacy' : 'stamped'} manifest, source shape ${name}: live-like target untouched, ONE warn`, async () => {
      const real = newRig();
      await buildLiveMirror(real); // built under the REAL home
      if (legacy) unstamp(real.login);
      const before = snapshot(real.login)!;
      const fake = fakeOf(real);
      shape(fake.home);
      const warns = await runSync(fake, FULL); // synced under the FAKE home
      const after_ = snapshot(real.login)!;
      assert.deepEqual(linksOf(after_), LINKS, 'no link stripped');
      assert.deepEqual(after_, before, 'byte-identical: nothing repointed into the fake HOME, MCP + manifest untouched');
      warnNames(warns, path.join(real.home, '.claude'), path.join(fake.home, '.claude'));
      assert.ok(warns[0].includes(`built from ${path.join(real.home, '.claude')}, not ${path.join(fake.home, '.claude')}`), `names the source DIR, not a link-target file: ${warns[0]}`);
    });
  }
}

// ---- D10/P2: where master self-heals, the guard must not refuse forever --------

for (const legacy of [false, true]) {
  test(`#235/D10 ${legacy ? 'legacy' : 'stamped'} manifest, HOME moved (h1 → h2, old source GONE): re-homed like master, not refused`, async () => {
    const rig = newRig();
    await buildLiveMirror(rig);
    if (legacy) unstamp(rig.login);
    const home2 = path.join(path.dirname(rig.home), 'home2');
    fs.renameSync(rig.home, home2); // the login dir (inside HOME) moves too; its links + stamp still name h1
    assert.equal(fs.existsSync(path.join(rig.home, '.claude')), false, 'precondition: the old source is gone');
    const moved = { home: home2, login: path.join(home2, '.claude-mc') };
    assert.deepEqual(await runSync(moved, FULL), []);
    const snap = snapshot(moved.login)!;
    assert.deepEqual(linksOf(snap), LINKS);
    assert.equal(snap['settings.json'], `L:${path.join(home2, '.claude', 'settings.json')}`, 'links now point at the new HOME');
    assert.equal(stampOf(moved.login), path.join(home2, '.claude'));
  });
}

test('#235/D10 poisoned stamp: a fake-HOME app stamped a never-synced live dir, its scratch HOME is deleted → the real sync heals', async () => {
  const real = newRig();
  makeSource(real.home);
  put(path.join(real.login, '.credentials.json'), '{"scratch":true}');
  const fake = fakeOf(real);
  makeSource(fake.home);
  assert.deepEqual(await runSync(fake, FULL), [], 'first sync on a fresh dir writes (fresh-account rule)');
  assert.equal(stampOf(real.login), path.join(fake.home, '.claude'), 'precondition: stamped with the FAKE source');
  fs.rmSync(fake.home, { recursive: true, force: true });
  assert.deepEqual(await runSync(real, FULL), []);
  assert.equal(snapshot(real.login)!['settings.json'], `L:${path.join(real.home, '.claude', 'settings.json')}`);
  assert.equal(stampOf(real.login), path.join(real.home, '.claude'));
});

test('#235/D10 legacy manifest + HOME alias + ONE dangling link (its source file was deleted): still ours', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  unstamp(rig.login);
  fs.rmSync(path.join(rig.home, '.claude', 'RTK.md')); // link RTK.md now dangles; CLAUDE.md still imports it
  const alias = path.join(path.dirname(rig.home), 'homealias');
  fs.symlinkSync(rig.home, alias);
  assert.deepEqual(await runSync({ home: alias, login: rig.login }, FULL), []);
  assert.deepEqual(linksOf(snapshot(rig.login)!), LINKS.filter((l) => l !== 'RTK.md'), 'dangling link dropped as on master');
});

test('#235/D10 stamped source that EXISTS but cannot be resolved (symlink loop) → refused, fail closed', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  const loop = path.join(path.dirname(rig.home), 'loop');
  fs.symlinkSync(loop, loop);
  const m = JSON.parse(fs.readFileSync(manifestPath(rig.login), 'utf8'));
  fs.writeFileSync(manifestPath(rig.login), JSON.stringify({ ...m, source: loop }, null, 2));
  const before = snapshot(rig.login);
  const warns = await runSync(rig, FULL);
  assert.deepEqual(snapshot(rig.login), before);
  warnNames(warns, loop);
});

// ---- D10/P4: pin the legacy link check's own clauses ---------------------------

const relink = (login: string, rel: string, to: string): void => {
  fs.rmSync(path.join(login, rel), { force: true });
  fs.mkdirSync(path.dirname(path.join(login, rel)), { recursive: true });
  fs.symlinkSync(to, path.join(login, rel));
};

test('#235/D10 legacy link into a SIBLING dir `.claude-x` (string prefix of `.claude`) is foreign → refused', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  unstamp(rig.login);
  put(path.join(rig.home, '.claude-x', 'RTK.md'), '# not ours\n');
  relink(rig.login, 'RTK.md', path.join(rig.home, '.claude-x', 'RTK.md'));
  const before = snapshot(rig.login);
  const warns = await runSync(rig, FULL);
  assert.deepEqual(snapshot(rig.login), before);
  warnNames(warns, path.join(rig.home, '.claude-x'));
});

test('#235/D10 legacy RELATIVE links: into our source → proceeds; into a foreign dir → refused (resolved against the LINK dir)', async () => {
  const ours = newRig();
  await buildLiveMirror(ours);
  unstamp(ours.login);
  for (const rel of LINKS.filter((l) => !l.includes('/'))) relink(ours.login, rel, path.join('..', '.claude', rel)); // login = <home>/.claude-mc
  assert.deepEqual(await runSync(ours, { settings: true }), [], 'relative links into our own source are ours');
  assert.deepEqual(linksOf(snapshot(ours.login)!), ['CLAUDE.md', 'LESSONS.md', 'RTK.md', 'settings.json']);

  const foreign = newRig();
  await buildLiveMirror(foreign);
  unstamp(foreign.login);
  put(path.join(path.dirname(foreign.home), 'elsewhere', '.claude', 'settings.json'), '{}');
  relink(foreign.login, 'settings.json', path.join('..', '..', 'elsewhere', '.claude', 'settings.json')); // → <t>/elsewhere/.claude/settings.json
  const before = snapshot(foreign.login);
  const warns = await runSync(foreign, FULL);
  assert.deepEqual(snapshot(foreign.login), before);
  warnNames(warns, path.join(path.dirname(foreign.home), 'elsewhere', '.claude'));
});

test('#235/D10 legacy SKILLS-only account whose links point at another home → refused', async () => {
  const real = newRig();
  makeSource(real.home);
  await runSync(real, { skills: ['frontend-design', 'handoff'] });
  unstamp(real.login);
  const before = snapshot(real.login)!;
  assert.deepEqual(linksOf(before), ['skills/frontend-design', 'skills/handoff']);
  const fake = fakeOf(real);
  fs.mkdirSync(path.join(fake.home, '.claude'));
  const warns = await runSync(fake, { skills: ['frontend-design', 'handoff'] });
  assert.deepEqual(snapshot(real.login), before);
  warnNames(warns, path.join(real.home, '.claude'));
});

test('#235/D10 stamped MCP-only account (no links): refused too', async () => {
  const real = newRig();
  makeSource(real.home);
  await runSync(real, { mcpServers: ['github', 'linear-server'] });
  const before = snapshot(real.login)!;
  const fake = fakeOf(real);
  put(path.join(fake.home, '.claude', 'CLAUDE.md'), '# x\n');
  put(path.join(fake.home, '.claude.json'), SKELETON_JSON);
  const warns = await runSync(fake, { mcpServers: ['github', 'linear-server'] });
  assert.deepEqual(mcpOf(real.login), ['github', 'linear-server']);
  assert.deepEqual(snapshot(real.login), before);
  warnNames(warns, path.join(real.home, '.claude'));
});

test('#235/D10 legacy manifest with ONE foreign link among ours → refused (any, not all)', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  unstamp(rig.login);
  const other = path.join(path.dirname(rig.home), 'other', '.claude', 'RTK.md');
  put(other, '# foreign, still exists\n'); // a dangling foreign target is no evidence (P2)
  fs.unlinkSync(path.join(rig.login, 'RTK.md'));
  fs.symlinkSync(other, path.join(rig.login, 'RTK.md'));
  const before = snapshot(rig.login);
  const warns = await runSync(rig, FULL); // same HOME as 6 of the 7 links
  assert.deepEqual(snapshot(rig.login), before);
  warnNames(warns, path.dirname(other));
});

for (const legacy of [false, true]) {
  test(`#235/D10 ${legacy ? 'legacy' : 'stamped'} manifest, same source via an ALIAS of HOME: still ours → de-selection prunes`, async () => {
    const rig = newRig();
    await buildLiveMirror(rig);
    if (legacy) unstamp(rig.login);
    const alias = path.join(path.dirname(rig.home), 'homealias');
    fs.symlinkSync(rig.home, alias);
    const warns = await runSync({ home: alias, login: rig.login }, { settings: true }); // statusline + skills unchecked
    assert.deepEqual(warns, []);
    assert.deepEqual(linksOf(snapshot(rig.login)!), ['CLAUDE.md', 'LESSONS.md', 'RTK.md', 'settings.json']);
    assert.equal(stampOf(rig.login), path.join(alias, '.claude'), 're-stamped');
  });
}

test('#235/D10 legacy manifest, same source: de-selection prunes and the sync stamps `source`', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  unstamp(rig.login);
  assert.equal(stampOf(rig.login), undefined, 'precondition: legacy');
  assert.deepEqual(await runSync(rig, { ...FULL, skills: ['frontend-design'] }), []);
  assert.deepEqual(linksOf(snapshot(rig.login)!), LINKS.filter((l) => l !== 'skills/handoff'));
  assert.equal(stampOf(rig.login), path.join(rig.home, '.claude'));
});

test('#235/D10 re-home: refusal names the manifest to delete, and deleting it lets the sync proceed', async () => {
  const real = newRig();
  await buildLiveMirror(real);
  const fake = fakeOf(real);
  makeSource(fake.home);
  const warns = await runSync(fake, FULL);
  warnNames(warns, '.orchestra-inherited.json');
  fs.rmSync(manifestPath(real.login));
  assert.deepEqual(await runSync(fake, FULL), []);
  assert.equal(snapshot(real.login)!['settings.json'], `L:${path.join(fake.home, '.claude', 'settings.json')}`, 're-homed onto the new source');
  assert.equal(stampOf(real.login), path.join(fake.home, '.claude'));
});

test('#235 MCP source missing, NOTHING selected, manifest lists servers → kept + ONE warn', async () => {
  const rig = newRig();
  const before = await buildLiveMirror(rig);
  fs.rmSync(path.join(rig.home, '.claude.json'));
  const warns = await runSync(rig, { ...FULL, mcpServers: undefined });
  assert.deepEqual(mcpOf(rig.login), ['chrome-devtools', 'github', 'linear-server', 'my-own']);
  assert.deepEqual(snapshot(rig.login), before);
  warnNames(warns, path.join(rig.home, '.claude.json'));
});

test('#235 symlinked source (~/.claude → real dir, dotfiles-style) is a normal readable source', async () => {
  const rig = newRig();
  makeSource(rig.home);
  const dotfiles = path.join(path.dirname(rig.home), 'dotfiles-claude');
  fs.renameSync(path.join(rig.home, '.claude'), dotfiles);
  fs.symlinkSync(dotfiles, path.join(rig.home, '.claude'));
  assert.deepEqual(await runSync(rig, FULL), []);
  assert.deepEqual(linksOf(snapshot(rig.login)!), LINKS);
  assert.deepEqual(await runSync(rig, { settings: true }), []);
  assert.deepEqual(linksOf(snapshot(rig.login)!), ['CLAUDE.md', 'LESSONS.md', 'RTK.md', 'settings.json']);
});

// ---- #235 residual / C10: an EMPTY selection is a de-selection only when the UI setter says so ----
//
// Incident #3 (2026-09-29): the live `~/.claude-mc` was stripped by a real-HOME sync of an account whose
// `inherit` was empty/absent. Same source, so the D10 provenance guard cannot see it. Every arm below
// runs the REAL module against SCRATCH dirs (assertScratch inside runSync); `EMPTIES` are the shapes
// `isEmptyAccountInherit` must all read as "nothing selected".

const EMPTIES: Array<[string, Inherit | undefined]> = [
  ['absent', undefined],
  ['{}', {}],
  ['all-false / empty lists', { settings: false, statusline: false, skills: [], mcpServers: [] }],
];
const CALLERS = ['boot', 'spawn-sdk', 'spawn-pty', 'migrate', 'sandbox-import', 'login', 'ui-save'];

/** The ONE blocked-prune warn: names the dir, the held counts and WHO synced (attribution). */
function blockedWarn(warns: string[], rig: Rig, caller: string, links: number, mcp: number): void {
  assert.equal(warns.length, 1, `exactly ONE warn, got ${JSON.stringify(warns)}`);
  const w = warns[0];
  assert.ok(w.includes(`${rig.login} holds ${links} inherited link(s) + ${mcp} MCP server(s)`), `names the dir + counts: ${w}`);
  assert.ok(w.includes(`caller=${caller} `), `names the caller: ${w}`);
  assert.ok(w.includes(`pid=${process.pid} `) && w.includes(`HOME=${rig.home} `) && w.includes('ORCHESTRA_HOME='), `carries pid/HOME/ORCHESTRA_HOME: ${w}`);
}

for (const [name, empty] of EMPTIES) {
  test(`C10 must-FAIL on master: empty selection (${name}), non-UI caller, live-shaped mirror → nothing written, ONE warn`, async () => {
    const rig = newRig();
    const before = await buildLiveMirror(rig);
    const warns = await runSync(rig, empty, { caller: 'spawn-sdk' });
    assert.deepEqual(snapshot(rig.login), before, 'whole login dir byte-identical (links, MCP, manifest, trust)');
    assert.deepEqual(linksOf(snapshot(rig.login)!), LINKS);
    assert.deepEqual(mcpOf(rig.login), ['chrome-devtools', 'github', 'linear-server', 'my-own']);
    blockedWarn(warns, rig, 'spawn-sdk', 7, 3);
    // Recoverable: the next real selection re-syncs from the surviving manifest, no warn.
    assert.deepEqual(await runSync(rig, FULL, { caller: 'spawn-sdk' }), []);
    assert.deepEqual(snapshot(rig.login), before, 'a normal selection afterwards changes nothing');
  });
}

for (const caller of [...CALLERS, undefined]) {
  test(`C10 every caller tag is blocked (caller=${caller ?? '<none>'}) and named in the warn`, async () => {
    const rig = newRig();
    const before = await buildLiveMirror(rig);
    const warns = await runSync(rig, undefined, caller === undefined ? undefined : { caller });
    assert.deepEqual(snapshot(rig.login), before);
    blockedWarn(warns, rig, caller ?? 'unknown', 7, 3);
  });
}

for (const [name, empty] of EMPTIES) {
  test(`C10 must-PASS: UI de-select-all (${name}) still prunes every inherited link + injected MCP server`, async () => {
    const rig = newRig();
    await buildLiveMirror(rig);
    assert.deepEqual(await runSync(rig, empty, { userDeselected: true, caller: 'ui-save' }), [], 'no warn');
    assert.deepEqual(linksOf(snapshot(rig.login)!), [], 'every link pruned');
    assert.deepEqual(mcpOf(rig.login), ['my-own'], "injected servers gone, the user's own kept");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rig.login, '.claude.json'), 'utf8')).projects, { '/scratch/proj': { hasTrustDialogAccepted: true } });
    assert.deepEqual(manifestOf(rig.login), { symlinks: [], mcpServers: [] });
    assert.equal(stampOf(rig.login), path.join(rig.home, '.claude'));
  });
}

test('C10 a PARTIAL de-selection (non-empty selection) from a non-UI caller still prunes — the guard is scoped to EMPTY', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  assert.deepEqual(await runSync(rig, { settings: true, skills: ['frontend-design'] }, { caller: 'spawn-pty' }), []);
  assert.deepEqual(linksOf(snapshot(rig.login)!), ['CLAUDE.md', 'LESSONS.md', 'RTK.md', 'settings.json', 'skills/frontend-design']);
  assert.deepEqual(mcpOf(rig.login), ['my-own']);
  assert.deepEqual(manifestOf(rig.login), { symlinks: ['CLAUDE.md', 'LESSONS.md', 'RTK.md', 'settings.json', 'skills/frontend-design'], mcpServers: [] });
});

test('C10 a link the user removed on purpose: hand-removed link/servers over an EMPTY selection are reconciled, not resurrected', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  for (const rel of LINKS) fs.unlinkSync(path.join(rig.login, rel)); // user rm'd every link by hand …
  const cj = path.join(rig.login, '.claude.json');
  const d = JSON.parse(fs.readFileSync(cj, 'utf8'));
  d.mcpServers = { 'my-own': d.mcpServers['my-own'] }; // … and every injected server
  fs.writeFileSync(cj, JSON.stringify(d, null, 2));
  assert.deepEqual(await runSync(rig, undefined, { caller: 'spawn-sdk' }), [], 'nothing held → no block, no warn');
  assert.deepEqual(linksOf(snapshot(rig.login)!), [], 'not resurrected');
  assert.deepEqual(mcpOf(rig.login), ['my-own']);
  assert.deepEqual(manifestOf(rig.login), { symlinks: [], mcpServers: [] }, 'manifest reconciled');
});

test('C10 held clause "links": a skills-only account (links, no MCP) is protected; ONE link left is enough', async () => {
  const rig = newRig();
  makeSource(rig.home);
  assert.deepEqual(await runSync(rig, { skills: ['frontend-design', 'handoff'] }), []);
  const before = snapshot(rig.login)!;
  assert.deepEqual(linksOf(before), ['skills/frontend-design', 'skills/handoff']);
  assert.equal(manifestOf(rig.login).mcpServers.length, 0, 'precondition: no MCP in the manifest');
  blockedWarn(await runSync(rig, undefined, { caller: 'boot' }), rig, 'boot', 2, 0);
  assert.deepEqual(snapshot(rig.login), before);
  fs.unlinkSync(path.join(rig.login, 'skills', 'handoff'));
  const one = snapshot(rig.login)!;
  blockedWarn(await runSync(rig, undefined, { caller: 'boot' }), rig, 'boot', 1, 0);
  assert.deepEqual(snapshot(rig.login), one);
});

test('C10 held clause "mcp": an MCP-only account (no links) is protected too', async () => {
  const rig = newRig();
  makeSource(rig.home);
  assert.deepEqual(await runSync(rig, { mcpServers: ['github', 'linear-server'] }), []);
  const before = snapshot(rig.login)!;
  assert.deepEqual(linksOf(before), [], 'precondition: no links');
  blockedWarn(await runSync(rig, undefined, { caller: 'boot' }), rig, 'boot', 0, 2);
  assert.deepEqual(mcpOf(rig.login), ['github', 'linear-server']);
  assert.deepEqual(snapshot(rig.login), before);
});

test('C10 held-by-PRESENCE, links: manifest lists links that are all gone (skills-only) → not blocked, manifest reconciled', async () => {
  const rig = newRig();
  makeSource(rig.home);
  await runSync(rig, { skills: ['frontend-design', 'handoff'] });
  fs.unlinkSync(path.join(rig.login, 'skills', 'frontend-design'));
  fs.unlinkSync(path.join(rig.login, 'skills', 'handoff'));
  assert.deepEqual(await runSync(rig, undefined, { caller: 'boot' }), []);
  assert.deepEqual(manifestOf(rig.login), { symlinks: [], mcpServers: [] });
});

test('C10 held-by-PRESENCE, mcp: manifest lists servers that are all gone from .claude.json (mcp-only) → not blocked, manifest reconciled', async () => {
  const rig = newRig();
  makeSource(rig.home);
  await runSync(rig, { mcpServers: ['github', 'linear-server'] });
  fs.writeFileSync(path.join(rig.login, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: { '/p': {} } }));
  assert.deepEqual(await runSync(rig, undefined, { caller: 'boot' }), []);
  assert.deepEqual(manifestOf(rig.login), { symlinks: [], mcpServers: [] });
});

test('C10 unchanged: empty selection on a fresh dir / a dir with no manifest still creates the dir + manifest, no warn', async () => {
  const rig = newRig();
  makeSource(rig.home);
  assert.deepEqual(await runSync(rig, undefined, { caller: 'spawn-sdk' }), []);
  assert.deepEqual(manifestOf(rig.login), { symlinks: [], mcpServers: [] });
  assert.equal(stampOf(rig.login), path.join(rig.home, '.claude'), 'first sync stamps its source');
});

test('C10 the D10 provenance guard still comes FIRST — even a UI de-selection cannot rewrite a dir built from another source', async () => {
  const real = newRig();
  await buildLiveMirror(real);
  const before = snapshot(real.login)!;
  const fake = fakeOf(real);
  putSkeleton(fake.home);
  put(path.join(fake.home, '.claude.json'), SKELETON_JSON); // a READABLE, server-less MCP source: without it the C10 guard would not fire either (unreadable source keeps the held servers)
  for (const opts of [{ caller: 'boot' }, { userDeselected: true, caller: 'ui-save' }]) {
    const warns = await runSync(fake, undefined, opts);
    assert.deepEqual(snapshot(real.login), before, `untouched (${JSON.stringify(opts)})`);
    warnNames(warns, path.join(real.home, '.claude'), path.join(fake.home, '.claude'));
    assert.ok(warns[0].includes('built from'), `the D10 warn, not the C10 one: ${warns[0]}`);
  }
});

// ---- the UI setter's own step (`syncAfterAccountsSave`): per-ACCOUNT authority, driven through the real module ----

const setStore = (accounts: Acct[]): void => { (globalThis as any).__a8Store.accounts = accounts; };
async function runSave(home: string, before: Acct[], saved: Acct[]): Promise<string[]> {
  assertScratch(home);
  const m = await loadInherit();
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(os.homedir(), home, 'HOME redirect must take effect');
    (globalThis as any).__a8Logs = [] as LogRec[];
    setStore(saved); // the store already holds what the setter just persisted
    await m.syncAfterAccountsSave(before, saved);
    return ((globalThis as any).__a8Logs as LogRec[]).filter((l) => l.level === 'warn').map((l) => l.msg);
  } finally {
    setStore([]);
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}
const acct = (id: string, rig: Rig | { login: string }, inherit?: Inherit): Acct => ({ id, label: id, configDir: rig.login, inherit });
const secondLogin = (rig: Rig, name: string): Rig => ({ home: rig.home, login: path.join(rig.home, name) });

test('C10 setter: non-empty → empty for THIS account prunes it (the user just de-selected everything)', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  assert.deepEqual(await runSave(rig.home, [acct('a', rig, FULL)], [acct('a', rig, undefined)]), []);
  assert.deepEqual(linksOf(snapshot(rig.login)!), []);
  assert.deepEqual(mcpOf(rig.login), ['my-own']);
});

test('C10 setter: empty → empty (an UNRELATED save) does not prune a dir that still holds links; ONE warn names caller=ui-save', async () => {
  const rig = newRig();
  const before = await buildLiveMirror(rig);
  const warns = await runSave(rig.home, [acct('a', rig, undefined)], [acct('a', rig, undefined)]);
  assert.deepEqual(snapshot(rig.login), before);
  blockedWarn(warns, rig, 'ui-save', 7, 3);
});

test('C10 setter: authority is per ACCOUNT — A de-selected prunes, B (already empty, stray links) is kept, C (new) is kept', async () => {
  const a = newRig();
  await buildLiveMirror(a);
  const b = secondLogin(a, '.claude-b');
  const c = secondLogin(a, '.claude-c');
  assert.deepEqual(await runSync(b, FULL), []); // B and C hold links built by a real sync
  assert.deepEqual(await runSync(c, FULL), []);
  const bBefore = snapshot(b.login)!;
  const cBefore = snapshot(c.login)!;
  const warns = await runSave(
    a.home,
    [acct('a', a, FULL), acct('b', b, undefined)], // B was already empty; C does not exist yet
    [acct('a', a, undefined), acct('b', b, undefined), acct('c', c, undefined)],
  );
  assert.deepEqual(linksOf(snapshot(a.login)!), [], 'A pruned');
  assert.deepEqual(snapshot(b.login), bBefore, 'B (no transition) untouched');
  assert.deepEqual(snapshot(c.login), cBefore, 'C (new account, no transition) untouched');
  assert.equal(warns.length, 2, `one warn each for B and C: ${JSON.stringify(warns)}`);
  assert.ok(warns.some((w) => w.includes(b.login)) && warns.some((w) => w.includes(c.login)));
});

test('C10 setter: a non-empty → non-empty edit is a plain sync (prunes only the de-selected item, no warn)', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  assert.deepEqual(await runSave(rig.home, [acct('a', rig, FULL)], [acct('a', rig, { settings: true })]), []);
  assert.deepEqual(linksOf(snapshot(rig.login)!), ['CLAUDE.md', 'LESSONS.md', 'RTK.md', 'settings.json']);
});

// ---- C10 fix round 1 (review of c5600209): the guard keys on EFFECT, the grant on (id, configDir), reads fail CLOSED ----

const VANISHED: Array<[string, Inherit]> = [
  ['skills naming only a missing source', { skills: ['gone'] }],
  ['skills naming only an invalid name (`a/b`)', { skills: ['a/b'] }],
  ['skills naming only `..`', { skills: ['..'] }],
  ['mcpServers naming only a server the global config lacks', { mcpServers: ['nope'] }],
  ['statusline whose source file is missing', { statusline: true }],
];
for (const [name, sel] of VANISHED) {
  test(`C10/F1 effect: ${name} (non-empty selection, would leave nothing) over a live-shaped mirror → nothing written, ONE warn`, async () => {
    const rig = newRig();
    const before = await buildLiveMirror(rig);
    fs.rmSync(path.join(rig.home, '.claude', 'statusline-command.sh')); // the `statusline` source vanished (the other shapes never had one)
    const warns = await runSync(rig, sel, { caller: 'spawn-sdk' });
    assert.deepEqual(snapshot(rig.login), before, 'byte-identical: 7 links + 3 injected MCP survive');
    blockedWarn(warns, rig, 'spawn-sdk', 7, 3);
  });
}

test('C10/F1 effect: a user-owned REAL dir in the only selected slot leaves nothing live → blocked', async () => {
  const rig = newRig();
  makeSource(rig.home);
  put(path.join(rig.home, '.claude', 'skills', 'mine-real', 'SKILL.md'), '# source copy\n');
  assert.deepEqual(await runSync(rig, { skills: ['frontend-design'] }), []);
  put(path.join(rig.login, 'skills', 'mine-real', 'SKILL.md'), '# the user own skill\n');
  const before = snapshot(rig.login)!;
  const warns = await runSync(rig, { skills: ['mine-real'] }, { caller: 'boot' });
  assert.deepEqual(snapshot(rig.login), before, 'the held link is not pruned in exchange for a link that cannot be made');
  blockedWarn(warns, rig, 'boot', 1, 0);
});

test('C10/F1 effect: a SWAP to other existing items leaves something → still applies (UI-save and non-UI), no warn', async () => {
  for (const caller of ['ui-save', 'spawn-pty']) {
    const rig = newRig();
    makeSource(rig.home);
    assert.deepEqual(await runSync(rig, { skills: ['frontend-design'] }), []);
    assert.deepEqual(await runSync(rig, { skills: ['handoff'] }, { caller }), [], `${caller}: no warn`);
    assert.deepEqual(linksOf(snapshot(rig.login)!), ['skills/handoff'], `${caller}: old pruned, new linked`);
  }
});

test('C10/F1 effect: ONE surviving selected item is enough — the rest of a stale selection still prunes', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  assert.deepEqual(await runSync(rig, { skills: ['handoff', 'gone'] }, { caller: 'spawn-sdk' }), []);
  assert.deepEqual(linksOf(snapshot(rig.login)!), ['skills/handoff']);
  assert.deepEqual(mcpOf(rig.login), ['my-own']);
});

test('C10/F1 effect: an UNREADABLE MCP source keeps the held servers, so it is not a full prune — only the existing MCP warn', async () => {
  const rig = newRig();
  makeSource(rig.home);
  assert.deepEqual(await runSync(rig, { mcpServers: ['github', 'linear-server'] }), []);
  const before = snapshot(rig.login)!;
  fs.rmSync(path.join(rig.home, '.claude.json'));
  const warns = await runSync(rig, undefined, { caller: 'boot' });
  assert.equal(warns.length, 1, `exactly ONE warn: ${JSON.stringify(warns)}`);
  assert.ok(warns[0].includes(`${path.join(rig.home, '.claude.json')} is missing or unreadable`), `the MCP-source warn, not the C10 one: ${warns[0]}`);
  assert.deepEqual(mcpOf(rig.login), ['github', 'linear-server']);
  assert.deepEqual(snapshot(rig.login), before);
});

// F2: the grant is (id, configDir), not id.
test('C10/F2 setter: editing configDir to ANOTHER dir AND clearing the boxes in one save does not prune that dir', async () => {
  const a = newRig();
  await buildLiveMirror(a);
  const b = secondLogin(a, '.claude-b');
  assert.deepEqual(await runSync(b, FULL), []);
  const aBefore = snapshot(a.login)!;
  const bBefore = snapshot(b.login)!;
  const warns = await runSave(a.home, [acct('a', a, FULL)], [acct('a', b, undefined)]);
  assert.deepEqual(snapshot(b.login), bBefore, 'the newly named dir is untouched');
  assert.deepEqual(snapshot(a.login), aBefore, 'the old dir is not synced by the save');
  blockedWarn(warns, { ...a, login: b.login }, 'ui-save', 7, 3);
});

test('C10/F2 setter: the SAME dir spelled differently (`..` segment) is still the same dir → the de-selection prunes', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  const respelled = { login: `${rig.login}${path.sep}..${path.sep}${path.basename(rig.login)}` }; // path.join would normalise the `..` away
  assert.notEqual(respelled.login, rig.login);
  assert.deepEqual(await runSave(rig.home, [acct('a', rig, FULL)], [acct('a', respelled, undefined)]), []);
  assert.deepEqual(linksOf(snapshot(rig.login)!), []);
});

// F4: unreadable held state fails CLOSED.
test('C10/F4 fail closed: a TORN login .claude.json over an MCP-only dir + empty selection → blocked, file byte-identical', async () => {
  const rig = newRig();
  makeSource(rig.home);
  assert.deepEqual(await runSync(rig, { mcpServers: ['github', 'linear-server'] }), []);
  fs.writeFileSync(path.join(rig.login, '.claude.json'), '{"mcpServers": {"github": {"comm');
  const before = snapshot(rig.login)!;
  const warns = await runSync(rig, undefined, { caller: 'spawn-pty' });
  assert.deepEqual(snapshot(rig.login), before, 'the torn file is not read as {} and overwritten');
  blockedWarn(warns, rig, 'spawn-pty', 0, 2);
});

test('C10/F4 definite absence is not held: NO login .claude.json (ENOENT) with manifest-listed servers → proceeds, reconciled', async () => {
  const rig = newRig();
  makeSource(rig.home);
  await runSync(rig, { mcpServers: ['github', 'linear-server'] });
  fs.rmSync(path.join(rig.login, '.claude.json'));
  assert.deepEqual(await runSync(rig, undefined, { caller: 'boot' }), []);
  assert.deepEqual(manifestOf(rig.login), { symlinks: [], mcpServers: [] });
});

test('C10/F4 fail closed: an lstat that CANNOT be read (EACCES on skills/) counts the manifest link as held', { skip: process.getuid?.() === 0 ? 'root bypasses mode bits' : undefined }, async () => {
  const rig = newRig();
  makeSource(rig.home);
  assert.deepEqual(await runSync(rig, { skills: ['frontend-design', 'handoff'] }), []);
  const before = snapshot(rig.login)!;
  const skills = path.join(rig.login, 'skills');
  fs.chmodSync(skills, 0o000);
  try {
    assert.throws(() => fs.lstatSync(path.join(skills, 'handoff')), /EACCES/, 'precondition: the link really is unreadable');
    const warns = await runSync(rig, undefined, { caller: 'boot' });
    blockedWarn(warns, rig, 'boot', 2, 0);
  } finally {
    fs.chmodSync(skills, 0o755);
  }
  assert.deepEqual(snapshot(rig.login), before, 'manifest not rewritten to `symlinks: []` while the links still exist');
});

// ---- #238: a torn / concurrently-rewritten login .claude.json is never rebuilt from {} -------------------
//
// Every live CLI of the account rewrites this file, so the sync's read can land mid-write. Before the fix the
// sync parsed a torn read as `{}` and wrote back `{mcpServers}` only (trust flags + oauthAccount erased).

const cjOf = (rig: Rig): string => path.join(rig.login, '.claude.json');
const tmpLeft = (dir: string): string[] => fs.readdirSync(dir).filter((n) => n.includes('.orchestra-tmp-'));
const isTmpArg = (a: unknown[]): boolean => String(a[0]).includes('.claude.json.orchestra-tmp-');
/** The write SEAM of the login .claude.json: its tmp file (fixed build) or the file itself (in-place write on master). */
const isCjWrite = (rig: Rig) => (a: unknown[]): boolean =>
  typeof a[0] === 'string' && path.dirname(a[0]) === rig.login && path.basename(a[0]).startsWith('.claude.json');
/** A realistic CLI-written login file: 2-space JSON, trust flags, oauth state, a user-owned MCP server. */
const CLI_DOC = {
  numStartups: 41,
  oauthAccount: { emailAddress: 'scratch@example.invalid', organizationUuid: 'org-1' },
  projects: { '/scratch/proj': { hasTrustDialogAccepted: true }, '/scratch/other': { hasTrustDialogAccepted: false } },
  mcpServers: { 'my-own': { command: 'mine' } },
};
const cliText = (over: Record<string, unknown> = {}): string => JSON.stringify({ ...CLI_DOC, ...over }, null, 2);
const putCj = (rig: Rig, text: string | Buffer, mtimeSec = 1_700_000_000): void => {
  fs.mkdirSync(rig.login, { recursive: true });
  fs.writeFileSync(cjOf(rig), text);
  fs.utimesSync(cjOf(rig), mtimeSec, mtimeSec); // a whole second: restorable exactly, so a test can isolate the content clause
};
const viewOf = (p: string): { bytes: Buffer | null; mtimeNs: bigint | null } =>
  fs.existsSync(p) ? { bytes: fs.readFileSync(p), mtimeNs: fs.statSync(p, { bigint: true }).mtimeNs } : { bytes: null, mtimeNs: null };
const sameViewOf = (a: ReturnType<typeof viewOf>, b: ReturnType<typeof viewOf>): boolean =>
  a.mtimeNs === b.mtimeNs && (a.bytes === null ? b.bytes === null : b.bytes !== null && a.bytes.equals(b.bytes));

/** Run `act` at the FIRST call of fs.<name> whose args satisfy `match` (the "other writer" landing at exactly that
 *  seam), then delegate to the real call. `fired()` is the instrument control: a hook that never fires proves nothing. */
function hookOnce(name: 'writeFileSync' | 'linkSync' | 'renameSync' | 'openSync', match: (a: unknown[]) => boolean, act: () => void) {
  const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = f[name];
  let n = 0;
  f[name] = function (this: unknown, ...a: unknown[]) {
    if (n === 0 && match(a)) { n++; f[name] = orig; act(); }
    return orig.apply(this, a);
  };
  return { fired: () => n, restore: () => { f[name] = orig; } };
}

const TORN: Array<[string, () => string | Buffer]> = [
  ['truncated mid-key (60% of a real file)', () => cliText().slice(0, Math.floor(cliText().length * 0.6))],
  ['truncated mid-string', () => '{"mcpServers": {"github": {"comm'],
  ["0 bytes (between the CLI's truncate and its write)", () => ''],
  ['whitespace only', () => ' \n'],
  ['NUL-filled (sparse tear)', () => Buffer.alloc(64)],
  ['valid JSON then garbage', () => cliText() + 'x'],
  ['JSON null', () => 'null'],
  ['JSON array', () => '[]'],
  ['JSON string', () => '"x"'],
  ['JSON number', () => '123'],
];
for (const [name, mk] of TORN) {
  test(`#238 torn login .claude.json — ${name}: byte-identical after sync, ONE warn, link half still applied, next sync recovers`, async () => {
    const rig = newRig();
    makeSource(rig.home);
    const bytes = Buffer.from(mk());
    putCj(rig, bytes);
    const warns = await runSync(rig, FULL, { caller: 'spawn-sdk' });
    assert.ok(fs.readFileSync(cjOf(rig)).equals(bytes), 'the file is byte-identical — never rebuilt from {}');
    assert.equal(warns.length, 1, `exactly ONE warn: ${JSON.stringify(warns)}`);
    assert.ok(warns[0].includes(`${cjOf(rig)} is empty or unparseable`), `warn names the file: ${warns[0]}`);
    assert.deepEqual(linksOf(snapshot(rig.login)!), LINKS, 'the symlink half of the sync still ran');
    assert.deepEqual(manifestOf(rig.login), { symlinks: LINKS, mcpServers: [] }, 'the manifest does not claim servers it did not write');
    assert.deepEqual(tmpLeft(rig.login), [], 'no tmp file left behind');
    // The writer finishes; the NEXT sync merges into the whole file and keeps everything the CLI wrote.
    putCj(rig, cliText());
    assert.deepEqual(await runSync(rig, FULL), [], 'file whole again → no warn');
    const d = JSON.parse(fs.readFileSync(cjOf(rig), 'utf8'));
    assert.deepEqual(Object.keys(d.mcpServers).sort(), ['chrome-devtools', 'github', 'linear-server', 'my-own']);
    assert.deepEqual(d.projects, CLI_DOC.projects);
    assert.deepEqual(d.oauthAccount, CLI_DOC.oauthAccount);
    assert.equal(d.numStartups, 41);
  });
}

test('#238 a normal login .claude.json is updated EXACTLY as before (literal bytes: key order, own server, trust kept)', async () => {
  const rig = newRig();
  makeSource(rig.home);
  putCj(rig, cliText());
  assert.deepEqual(await runSync(rig, FULL), []);
  const expected = {
    numStartups: 41,
    oauthAccount: { emailAddress: 'scratch@example.invalid', organizationUuid: 'org-1' },
    projects: { '/scratch/proj': { hasTrustDialogAccepted: true }, '/scratch/other': { hasTrustDialogAccepted: false } },
    mcpServers: { 'my-own': { command: 'mine' }, github: { command: 'gh' }, 'linear-server': { url: 'u' }, 'chrome-devtools': { command: 'cd' } },
  };
  assert.equal(fs.readFileSync(cjOf(rig), 'utf8'), JSON.stringify(expected, null, 2));
  assert.deepEqual(manifestOf(rig.login).mcpServers, ['github', 'linear-server', 'chrome-devtools']);
  assert.deepEqual(tmpLeft(rig.login), []);
  // De-selecting one server removes only that one (the removal half of the merge).
  assert.deepEqual(await runSync(rig, { ...FULL, mcpServers: ['github'] }), []);
  assert.deepEqual(mcpOf(rig.login), ['github', 'my-own']);
});

test('#238 a login with NO .claude.json still gets one (definite absence starts from {}), no tmp left', async () => {
  const rig = newRig();
  makeSource(rig.home);
  assert.deepEqual(await runSync(rig, FULL), []);
  assert.equal(
    fs.readFileSync(cjOf(rig), 'utf8'),
    JSON.stringify({ mcpServers: { github: { command: 'gh' }, 'linear-server': { url: 'u' }, 'chrome-devtools': { command: 'cd' } } }, null, 2),
  );
  assert.deepEqual(tmpLeft(rig.login), []);
});

test('#238 an idempotent sync WRITES NOTHING to a login file that already holds the merge (same inode + mtime)', async () => {
  const rig = newRig();
  makeSource(rig.home);
  putCj(rig, cliText());
  await runSync(rig, FULL);
  fs.utimesSync(cjOf(rig), 1_700_000_000, 1_700_000_000);
  const a = fs.statSync(cjOf(rig), { bigint: true });
  assert.deepEqual(await runSync(rig, FULL), []);
  const b = fs.statSync(cjOf(rig), { bigint: true });
  assert.equal(b.ino, a.ino, 'not replaced');
  assert.equal(b.mtimeNs, a.mtimeNs, 'not rewritten');
});

// The interleave: another writer lands between our read and our replace → theirs survives, ours is skipped.
const INTERLEAVE: Array<[string, (rig: Rig) => void]> = [
  ['appends a project (size grows)', (rig) => putCj(rig, cliText({ numStartups: 42, projects: { ...CLI_DOC.projects, '/scratch/new': { hasTrustDialogAccepted: true } } }), 1_700_000_100)],
  ['rewrites in place with the SAME length and restores the mtime (content is the only signal)', (rig) => putCj(rig, cliText({ numStartups: 43 }), 1_700_000_000)],
  ['touches it (identical bytes, new mtime)', (rig) => fs.utimesSync(cjOf(rig), 1_700_000_001, 1_700_000_001)],
  ['replaces it via rename (new inode, other content)', (rig) => {
    const t = path.join(rig.login, 'cli-tmp');
    fs.writeFileSync(t, cliText({ numStartups: 99 }));
    fs.renameSync(t, cjOf(rig));
  }],
  ['deletes it', (rig) => fs.unlinkSync(cjOf(rig))],
];
for (const [name, act] of INTERLEAVE) {
  test(`#238 interleave: another writer ${name} between our read and our replace → theirs untouched, ours skipped, retried next sync`, async () => {
    const rig = newRig();
    makeSource(rig.home);
    putCj(rig, cliText());
    const original = viewOf(cjOf(rig));
    let theirs = original;
    const h = hookOnce('writeFileSync', isCjWrite(rig), () => { act(rig); theirs = viewOf(cjOf(rig)); });
    let warns: string[];
    try {
      warns = await runSync(rig, FULL, { caller: 'spawn-pty' });
    } finally {
      h.restore();
    }
    assert.equal(h.fired(), 1, 'instrument control: the other writer really landed at the write seam');
    assert.ok(!sameViewOf(original, theirs), 'instrument control: the other writer really changed (bytes, mtime)');
    assert.ok(sameViewOf(theirs, viewOf(cjOf(rig))), 'the other writer\'s file is exactly as they left it (no clobber, no mtime bump)');
    assert.equal(warns.length, 1, `exactly ONE warn: ${JSON.stringify(warns)}`);
    assert.ok(warns[0].includes(`${cjOf(rig)} changed while syncing`), warns[0]);
    assert.deepEqual(tmpLeft(rig.login), [], 'the tmp file is cleaned up');
    assert.deepEqual(manifestOf(rig.login), { symlinks: LINKS, mcpServers: [] }, 'manifest does not claim servers it did not write');
    // Retry next sync: merges into THEIR version (their change is kept — no lost update).
    assert.deepEqual(await runSync(rig, FULL), []);
    const d = JSON.parse(fs.readFileSync(cjOf(rig), 'utf8'));
    assert.deepEqual(Object.keys(d.mcpServers).sort(), ['chrome-devtools', 'github', 'linear-server', ...(theirs.bytes === null ? [] : ['my-own'])]);
    if (theirs.bytes !== null) assert.deepEqual(d.oauthAccount, CLI_DOC.oauthAccount);
  });
}

test('#238 interleave: the file did not exist at our read and the CLI creates it before our replace → theirs untouched', async () => {
  const rig = newRig();
  makeSource(rig.home);
  const theirs = cliText({ numStartups: 1 });
  const h = hookOnce('writeFileSync', isCjWrite(rig), () => { fs.mkdirSync(rig.login, { recursive: true }); fs.writeFileSync(cjOf(rig), theirs); });
  let warns: string[];
  try {
    warns = await runSync(rig, FULL);
  } finally {
    h.restore();
  }
  assert.equal(h.fired(), 1);
  assert.equal(fs.readFileSync(cjOf(rig), 'utf8'), theirs, 'the created file survives');
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes('changed while syncing'), warns[0]);
  assert.deepEqual(tmpLeft(rig.login), []);
});

test('#238 interleave: the CLI creates the file in the gap AFTER our fresh re-read (fresh-file case) → hard-link refuses to overwrite it', async () => {
  const rig = newRig();
  makeSource(rig.home);
  const theirs = cliText({ numStartups: 2 });
  const h = hookOnce('linkSync', isTmpArg, () => fs.writeFileSync(cjOf(rig), theirs));
  let warns: string[];
  try {
    warns = await runSync(rig, FULL);
  } finally {
    h.restore();
  }
  assert.equal(h.fired(), 1, 'instrument control: the link seam was reached (fresh-file path)');
  assert.equal(fs.readFileSync(cjOf(rig), 'utf8'), theirs, 'never overwritten');
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes('changed while syncing'), warns[0]);
  assert.deepEqual(tmpLeft(rig.login), [], 'tmp unlinked after the refused link');
});

test('#238 interleave: the file cannot be RE-READ for the staleness check (2nd open fails) → treated as changed, nothing replaced', async () => {
  const rig = newRig();
  makeSource(rig.home);
  putCj(rig, cliText());
  const before = viewOf(cjOf(rig));
  let opens = 0;
  const h = hookOnce('openSync', (a) => a[0] === cjOf(rig) && ++opens === 2, () => { throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' }); });
  let warns: string[];
  try {
    warns = await runSync(rig, FULL);
  } finally {
    h.restore();
  }
  assert.equal(h.fired(), 1, 'instrument control: the fresh re-read was the 2nd open of the file');
  assert.ok(sameViewOf(before, viewOf(cjOf(rig))), 'file untouched');
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes('changed while syncing'), warns[0]);
  assert.deepEqual(tmpLeft(rig.login), []);
});

test('#238 a failing replace (rename throws) → ONE "failed to write" warn, file intact, tmp cleaned, manifest unchanged', async () => {
  const rig = newRig();
  makeSource(rig.home);
  putCj(rig, cliText());
  const before = viewOf(cjOf(rig));
  const h = hookOnce('renameSync', isTmpArg, () => { throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' }); });
  let warns: string[];
  try {
    warns = await runSync(rig, FULL);
  } finally {
    h.restore();
  }
  assert.equal(h.fired(), 1);
  assert.ok(sameViewOf(before, viewOf(cjOf(rig))), 'file untouched');
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes(`failed to write ${cjOf(rig)}`), warns[0]);
  assert.deepEqual(tmpLeft(rig.login), []);
  assert.deepEqual(manifestOf(rig.login).mcpServers, []);
});

test('#238 an UNREADABLE login .claude.json (mode 000) is left alone — rename would replace it, so read errors fail closed', { skip: process.getuid?.() === 0 ? 'root bypasses mode bits' : undefined }, async () => {
  const rig = newRig();
  makeSource(rig.home);
  putCj(rig, cliText());
  const before = viewOf(cjOf(rig));
  const ino = fs.statSync(cjOf(rig)).ino;
  fs.chmodSync(cjOf(rig), 0o000);
  let warns: string[];
  try {
    assert.throws(() => fs.readFileSync(cjOf(rig)), /EACCES/, 'precondition: really unreadable');
    warns = await runSync(rig, FULL);
  } finally {
    fs.chmodSync(cjOf(rig), 0o600);
  }
  assert.equal(fs.statSync(cjOf(rig)).ino, ino, 'not replaced');
  assert.ok(sameViewOf(before, viewOf(cjOf(rig))), 'bytes identical');
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes(`cannot read ${cjOf(rig)}`), warns[0]);
  assert.deepEqual(tmpLeft(rig.login), []);
});

test('#238 file mode is preserved (0600 stays 0600 under umask 022, as an in-place write kept it)', async () => {
  const rig = newRig();
  makeSource(rig.home);
  putCj(rig, cliText());
  fs.chmodSync(cjOf(rig), 0o600);
  const old = process.umask(0o022);
  try {
    assert.deepEqual(await runSync(rig, FULL), []);
  } finally {
    process.umask(old);
  }
  assert.equal(fs.statSync(cjOf(rig)).mode & 0o777, 0o600);
  assert.deepEqual(mcpOf(rig.login), ['chrome-devtools', 'github', 'linear-server', 'my-own'], 'and the merge really happened');
});

test('#238 a SYMLINKED login .claude.json stays a symlink; the file it points at is updated', async () => {
  const rig = newRig();
  makeSource(rig.home);
  const real = path.join(rig.home, 'shared', 'claude.json');
  put(real, cliText());
  fs.mkdirSync(rig.login, { recursive: true });
  fs.symlinkSync(real, cjOf(rig));
  assert.deepEqual(await runSync(rig, FULL), []);
  assert.ok(fs.lstatSync(cjOf(rig)).isSymbolicLink(), 'the link was not replaced by a regular file');
  assert.equal(fs.readlinkSync(cjOf(rig)), real);
  const d = JSON.parse(fs.readFileSync(real, 'utf8'));
  assert.deepEqual(Object.keys(d.mcpServers).sort(), ['chrome-devtools', 'github', 'linear-server', 'my-own']);
  assert.deepEqual(d.projects, CLI_DOC.projects);
  assert.deepEqual(tmpLeft(rig.login), []);
  assert.deepEqual(tmpLeft(path.dirname(real)), []);
});

test('#238 a DANGLING .claude.json symlink is not materialized: ONE warn, link still dangling', async () => {
  const rig = newRig();
  makeSource(rig.home);
  const real = path.join(rig.home, 'nowhere', 'claude.json');
  fs.mkdirSync(rig.login, { recursive: true });
  fs.symlinkSync(real, cjOf(rig));
  const warns = await runSync(rig, FULL);
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes(`${cjOf(rig)} is a dangling symlink`), warns[0]);
  assert.ok(fs.lstatSync(cjOf(rig)).isSymbolicLink() && !fs.existsSync(real));
  assert.deepEqual(tmpLeft(rig.login), []);
});

// ---- the pure helpers -----------------------------------------------------------

test('C10 isEmptyAccountInherit / deselectedAccountIds: literal table', async () => {
  const { isEmptyAccountInherit, deselectedAccountIds } = await import('../shared/accounts.ts');
  for (const v of [undefined, null, {}, { settings: false }, { skills: [] }, { mcpServers: ['  '] }, { skills: [1, ''] }, 'x']) {
    assert.equal(isEmptyAccountInherit(v), true, `empty: ${JSON.stringify(v)}`);
  }
  for (const v of [{ settings: true }, { statusline: true }, { skills: ['a'] }, { mcpServers: ['b'] }]) {
    assert.equal(isEmptyAccountInherit(v), false, `non-empty: ${JSON.stringify(v)}`);
  }
  const A = (id: string, inherit?: Inherit) => ({ id, label: id, configDir: '/x', inherit });
  const ids = (b: any[], a: any[]) => [...deselectedAccountIds(b, a)].sort();
  assert.deepEqual(ids([A('a', { settings: true })], [A('a')]), ['a'], 'non-empty → absent');
  assert.deepEqual(ids([A('a', { settings: true })], [A('a', {})]), ['a'], 'non-empty → {}');
  assert.deepEqual(ids([A('a')], [A('a')]), [], 'absent → absent is not a de-selection');
  assert.deepEqual(ids([A('a', {})], [A('a')]), [], '{} → absent is not a de-selection');
  assert.deepEqual(ids([A('a', { settings: true })], [A('a', { skills: ['x'] })]), [], 'non-empty → non-empty');
  assert.deepEqual(ids([], [A('a')]), [], 'new account');
  const moved = (b: any[], a: any[]) => [...deselectedAccountIds(b, a)].sort();
  assert.deepEqual(moved([{ ...A('a', { settings: true }), configDir: '/x' }], [{ ...A('a'), configDir: '/y' }]), [], 'configDir changed in the same save → no grant');
  assert.deepEqual(moved([{ ...A('a', { settings: true }), configDir: ' /x ' }], [{ ...A('a'), configDir: '/x' }]), ['a'], 'default comparator trims');
  assert.deepEqual(moved([{ ...A('a', { settings: true }), configDir: '' }], [{ ...A('a'), configDir: '' }]), [], 'no dir on either side → no grant');
  const mv = [{ ...A('a', { settings: true }), configDir: '/x' }]; const mv2 = [{ ...A('a'), configDir: '/y' }];
  assert.deepEqual([...deselectedAccountIds(mv, mv2, () => true)], ['a'], 'a caller-supplied comparator decides (same dir → grant)');
  assert.deepEqual([...deselectedAccountIds(mv, [{ ...A('a'), configDir: '/x' }], () => false)], [], 'a caller-supplied comparator decides (other dir → no grant)');
  assert.deepEqual(ids([A('a', { settings: true })], []), [], 'removed account');
  assert.deepEqual(ids([A('a', { settings: true }), A('b', { skills: ['s'] }), A('c')], [A('a'), A('b', { skills: ['s'] }), A('c')]), ['a']);
});

// ---- instrument controls --------------------------------------------------------

test('#235 helper: assertScratch REFUSES live Claude dirs and anything outside the scratch root', () => {
  for (const home of REAL_HOMES) {
    for (const live of ['.claude', '.claude-mc', '.claude.json', '.claude/skills/x']) {
      assert.throws(() => assertScratch(path.join(home, live)), /resolves under a live Claude dir/, `must refuse ${live}`);
    }
  }
  if (REAL_CFG) assert.throws(() => assertScratch(path.join(REAL_CFG, 'sub')), /resolves under a live Claude dir/);
  assert.throws(() => assertScratch(os.tmpdir()), /not under the scratch root/, 'outside scratch root');
  assert.doesNotThrow(() => assertScratch(path.join(SCRATCH_ROOT, 'ok', 'home', '.claude-mc')), 'a scratch lookalike passes');
});

test('#235 helper: snapshot() is sensitive, and the log stub captures a real warn', async () => {
  const rig = newRig();
  const before = await buildLiveMirror(rig);
  fs.unlinkSync(path.join(rig.login, 'RTK.md'));
  assert.notDeepEqual(snapshot(rig.login), before, 'snapshot sees a removed link');
  // Source present but a selected MCP server is not defined there → the module's own existing warn is captured.
  const rig2 = newRig();
  makeSource(rig2.home);
  const warns = await runSync(rig2, { mcpServers: ['nonexistent-server'] });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /nonexistent-server/);
});
