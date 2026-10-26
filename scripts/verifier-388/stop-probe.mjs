// does `stopSignInPersistence` still stop WRITES when the clearTimeout loop is removed? and does it still stop READS? usage: node stop-probe.mjs <repo>
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2]);
const src = fs.readFileSync(path.join(root, 'src/main/browser-panel-profiles.test.ts'), 'utf8');
const a = src.indexOf('const STUB = `'), b = src.indexOf('const bp = await import');
const gen = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'stopp-')), 'h.mjs');
fs.writeFileSync(gen, `import { register } from 'node:module';\nimport { pathToFileURL } from 'node:url';\n${src.slice(a, b)}\nexport const bp = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/main/browser-panel.ts')).href)});\nexport const sessions = () => globalThis.__bpSessions;\n`);
const H = await import(pathToFileURL(gen).href); const bp = H.bp;
bp.initBrowserPanels(() => ({ contentView: { addChildView() {}, removeChildView() {} } }), { load: () => null, save() {}, flush() {} });
const P = 'bp-000000000001'; bp.setBrowserProfileResolver(() => P); bp.ensurePanel('ws-stop');
const ses = H.sessions().get(`persist:orchestra-profile-${P}`); ses.liveCookies = [{ name: 'sid', value: 'v', domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, httpOnly: false, session: true, sameSite: 'unspecified' }];
for (const [, fn] of [...ses.cookieListeners]) fn({}, ses.liveCookies[0], 'explicit', false);
bp.stopSignInPersistence(`persist:orchestra-profile-${P}`);
await new Promise((r) => setTimeout(r, 600));
const writes = ses.cookieSets?.length ?? 0, reads = ses.cookieGets?.length ?? 0;
console.log(`after stop + 600 ms: writes=${writes} reads=${reads}`);
fs.rmSync(path.dirname(gen), { recursive: true, force: true });
process.exit(writes === 0 && reads === 0 ? 0 : 1);
