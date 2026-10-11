#!/usr/bin/env python3
"""Accès mobile (#334): remove each auth/bind clause in place, run the server suite, require RED, restore byte-exact.
Usage: python3 -I scripts/acces-mobile-mutants.py   (from the repo root)"""
import os, shutil, subprocess, sys, filecmp

ROOT = os.getcwd()
TEST = 'src/acces-mobile/server.test.ts'
MUTANTS = [
    # (id, file, original, replacement, expected) — expected 'RED' (must be killed) or 'EQUIV' (a second guard covers it)
    ('M1-no-allowed-login', 'src/acces-mobile/server.ts', "    if (!opts.allowedLogin) return refuse(403, 'no-allowed-login');\n", '', 'RED'),
    ('M2-missing-identity', 'src/acces-mobile/server.ts', "    if (typeof login !== 'string' || login === '') return refuse(403, 'no-identity');\n", "    if (typeof login !== 'string') { /* mutant */ }\n", 'RED'),
    ('M3-wrong-identity', 'src/acces-mobile/server.ts', "    if (!sameLogin(login, opts.allowedLogin)) return refuse(403, 'wrong-identity');\n", '', 'RED'),
    ('M4-bad-token', 'src/acces-mobile/server.ts', "    if (!tokenMatches(presented, expected)) return refuse(401, 'bad-token');\n", '', 'RED'),
    ('M5-no-token', 'src/acces-mobile/server.ts', "    if (!presented) return refuse(401, 'no-token');\n", '', 'RED'),
    ('M6-empty-expected', 'src/acces-mobile/server.ts', "  if (!presented || !expected) return false;\n", "  if (!presented) return false;\n", 'EQUIV'),  # sha256 of a non-empty token never equals sha256('')
    ('M7-login-substring', 'src/shared/acces-mobile.ts', "  return a.trim().toLowerCase() === b.trim().toLowerCase();\n", "  return a.trim().toLowerCase().startsWith(b.trim().toLowerCase());\n", 'RED'),
    ('M8-bind-all', 'src/acces-mobile/index.ts', "server.listen(port, '127.0.0.1',", "server.listen(port, '0.0.0.0',", 'RED'),
    ('M9-token-read-once', 'src/acces-mobile/server.ts', "      expected = opts.readToken().trim();\n", "      expected = (globalThis as any).__t ??= opts.readToken().trim();\n", 'RED'),
    ('M10-shell-without-identity', 'src/acces-mobile/server.ts', "    const login = req.headers['tailscale-user-login'];\n", "    const asset0 = STATIC[pathOnly]; if (asset0) { res.writeHead(200); res.end(asset0.body); return; }\n    const login = req.headers['tailscale-user-login'];\n", 'RED'),
]

bad = 0
for mid, rel, old, new, expected in MUTANTS:
    path = os.path.join(ROOT, rel)
    backup = path + '.mutant-backup'
    src = open(path).read()
    if src.count(old) != 1:
        print(f'{mid}: ANCHOR NOT FOUND (count={src.count(old)}) — instrument broken'); bad += 1; continue
    shutil.copy2(path, backup)
    try:
        open(path, 'w').write(src.replace(old, new))
        r = subprocess.run(['node', '--test', '--experimental-strip-types', TEST], cwd=ROOT, capture_output=True, text=True, timeout=180)
        fails = [l for l in r.stdout.splitlines() if l.startswith('# fail ')]
        red = r.returncode != 0
        verdict = 'RED' if red else 'GREEN'
        ok = (verdict == 'RED') if expected == 'RED' else True
        print(f'{mid}: {verdict} ({fails[0] if fails else "no summary"}) expected={expected} {"OK" if ok else "SURVIVED"}')
        if not ok: bad += 1
    finally:
        shutil.copy2(backup, path); os.remove(backup)
        if open(path).read() != src: print(f'{mid}: RESTORE FAILED'); bad += 1
# control: the unmutated suite is green
r = subprocess.run(['node', '--test', '--experimental-strip-types', TEST], cwd=ROOT, capture_output=True, text=True, timeout=180)
print(f'CONTROL unmutated: {"GREEN" if r.returncode == 0 else "RED"}')
if r.returncode != 0: bad += 1
print('CLEAN' if bad == 0 else f'DIRTY ({bad})')
sys.exit(1 if bad else 0)
