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

let bundlePromise: Promise<{ syncAccountInheritance(a: Acct): Promise<void> }> | null = null;
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
      `export { syncAccountInheritance } from ${JSON.stringify(path.join(repoRoot, 'src/main/account-inherit.ts'))};\n`,
    );
    const stubs: Record<string, string> = {
      store: 'export const store = { accounts: [] as unknown[] };',
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
async function runSync(rig: Rig, inherit?: Inherit): Promise<string[]> {
  assertScratch(rig.home);
  assertScratch(rig.login);
  const m = await loadInherit();
  const prev = process.env.HOME;
  process.env.HOME = rig.home;
  try {
    assert.equal(os.homedir(), rig.home, 'HOME redirect must take effect');
    (globalThis as any).__a8Logs = [] as LogRec[];
    await m.syncAccountInheritance({ id: 'a', label: 'mc', configDir: rig.login, inherit });
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

test('#235 source present: everything de-selected → every manifest link pruned', async () => {
  const rig = newRig();
  await buildLiveMirror(rig);
  assert.deepEqual(await runSync(rig, undefined), []);
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
