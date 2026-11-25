// #595 — the closure walker that backs the recall check: what a rig's own command reaches. Fixture trees only (the real-repo check is in ci-paths.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWalker, type Tree } from './ci-closure.ts';

const tree = (files: Record<string, string>): Tree => ({ files: Object.keys(files), read: (p) => files[p] ?? '' });
const reach = (files: Record<string, string>, command: string, scripts: Record<string, string> = {}): string[] => [...createWalker(tree(files), scripts).closure(command).files].sort();

test('a script is followed through its relative imports and its repo-path mentions', () => {
  const r = reach({
    'scripts/e2e-a.mjs': "import { x } from './lib/x.mjs';\nconst f = 'scripts/data/seed.json';\n",
    'scripts/lib/x.mjs': "export const x = 1;\n",
    'scripts/data/seed.json': '{}',
    'scripts/unrelated.mjs': '',
  }, 'node scripts/e2e-a.mjs');
  assert.deepEqual(r, ['scripts/data/seed.json', 'scripts/e2e-a.mjs', 'scripts/lib/x.mjs']);
});

test('a `pnpm run x` hop in a command or a .sh file follows package.json; a pnpm string in a .mjs does not', () => {
  const files = { 'scripts/a.sh': 'pnpm run build:cli\n', 'scripts/m.mjs': "console.log('run `pnpm run build:cli` first')\n", 'vite.cli.config.ts': "entry: 'src/cli/index.ts'", 'src/cli/index.ts': '' };
  const scripts = { 'build:cli': 'vite build --config vite.cli.config.ts' };
  assert.ok(reach(files, 'bash scripts/a.sh', scripts).includes('src/cli/index.ts'));
  assert.ok(!reach(files, 'node scripts/m.mjs', scripts).includes('src/cli/index.ts'), 'a message naming a build is not a build');
});

test('src/ reach rule: a src file a script names is IN but its imports are not; a bundle the rig reads brings its WHOLE graph', () => {
  const files = {
    'scripts/e2e-b.mjs': "import { m } from '../src/main/m.ts';\n",
    'src/main/m.ts': "import { deep } from '../shared/deep.ts';\n",
    'src/shared/deep.ts': "import { deeper } from './deeper.ts';\n",
    'src/shared/deeper.ts': '',
    'vite.cli.config.ts': "entry: 'src/cli/index.ts'",
    'src/cli/index.ts': "import './c.ts';\n",
    'src/cli/c.ts': "import { z } from '../shared/z.ts';\n",
    'src/shared/z.ts': '',
  };
  const scripts = { 'build:cli': 'vite build --config vite.cli.config.ts' };
  assert.deepEqual(reach(files, 'node scripts/e2e-b.mjs', scripts), ['scripts/e2e-b.mjs', 'src/main/m.ts']);
  const withBundle = reach({ ...files, 'scripts/e2e-b.mjs': "const cli = 'dist-electron/cli.js';\n" }, 'node scripts/e2e-b.mjs', scripts);
  assert.ok(withBundle.includes('src/cli/c.ts') && withBundle.includes('src/shared/z.ts'), `the cli bundle's graph is the rig's: ${withBundle}`);
});

test('comments name nothing; a test file\'s src mentions are not inputs; a big directory named in text is not pulled in', () => {
  const big: Record<string, string> = {}; for (let i = 0; i < 70; i++) big[`scripts/big/f${i}.mjs`] = '';
  const r = reach({
    'scripts/e2e-c.mjs': "// see scripts/other.mjs\nimport './t.test.ts';\nconst d = 'scripts/big/';\nconst s = 'scripts/small/';\n",
    'scripts/t.test.ts': "assert(!/src\\/main\\/x\\.ts/.test(f)); const p = 'src/main/x.ts';\n",
    'scripts/other.mjs': '', 'src/main/x.ts': '',
    'scripts/small/a.mjs': '', ...big,
  }, 'node scripts/e2e-c.mjs');
  assert.ok(!r.includes('scripts/other.mjs'), 'a comment is not a mention');
  assert.ok(!r.includes('src/main/x.ts'), 'a test file naming src paths to assert about them');
  assert.ok(r.includes('scripts/small/a.mjs') && !r.includes('scripts/big/f0.mjs'));
});

test('`pnpm --dir pkg run x` is the whole package', () => {
  const r = reach({ 'packages/p/src/a.ts': '', 'packages/p/test/a.test.ts': '', 'packages/p/package.json': '{}' }, 'pnpm --dir packages/p run test', { test: 'node --test' });
  assert.deepEqual(r, ['packages/p/package.json', 'packages/p/src/a.ts', 'packages/p/test/a.test.ts']);
});
