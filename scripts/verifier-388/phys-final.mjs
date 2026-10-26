// own physical-form attacks on scripts/lib/rig-paths.mjs (uid 9999 stand-in: nothing under the human's runtime dir is ever stat'd). usage: node phys-final.mjs <repo>
import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const P = await import(pathToFileURL(path.join(path.resolve(process.argv[2]), 'scripts/lib/rig-paths.mjs')).href);
const B = fs.mkdtempSync(path.join(process.env.TMPDIR, 'physf-')); const T = '/run/user/9999';
const mk = (n, target) => { fs.symlinkSync(target, path.join(B, n)); return path.join(B, n); };
let bad = 0; const hits = (forms) => forms.some((f) => f === T || f.startsWith(T + '/'));
const row = (id, exp, got, label, extra = '') => { const v = exp === got ? 'OK' : 'BYPASS'; if (v !== 'OK') bad++; console.log(`${id.padEnd(4)} ${v.padEnd(7)} exp=${exp} got=${got} ${label} ${extra}`); };
const forms = (p) => P.physicalForms(p);
row('F1', 'HIT', hits(forms(mk('l1', `${T}/zz`))) ? 'HIT' : 'MISS', 'dangling one-hop link → target text under the runtime');
{ mk('d2', `${T}/yy`); const l = mk('d1', path.join(B, 'd2')); row('F2', 'HIT', hits(forms(l)) ? 'HIT' : 'MISS', 'DANGLING 2-HOP chain d1 → d2 → runtime/yy', JSON.stringify(forms(l).map((x) => x.replace(B, '<B>')))); }
{ const l = mk('p1', '/run/user'); row('F3', 'HIT', hits(forms(path.join(l, '9999', 'bus'))) ? 'HIT' : 'MISS', 'MISSING leaf under a linked EXISTING parent (<link>/9999/bus; link -> /run/user) lands where the link points'); }
{ mk('q2', '/run/user'); const l = mk('q1', path.join(B, 'q2')); row('F4', 'HIT', hits(forms(path.join(l, '9999', 'bus'))) ? 'HIT' : 'MISS', 'missing leaf under a 2-hop linked EXISTING parent'); }
{ const l = mk('r1', '../'.repeat(12) + 'run/user/9999/ww'); row('F5', 'HIT', hits(forms(l)) ? 'HIT' : 'MISS', 'relative dangling climb'); }
row('F6', 'HIT', P.absolutePieces('unix:path=%2Frun%2Fuser%2F9999%2Fbus').some((x) => x.startsWith(T)) ? 'HIT' : 'MISS', 'absolutePieces decodes %hh (one pass)');
row('F7', 'HIT', P.absolutePieces('unix:path=/srv/my%20dir/bus').some((x) => x === '/srv/my dir/bus') ? 'HIT' : 'MISS', 'absolutePieces: a decoded path with a space is one piece');
row('F8', 'HIT', P.absolutePieces('/a:/run/user/9999/b').some((x) => x.startsWith(T)) ? 'HIT' : 'MISS', 'colon list');
row('F9', 'MISS', P.absolutePieces('unix:path=%2Frun%2Fuser%2F9999%2Fbus%').some((x) => x.startsWith(T)) ? 'HIT' : 'MISS', 'malformed trailing % decodes to nothing HERE (declared: refused lexically upstream)');
{ const l = mk('c1', B + '/ok'); fs.mkdirSync(path.join(B, 'ok')); row('F10', 'MISS', hits(forms(path.join(l, 'bus'))) ? 'HIT' : 'MISS', 'CONTROL: link to a harmless dir'); }
// 3-hop dangling (beyond a one/two-hop resolver)
{ mk('e3', `${T}/vv`); mk('e2', path.join(B, 'e3')); const l = mk('e1', path.join(B, 'e2')); row('F11', 'HIT', hits(forms(l)) ? 'HIT' : 'MISS', 'DANGLING 3-HOP chain', JSON.stringify(forms(l).map((x) => x.replace(B, '<B>')))); }
console.log(`SUMMARY bypass=${bad}`); fs.rmSync(B, { recursive: true, force: true }); process.exit(bad ? 1 : 0);
