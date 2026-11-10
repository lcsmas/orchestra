#!/usr/bin/env python3
"""#421 bloc HTML on the phone: remove each clause in place, run the suite that owns it, require RED, restore byte-exact (cmp).
Usage: python3 -I scripts/acces-mobile-bloc-mutants.py [id-prefix ...]   (from the repo root). Prints CLEAN / DIRTY."""
import os, shutil, subprocess, sys, filecmp, tempfile

R = 'src/acces-mobile/bloc-route.test.ts'
C = 'src/acces-mobile/conversation-bloc.test.ts'
W = 'src/main/acces-mobile-wiring.test.ts'
BR, SV, CV, SW, RT = 'src/acces-mobile/bloc-route.ts', 'src/acces-mobile/server.ts', 'src/acces-mobile/conversation.ts', 'src/acces-mobile/sw.ts', 'src/main/acces-mobile-routes.ts'
# B8: the id shape is a cheap pre-filter — a malformed id is ALSO unknown to the store, so removing it changes no answer (equivalent, documented).
EQUIV = {'B8-id-shape-relaxed'}
MUTANTS = [
    ('B1-token-change-ignored', BR, "if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {", "if (false) {", R),
    ('B2-no-expiry', BR, "if (e.expires <= now()) {", "if (false) {", R),
    ('B3-route-wears-shell-headers', SV, "res.writeHead(200, { ...BLOC_ROUTE_HEADERS, 'Content-Length'", "res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length'", R),
    ('B4-setting-off-ignored', SV, "if ((out as { enabled?: unknown } | null)?.enabled !== true) return refuse(404, 'bloc-off');", "", R),
    ('B5-no-sandbox-in-route-csp', BR, '`sandbox allow-scripts; ${BLOC_HTML_POLICY}; frame-ancestors', '`${BLOC_HTML_POLICY}; frame-ancestors', R),
    ('B6-sw-intercepts-navigations', SW, "if (isNav ? url.pathname !== '/' : SHELL.indexOf(url.pathname) < 0) return;", "if (!isNav && SHELL.indexOf(url.pathname) < 0) return;", R),
    ('B7-mint-unbounded', SV, "Buffer.byteLength(source) > BLOC_HTML_MAX_SOURCE_BYTES) return refuse(400, 'bad-bloc');", "false) return refuse(400, 'bad-bloc');", R),
    ('B13-mint-own-cap', SV, "Buffer.byteLength(source) > BLOC_HTML_MAX_SOURCE_BYTES) return refuse(400, 'bad-bloc');", "Buffer.byteLength(source) > 1000) return refuse(400, 'bad-bloc');", R),
    ('B8-id-shape-relaxed', BR, "export const BLOC_ID_RE = /^[A-Za-z0-9_-]{32}$/;", "export const BLOC_ID_RE = /^[\\s\\S]*$/;", R),
    ('B9-mint-without-token', SV, "if (pathOnly === '/api/bloc' && method === 'POST') {", "if (false) {", R),
    ('B10-route-asks-bearer', SV, "const current = readTokenSafe();\n      if (!current) return refuse(404, 'bloc-no-token');", "const current = readTokenSafe();\n      if (!bearer(req)) return refuse(401, 'no-token');\n      if (!current) return refuse(404, 'bloc-no-token');", R),
    ('B11-id-in-memory-not-bound-to-token', BR, "mint(source, digest) {", "mint(source, _digest) { const digest = tokenDigest('');", R),
    ('P1-height-from-anyone', CV, "ev.source === r.frame.contentWindow", "true", C),
    ('P2-no-clamp', CV, "Math.max(BLOC_MIN_H, Math.min(BLOC_MAX_H, Math.ceil(h)))", "Math.ceil(h)", C),
    ('P3-frame-without-sandbox', CV, "f.setAttribute('sandbox', 'allow-scripts'); ", "", C),
    ('P4-any-path-framed', CV, "!/^\\\\/bloc\\\\/[A-Za-z0-9_-]{32}$/.test(j.path)", "false", C),
    ('P5-setting-off-ignored', CV, "var blocOn = c.blocHtml !== false;", "var blocOn = true;", C),
    ('P6-rebuild-kills-frames', CV, "if (Object.keys(blocRowUsed).length) reconcile(list, out);", "if (false) reconcile(list, out);", C),
    ('P7-pending-always-placeholder', CV, "if (sg.kind === 'bloc-pending' && on && l.streaming) {", "if (sg.kind === 'bloc-pending' && on) {", C),
    ('P8-no-report-deadline', CV, "rec.timer = setTimeout(armed, BLOC_REPORT_MS);\n      });", "\n      });", C),
    ('P9-mint-before-near-screen', CV, "if (typeof IntersectionObserver !== 'function') return blocLoad(key, rec);", "return blocLoad(key, rec);", C),
    ('P10-late-mint-frames-after-leaving', CV, "if (blocs[key] !== rec) return; // pruned while the id was being minted", "", C),
    ('P11-blocs-in-every-line', CV, "row = l.text.indexOf('html-render') >= 0 ? assistantBlocRow(l, blocOn) : null;", "row = null;", C),
    ('P12-open-keeps-old-frames', CV, "blocReset(); // a conversation opened over another (no close() between) must not keep the first one's frames", "", C),
    ('P13-deadline-ignores-visibility', CV, "if (document.hidden) { rec.timer = setTimeout(armed, BLOC_REPORT_MS); return; }", "", C),
    ('B12-id-in-the-log', SV, "BLOC_ROUTE_PREFIX + '…' : pathOnly", "pathOnly : pathOnly", R),
    ('W1-conversation-without-switch', RT, ".then((c) => ({ ...c, blocHtml: isBlocHtmlEnabled() }))", "", W),
    ('W2-route-switch-constant', RT, "return { ok: true, enabled: isBlocHtmlEnabled() };", "return { ok: true, enabled: true };", W),
]
pref = sys.argv[1:]
bad = []
for mid, f, a, b, test in MUTANTS:
    if pref and not any(mid.startswith(p) for p in pref): continue
    src = open(f).read()
    if a not in src:
        print(f'{mid}: MUTANT STRING NOT FOUND in {f}'); bad.append(mid); continue
    bak = tempfile.mktemp(); shutil.copy(f, bak)
    try:
        open(f, 'w').write(src.replace(a, b, 1))
        r = subprocess.run(['node', '--test', '--experimental-strip-types', test], capture_output=True, text=True, timeout=240)
        out = r.stdout
        fails = [l for l in out.splitlines() if l.startswith('not ok')]
        skipped = [l for l in out.splitlines() if l.startswith('# skipped')]
        killed = r.returncode != 0 and bool(fails)
        print(f'{mid}: {"KILLED" if killed else ("EQUIVALENT (documented)" if mid in EQUIV else "SURVIVED")} ({len(fails)} failing subtests) {skipped[0] if skipped else ""}')
        if not killed and mid not in EQUIV: bad.append(mid)
    except subprocess.TimeoutExpired:
        print(f'{mid}: HUNG ⇒ SURVIVED'); bad.append(mid)
    finally:
        shutil.copy(bak, f)
        if not filecmp.cmp(bak, f, shallow=False): print(f'{mid}: RESTORE FAILED'); bad.append(mid)
        os.unlink(bak)
print('DIRTY: ' + ', '.join(bad) if bad else 'CLEAN: every mutant killed, every file restored byte-exact')
sys.exit(1 if bad else 0)
