// The import guard: the package must stay extractable — it imports nothing from the repo around it, no `orchestra` module, no third-party package.
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Violation = { file: string; spec: string; reason: string };

const SOURCE = /\.(ts|mjs|js|cjs)$/;
const PATTERNS: RegExp[] = [
  /\bfrom\s*['"]([^'"]+)['"]/g, // static import / export-from
  /\bimport\s*['"]([^'"]+)['"]/g, // side-effect import
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g, // dynamic import with a literal
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g, // CommonJS require with a literal
];
const NON_LITERAL = /\b(?:import|require)\s*\(\s*(?!['"\s])/g; // a computed specifier the guard cannot read

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function judge(pkgDir: string, file: string, spec: string): string | null {
  if (/orchestra/i.test(spec)) return 'names an orchestra module';
  if (spec.startsWith('node:') || builtinModules.includes(spec)) return null;
  let target: string;
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') target = path.resolve(path.dirname(file), spec);
  else if (spec.startsWith('/')) target = path.resolve(spec);
  else if (spec.startsWith('file:')) target = fileURLToPath(spec);
  else return 'a package that is not a node builtin (the service has zero dependencies)';
  const rel = path.relative(pkgDir, target);
  return rel.startsWith('..') || path.isAbsolute(rel) ? 'leaves the package directory' : null;
}

/** Every violation under `pkgDir`, plus the number of source files and specifiers examined (so a test can prove the scan looked at something). */
export function scan(pkgDir: string): { violations: Violation[]; files: number; specs: number } {
  const violations: Violation[] = [];
  let files = 0;
  let specs = 0;
  for (const file of walk(pkgDir)) {
    const rel = path.relative(pkgDir, file);
    if (path.basename(file) === 'package.json') {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const dep of Object.keys(pkg[k] ?? {})) violations.push({ file: rel, spec: dep, reason: `${k}: the service has zero dependencies` });
      }
      continue;
    }
    if (!SOURCE.test(file)) continue;
    files++;
    const text = fs.readFileSync(file, 'utf8');
    for (const re of PATTERNS) {
      for (const m of text.matchAll(re)) {
        specs++;
        const reason = judge(pkgDir, file, m[1]);
        if (reason) violations.push({ file: rel, spec: m[1], reason });
      }
    }
    for (const m of text.matchAll(NON_LITERAL)) violations.push({ file: rel, spec: m[0], reason: 'a non-literal import/require cannot be checked' });
  }
  return { violations, files, specs };
}
