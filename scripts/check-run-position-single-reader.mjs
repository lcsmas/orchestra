#!/usr/bin/env node
// #432 gate: `src/shared/run-position.ts` is the ONLY code in src that reads the coordinator capability
// (`.canOrchestrate`, `canOrchestrate(`) or the orchestrator KIND (`kind === 'orchestrator'`) to decide run
// membership or coordination. A remaining read that is NOT such a decision (scratch-likeness, UI chip, repo
// grouping, env/sentinel plumbing, the flag's own writes) must carry `run-position: non-run <why>` on its line
// — so every exception is visible and reviewable.
//   node scripts/check-run-position-single-reader.mjs [--root <repo>] [--list]  → CLEAN (RC 0) | DIRTY (RC 1)
//   node scripts/check-run-position-single-reader.mjs --self-test               → positive + negative control
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODULE = 'src/shared/run-position.ts';
export const MARKER = 'run-position: non-run';
const PATTERNS = [
  ['.canOrchestrate', /\.canOrchestrate\b/],
  ['canOrchestrate(', /\bcanOrchestrate\(/],
  ["kind === 'orchestrator'", /\bkind\s*[!=]==?\s*['"]orchestrator['"]/],
  ["'orchestrator' === kind", /['"]orchestrator['"]\s*[!=]==?\s*[\w.?]*\bkind\b/],
  ["case 'orchestrator'", /\bcase\s+['"]orchestrator['"]\s*:/],
  ['destructured/bracket canOrchestrate', /\{[^}]*\bcanOrchestrate\b[^}]*\}\s*=|\[\s*['"]canOrchestrate['"]\s*\]/],
  ['hook ORCHESTRA_KIND gate', /ORCHESTRA_KIND:-\}"\s*=\s*"orchestrator"|ORCHESTRA_KIND[^\n]{0,20}==?\s*"?orchestrator/],
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
    });
  }
  return hits;
}

export function verdict(root) {
  const hits = scan(root);
  const inModule = hits.filter((h) => h.file === MODULE);
  const outside = hits.filter((h) => h.file !== MODULE && !h.marked);
  const problems = [];
  if (outside.length) problems.push(`${outside.length} unmarked read(s) of the coordinator flag/kind outside ${MODULE}`);
  // positive control: the scan must see the module's own two reads, else the patterns are blind
  for (const k of ['.canOrchestrate', "kind === 'orchestrator'"]) {
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
