#!/usr/bin/env node
// #432/#434 gate: `src/shared/run-position.ts` is the ONLY code in src that reads the coordinator capability
// (`.canOrchestrate`, `canOrchestrate(`), the ownership field (`.ownsRun`) or the orchestrator KIND (ANY `'orchestrator'`
// string literal — a comparison, an alias, an array) to decide run membership or coordination; and the files that pick
// "who coordinates ws" (PARENT_PICK_FILES) read it through `coordinatorOf`, never from `.parentId`. A remaining read that is NOT such a decision (scratch-likeness, UI chip, repo
// grouping, env/sentinel plumbing, the flag's own writes) must carry `run-position: non-run <why>` on its line
// — so every exception is visible and reviewable. #440: the capability flag is RETIRED — the word `canOrchestrate` may appear in
// code ONLY in RETIRED_FLAG_ALLOWED (the store's load-time migration), marked or not.
//   node scripts/check-run-position-single-reader.mjs [--root <repo>] [--list]  → CLEAN (RC 0) | DIRTY (RC 1)
//   node scripts/check-run-position-single-reader.mjs --self-test               → positive + negative control
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODULE = 'src/shared/run-position.ts';
export const MARKER = 'run-position: non-run';
/** #440 — the only non-test source file that may still name the retired `canOrchestrate` flag (it migrates an older store at load). */
export const RETIRED_FLAG_ALLOWED = ['src/main/store.ts'];
const PATTERNS = [
  ['retired canOrchestrate flag', /\bcanOrchestrate\b/],
  ['.canOrchestrate', /\.canOrchestrate\b/],
  ['.ownsRun', /\.ownsRun\b/],
  ["'orchestrator' literal", /['"]orchestrator['"]/],
  ['canOrchestrate(', /\bcanOrchestrate\(/],
  ["kind === 'orchestrator'", /\bkind\s*[!=]==?\s*['"]orchestrator['"]/],
  ["'orchestrator' === kind", /['"]orchestrator['"]\s*[!=]==?\s*[\w.?]*\bkind\b/],
  ["case 'orchestrator'", /\bcase\s+['"]orchestrator['"]\s*:/],
  ['destructured/bracket canOrchestrate|ownsRun', /\{[^}]*\b(canOrchestrate|ownsRun)\b[^}]*\}\s*=|\[\s*['"](canOrchestrate|ownsRun)['"]\s*\]/],
  ['hook ORCHESTRA_KIND gate', /ORCHESTRA_KIND:-\}"\s*=\s*"orchestrator"|ORCHESTRA_KIND[^\n]{0,20}==?\s*"?orchestrator/],
];

/** The files that decide "who coordinates ws" — a `.parentId` read in them must go through `coordinatorOf` (or carry the marker). */
export const PARENT_PICK_FILES = [
  'src/main/bus-liveness-roster.ts',
  'src/main/session-watchdog.ts',
  'src/main/vague-roster.ts',
  'src/main/admission-wake.ts',
  'src/main/wake-roster.ts',
  'src/main/relance-roster.ts',
  'src/main/memory-notice.ts',
  'src/shared/naming-migration.ts',
];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Code part of a line: a full-line comment is skipped, a trailing `// …` is cut. */
function codeOf(line) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  return line.replace(/(^|\s)\/\/.*$/, '$1');
}

export function scan(root) {
  const hits = [];
  for (const file of walk(path.join(root, 'src'))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = codeOf(line);
      if (!code) return;
      for (const [kind, re] of PATTERNS) {
        if (!re.test(code)) continue;
        const marked = line.includes(MARKER); // same line only: a marker never exempts its neighbour
        hits.push({ file: rel, line: i + 1, kind, text: line.trim(), marked });
      }
      if (PARENT_PICK_FILES.includes(rel) && /\.parentId\b/.test(code)) {
        hits.push({ file: rel, line: i + 1, kind: '.parentId coordinator pick', text: line.trim(), marked: line.includes(MARKER) });
      }
    });
    // a Prettier multi-line destructure of the flag/ownership fields: the line scan cannot see it
    const text = lines.map(codeOf).join('\n');
    for (const m of text.matchAll(/\{[^{}]*\b(?:canOrchestrate|ownsRun)\b[^{}]*\}\s*=[^=]/g)) {
      const line = text.slice(0, m.index).split('\n').length + (m[0].split('\n').findIndex((l) => /canOrchestrate|ownsRun/.test(l)));
      if (lines[line - 1]?.match(/\{[^}]*\b(canOrchestrate|ownsRun)\b[^}]*\}\s*=/)) continue; // the one-line scan already has it
      hits.push({ file: rel, line, kind: 'multi-line destructure canOrchestrate|ownsRun', text: lines[line - 1]?.trim() ?? '', marked: lines[line - 1]?.includes(MARKER) ?? false });
    }
  }
  return hits;
}

export function verdict(root) {
  const hits = scan(root);
  const inModule = hits.filter((h) => h.file === MODULE);
  const outside = hits.filter((h) => h.file !== MODULE && !h.marked);
  const problems = [];
  const retired = hits.filter((h) => h.kind === 'retired canOrchestrate flag' && !RETIRED_FLAG_ALLOWED.includes(h.file));
  if (retired.length) problems.push(`${retired.length} read(s) of the RETIRED canOrchestrate flag outside ${RETIRED_FLAG_ALLOWED.join(', ')} (a marker does not exempt it)`);
  if (outside.length) problems.push(`${outside.length} unmarked read(s) of the coordinator flag/kind outside ${MODULE}`);
  // positive control: the scan must see the module's own two reads, else the patterns are blind
  for (const k of ['.ownsRun', "kind === 'orchestrator'"]) {
    if (!inModule.some((h) => h.kind === k)) problems.push(`positive control: no \`${k}\` read found in ${MODULE}`);
  }
  return { hits, inModule, outside, problems, clean: problems.length === 0 };
}

export function selfTest(root) {
  const real = verdict(root);
  if (!real.clean) return { ok: false, why: `real tree is not CLEAN: ${real.problems.join('; ')}` };
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'run-position-gate-'));
  try {
    fs.cpSync(path.join(root, 'src'), path.join(tmp, 'src'), { recursive: true });
    fs.appendFileSync(path.join(tmp, 'src/main/activity.ts'), "\nconst leak = (w: any) => w.canOrchestrate === true;\n");
    const bad = verdict(tmp);
    if (bad.clean || !bad.outside.some((h) => h.file === 'src/main/activity.ts')) {
      return { ok: false, why: 'negative control: an injected flag read was NOT flagged' };
    }
    // #440: a MARKED read of the retired flag outside the store migration is still a violation
    fs.appendFileSync(path.join(tmp, 'src/main/activity.ts'), `\nconst leak2 = (w: any) => w.canOrchestrate === true; // ${MARKER} sneaky\n`);
    fs.writeFileSync(path.join(tmp, 'src/main/activity.ts'), fs.readFileSync(path.join(tmp, 'src/main/activity.ts'), 'utf8').replace(/\nconst leak = [^\n]*\n/, '\n'));
    const bad2 = verdict(tmp);
    if (bad2.clean || !bad2.problems.some((p) => /RETIRED canOrchestrate flag/.test(p))) {
      return { ok: false, why: 'negative control: a MARKED retired-flag read outside the store was NOT flagged' };
    }
    return { ok: true, why: `real tree CLEAN (${real.hits.length} reads: ${real.inModule.length} in the module, ${real.hits.length - real.inModule.length} marked non-run); injected read → DIRTY` };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ri = args.indexOf('--root');
  const root = path.resolve(ri >= 0 ? args[ri + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (args.includes('--self-test')) {
    const r = selfTest(root);
    console.log(r.ok ? `SELF-TEST OK — ${r.why}` : `SELF-TEST FAILED — ${r.why}`);
    process.exit(r.ok ? 0 : 1);
  }
  const v = verdict(root);
  if (args.includes('--list') || !v.clean) for (const h of v.hits) console.log(`${h.file}:${h.line}: [${h.kind}]${h.marked ? ' (marked)' : ''} ${h.text}`);
  console.log(
    v.clean
      ? `CLEAN — ${v.hits.length} reads: ${v.inModule.length} in ${MODULE}, ${v.hits.length - v.inModule.length} marked non-run, 0 unmarked`
      : `DIRTY — ${v.problems.join('; ')}`,
  );
  process.exit(v.clean ? 0 : 1);
}
