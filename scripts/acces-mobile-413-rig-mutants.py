#!/usr/bin/env python3
"""#408 — mutants of the 413 close policy judged by the RIG (scripts/acces-mobile-413-rig.sh), not by the unit tests: each is applied to a SCRATCH copy of
src/ (the tree is never touched), the rig runs on it under load, and the verdict must be DIRTY. A mutant the rig reads CLEAN is SURVIVED (exit 1).
Usage: python3 -I scripts/acces-mobile-413-rig-mutants.py [id ...]   (from the repo root; RUNS=100 per flavor by default, env RIG_MUTANT_RUNS)"""
import os, shutil, subprocess, sys, tempfile

ROOT = os.getcwd()
RUNS = os.environ.get('RIG_MUTANT_RUNS', '100')
SERVER = 'src/acces-mobile/server.ts'
MUTANTS = [
    # (id, old, new) — old must occur exactly once in server.ts
    ('RIG1-old-413-ends-the-response', "          refuseTooLarge();\n", "          res.setHeader('Connection', 'close');\n          refuse(413, 'too-large');\n"),
    ('RIG2-early-destroy-restored', "        if (step === 'hold') req.pause();", "        if (step === 'hold') req.destroy();"),
    ('RIG3-drain-bound-removed', "        if (step === 'hold') req.pause();\n        else if (step === 'done')", "        if (step === 'hold') void 0;\n        else if (step === 'done')"),
    ('RIG4-deadline-never-fires', "          }, opts.refusedLingerMaxMs ?? REFUSED_LINGER_MAX_MS);", "          }, 2 ** 31 - 1);"),
]
def rig(tree):
    return subprocess.run(['bash', 'scripts/acces-mobile-413-rig.sh', '--arms', 'fixed', '--fixed-src', tree, '--runs', RUNS, '--batch', '50', '--load', '8', '--topology', 'both', '--client', 'both'], cwd=ROOT, capture_output=True, text=True, timeout=1800)

only = sys.argv[1:]
bad = 0
# control: the UNmutated tree reads CLEAN through the same rig (a DIRTY below proves nothing if the instrument is DIRTY on a good tree)
ctl = tempfile.mkdtemp(prefix='rig-mutant-ctl-', dir=os.environ.get('TMPDIR') or None)
try:
    subprocess.run(['rsync', '-a', os.path.join(ROOT, 'src') + '/', os.path.join(ctl, 'src') + '/'], check=True)
    os.symlink(os.path.join(ROOT, 'node_modules'), os.path.join(ctl, 'node_modules'))
    c = rig(ctl)
    print('CONTROL unmutated tree:', 'CLEAN' if 'RIG VERDICT: CLEAN' in c.stdout else 'DIRTY — INSTRUMENT BROKEN'); bad += 0 if 'RIG VERDICT: CLEAN' in c.stdout else 1
finally:
    shutil.rmtree(ctl, ignore_errors=True)
if bad: print(c.stdout[-1500:]); sys.exit(1)
for mid, old, new in MUTANTS:
    if only and not any(mid.startswith(p) for p in only): continue
    scratch = tempfile.mkdtemp(prefix='rig-mutant-', dir=os.environ.get('TMPDIR') or None)
    try:
        subprocess.run(['rsync', '-a', os.path.join(ROOT, 'src') + '/', os.path.join(scratch, 'src') + '/'], check=True)
        os.symlink(os.path.join(ROOT, 'node_modules'), os.path.join(scratch, 'node_modules'))
        path = os.path.join(scratch, SERVER); src = open(path).read()
        if src.count(old) != 1: print(f'{mid}: ANCHOR NOT FOUND (count={src.count(old)}) — instrument broken'); bad += 1; continue
        open(path, 'w').write(src.replace(old, new))
        out = rig(scratch)
        lines = [l for l in out.stdout.splitlines() if l.startswith('fixed ')]
        red = [f"{l.split()[1]}/{l.split()[2]} -1={l.split()[5]}" for l in lines if len(l.split()) > 5 and l.split()[2] != 'hostile' and l.split()[5] != '0']
        held = [f"{l.split()[1]}/hostile held={l.split()[7]} unb={l.split()[8]}" for l in lines if l.split()[2] == 'hostile' and (l.split()[7] != '0' or l.split()[8] != '0' or l.split()[4] != l.split()[3])]
        verdict = 'DIRTY' if 'RIG VERDICT: DIRTY' in out.stdout else ('CLEAN' if 'RIG VERDICT: CLEAN' in out.stdout else 'NO VERDICT')
        ok = verdict == 'DIRTY'
        print(f'{mid}: rig {verdict} on {(red + held)[:4] or out.stdout[-300:]!r} {"OK" if ok else "SURVIVED"}')
        if not ok: bad += 1
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
print('RIG MUTANTS CLEAN' if bad == 0 else f'RIG MUTANTS DIRTY ({bad})')
sys.exit(1 if bad else 0)
