// Acceptance 5: the package imports no Orchestra module (and nothing outside itself). The guard is exercised on the real package AND on
// planted violations, so a guard that can never fail is caught.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scan } from './lib/import-guard.ts';

const PKG = fileURLToPath(new URL('..', import.meta.url));
// Planted sources are assembled from split keywords so this file's own text holds nothing the guard would read as an import.
const IMPORT = 'imp' + 'ort';
const FROM = 'fr' + 'om';
const REQUIRE = 'req' + 'uire';
const imp = (spec: string): string => `${IMPORT} planted ${FROM} ${JSON.stringify(spec)};\nexport default planted;\n`;

const made: string[] = [];
function tempPackage(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'resctl-guard-'));
  made.push(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","type":"module"}');
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

describe('import guard', () => {
  after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it('the real package imports no Orchestra module, nothing outside itself, no dependency', () => {
    const r = scan(PKG);
    assert.deepEqual(r.violations, []);
    assert.ok(r.files >= 15 && r.specs >= 30, `the scan must have looked at the package (files ${r.files}, specifiers ${r.specs})`);
  });

  it('a clean temp package passes (control)', () => {
    const dir = tempPackage({ 'src/a.ts': 'import fs from "node:fs";\nimport b from "./b.ts";\nexport default [fs, b];\n', 'src/b.ts': 'export default 1;\n' });
    assert.deepEqual(scan(dir).violations, []);
  });

  const planted: [string, string, RegExp][] = [
    ['a relative import that leaves the package (the repo\'s src/)', imp('../../../src/shared/types.ts'), /leaves the package/],
    ['a package named for orchestra', imp('orchestra-core'), /orchestra/],
    ['a relative import naming orchestra', imp('./orchestra-bridge.ts'), /orchestra/],
    ['a dynamic load that leaves the package', `export const x = () => ${IMPORT}(${JSON.stringify('../../src/main/index.ts')});\n`, /leaves the package/],
    ['a require that leaves the package', `const x = ${REQUIRE}(${JSON.stringify('../../x.cjs')});\nexport default x;\n`, /leaves the package/],
    ['a third-party package', imp('left-pad'), /zero dependencies/],
    ['an absolute path', imp('/etc/passwd'), /leaves the package/],
    ['a computed dynamic load', `export const x = (m: string) => ${IMPORT}(m);\n`, /non-literal/],
  ];
  for (const [name, body, reason] of planted) {
    it(`fails on ${name}`, () => {
      const dir = tempPackage({ 'src/planted.ts': body });
      const v = scan(dir).violations;
      assert.equal(v.length, 1, JSON.stringify(v));
      assert.match(v[0].reason, reason);
      assert.equal(v[0].file, path.join('src', 'planted.ts'));
    });
  }

  for (const ext of ['mts', 'cts', 'tsx', 'jsx']) {
    it(`fails on a violation in a .${ext} file`, () => {
      const dir = tempPackage({ [`src/planted.${ext}`]: imp('../../../src/shared/types.ts') });
      const v = scan(dir).violations;
      assert.equal(v.length, 1, JSON.stringify(v));
      assert.match(v[0].reason, /leaves the package/);
    });
  }

  it('fails on a symlink (a linked directory would hide its files from the scan)', () => {
    const outside = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'resctl-guard-out-'));
    made.push(outside);
    fs.writeFileSync(path.join(outside, 'types.ts'), 'export default 1;\n');
    const dir = tempPackage({});
    fs.symlinkSync(outside, path.join(dir, 'src', 'lib'));
    const v = scan(dir).violations;
    assert.equal(v.length, 1, JSON.stringify(v));
    assert.match(v[0].reason, /symlink/);
  });

  it('fails on a dependency declared in package.json', () => {
    const dir = tempPackage({});
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","dependencies":{"left-pad":"1.0.0"}}');
    assert.equal(scan(dir).violations.length, 1);
  });
});
