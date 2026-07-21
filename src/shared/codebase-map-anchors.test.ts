import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The codebase map (docs/codebase-map/*.md) is maintained by convention and
// rots silently: a doc citing `workspaces.ts:2876` keeps reading as evidence
// long after the file shrank or the cited file was renamed. This is the
// "compile-checked reference" idea applied at doc level — anchors must break
// loudly when they rot instead of being quietly wrong.
//
// Deliberately checked:
//   • every path-shaped reference (src/..., docs/..., scripts/..., native/...)
//     names a file that EXISTS;
//   • every bare `<file>.ts:<line>` reference resolves to exactly one file in
//     the tree, and the cited line (range end for `:100-200`) is ≤ the file's
//     real line count — a cited line past EOF is unambiguous rot.
// Deliberately NOT checked: whether the line still holds the described code —
// line numbers drift by design (CLAUDE.md says verify before relying); this
// test only catches references that can no longer point anywhere at all.

const ROOT = process.cwd(); // pnpm test runs from the repo root
const MAP_DIR = path.join(ROOT, 'docs', 'codebase-map');

/** Walk the repo for source files, skipping build/dep dirs, and index them by
 *  basename so bare `workspaces.ts:123` references can resolve. */
function buildBasenameIndex(): Map<string, string[]> {
  const skip = new Set([
    'node_modules', 'target', '.localdeps', 'dist-electron', 'release',
    '.git', 'dist', '.claude', '.orchestra',
  ]);
  const index = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (/\.(ts|tsx|rs|sh|mjs)$/.test(entry.name)) {
        const list = index.get(entry.name) ?? [];
        list.push(path.join(dir, entry.name));
        index.set(entry.name, list);
      }
    }
  };
  for (const top of ['src', 'scripts', 'native', 'docs', 'sandbox']) {
    const d = path.join(ROOT, top);
    if (fs.existsSync(d)) walk(d);
  }
  return index;
}

function lineCount(file: string): number {
  return fs.readFileSync(file, 'utf8').split('\n').length;
}

interface Failure {
  doc: string;
  line: number;
  ref: string;
  reason: string;
}

test('codebase-map anchors resolve: cited files exist and cited lines are within them', () => {
  assert.ok(fs.existsSync(MAP_DIR), `missing ${MAP_DIR} — run from the repo root`);
  const index = buildBasenameIndex();
  const failures: Failure[] = [];
  const lineCountCache = new Map<string, number>();
  const bound = (file: string): number => {
    let n = lineCountCache.get(file);
    if (n === undefined) {
      n = lineCount(file);
      lineCountCache.set(file, n);
    }
    return n;
  };

  // Path-shaped refs, optionally with :line or :line-line (hyphen/en dash).
  // Extensions are ordered LONGEST FIRST (`tsx` before `ts`) and followed by a
  // word-boundary lookahead — regex alternation is ordered, and `ts|tsx` once
  // matched `main.tsx` as the nonexistent `main.ts`, making the CHECKER the
  // thing producing false rot reports.
  const pathRef = /(?<![\w./*-])((?:src|docs|scripts|native|sandbox)\/[A-Za-z0-9_./-]+\.(?:tsx|ts|mjs|md|sh|rs|css|json))(?![A-Za-z0-9])(?::(\d+)(?:[–-](\d+))?)?/g;
  // Bare file refs REQUIRE a line (a bare filename with no line is prose, not
  // an anchor). `~` prefixes ("~`workspaces.ts:1500`") land just before.
  const bareRef = /(?<![\w./*-])([A-Za-z0-9_-]+\.(?:tsx|ts|rs|sh)):(\d+)(?:[–-](\d+))?/g;

  for (const docName of fs.readdirSync(MAP_DIR).filter((f) => f.endsWith('.md'))) {
    const docPath = path.join(MAP_DIR, docName);
    const lines = fs.readFileSync(docPath, 'utf8').split('\n');
    lines.forEach((text, i) => {
      const at = i + 1;
      for (const m of text.matchAll(pathRef)) {
        const rel = m[1];
        const abs = path.join(ROOT, rel);
        if (!fs.existsSync(abs)) {
          failures.push({ doc: docName, line: at, ref: m[0], reason: 'file does not exist' });
          continue;
        }
        const cited = Math.max(Number(m[2] ?? 0), Number(m[3] ?? 0));
        if (cited > 0 && cited > bound(abs)) {
          failures.push({
            doc: docName,
            line: at,
            ref: m[0],
            reason: `cited line ${cited} > file length ${bound(abs)}`,
          });
        }
      }
      for (const m of text.matchAll(bareRef)) {
        const base = m[1];
        // Path-shaped refs already handled above; a bare ref that is really
        // the tail of a path match would double-report — skip if the char
        // before the match is '/'.
        if (m.index !== undefined && text[m.index - 1] === '/') continue;
        const candidates = index.get(base);
        if (!candidates || candidates.length === 0) {
          failures.push({ doc: docName, line: at, ref: m[0], reason: 'no such file in the tree' });
          continue;
        }
        const cited = Math.max(Number(m[2]), Number(m[3] ?? 0));
        // Ambiguous basename: pass if the cited line fits ANY candidate — the
        // check stays a rot detector, not an ambiguity linter.
        if (!candidates.some((c) => cited <= bound(c))) {
          failures.push({
            doc: docName,
            line: at,
            ref: m[0],
            reason: `cited line ${cited} exceeds every candidate (${candidates
              .map((c) => `${path.relative(ROOT, c)}:${bound(c)}`)
              .join(', ')})`,
          });
        }
      }
    });
  }

  const report = failures
    .map((f) => `  ${f.doc}:${f.line}  ${f.ref}  — ${f.reason}`)
    .join('\n');
  assert.equal(
    failures.length,
    0,
    `codebase-map anchors rotted (fix the doc or the reference):\n${report}`,
  );
});
