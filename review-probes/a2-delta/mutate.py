#!/usr/bin/env python3
"""In-place mutants on the candidate tree (byte-exact backup + cmp restore). One harness, run alone.
usage: mutate.py <id> [<id>...]   ids below.  Prints per-mutant: failing test names of the 3 A2 files."""
import subprocess, shutil, sys, os, re, filecmp, time

TIP = '/home/lmas/.orchestra/worktrees/orchestra-silent-beetle-2c058ab8'
BK = '/home/lmas/rev-a2-delta/probes/bk'
os.makedirs(BK, exist_ok=True)

KC = 'src/main/keeper-client.ts'
KD = 'src/keeper/index.ts'
M = {
  'K4a_no_starttime': (KC, "return !!fresh && fresh.startTicks === d.startTicks && !/\\) Z /.test(text);", "return !!fresh && !/\\) Z /.test(text);"),
  'K4b_no_zombie':    (KC, "return !!fresh && fresh.startTicks === d.startTicks && !/\\) Z /.test(text);", "return !!fresh && fresh.startTicks === d.startTicks;"),
  'L1a_age_only':     (KD, "if (dead || Date.now() - fs.statSync(claimPath).mtimeMs > 5000) fs.unlinkSync(claimPath);", "if (Date.now() - fs.statSync(claimPath).mtimeMs > 5000) fs.unlinkSync(claimPath);"),
  'L1b_dead_only':    (KD, "if (dead || Date.now() - fs.statSync(claimPath).mtimeMs > 5000) fs.unlinkSync(claimPath);", "if (dead) fs.unlinkSync(claimPath);"),
  'L1c_never_release':(KD, "if (fs.readFileSync(claimPath, 'utf8') === String(process.pid)) fs.unlinkSync(claimPath);", "void 0;"),
  'L1d_never_break':  (KD, "if (dead || Date.now() - fs.statSync(claimPath).mtimeMs > 5000) fs.unlinkSync(claimPath);", "void dead;"),
  'K4d_only_sigkill': (KC, "await new Promise((r) => setTimeout(r, 50));\n    }\n  }\n  await killSurvivingDescendants(wsId, tree, reason);\n", "await new Promise((r) => setTimeout(r, 50));\n      await killSurvivingDescendants(wsId, tree, reason);\n    }\n  }\n"),
}

FILES = ['src/keeper/keeper.test.ts', 'src/shared/resource-monitor.test.ts', 'src/main/keeper-lifecycle.test.ts']

def run_tests():
    env = dict(os.environ, HOME='/home/lmas/rd', TMPDIR='/home/lmas/rd/tmp')
    out = {}
    for f in FILES:
        p = subprocess.run(['/usr/bin/node', '--test', '--experimental-strip-types', f], cwd=TIP, env=env, capture_output=True, text=True, timeout=900)
        txt = p.stdout + p.stderr
        fails = re.findall(r'^not ok \d+ - (.*?)(?: #.*)?$', txt, re.M)
        m = {k: (re.search(r'^# %s (\d+)' % k, txt, re.M) or [None, '?'])[1] for k in ('tests', 'pass', 'fail', 'skipped')}
        out[f] = (m, [x[:70] for x in fails])
    return out

def main(ids):
    # clean-control first
    if subprocess.run(['git', 'status', '--porcelain'], cwd=TIP, capture_output=True, text=True).stdout.strip():
        print('ABORT: tree dirty before start'); return
    for mid in ids:
        f, old, new = M[mid]
        path = os.path.join(TIP, f)
        bk = os.path.join(BK, mid + '.bak')
        shutil.copyfile(path, bk)
        src = open(path).read()
        assert src.count(old) == 1, f'{mid}: pattern count {src.count(old)}'
        open(path, 'w').write(src.replace(old, new))
        t0 = time.time()
        try:
            res = run_tests()
        finally:
            shutil.copyfile(bk, path)
            os.utime(path, None)
        assert filecmp.cmp(bk, path, shallow=False), f'{mid}: restore mismatch'
        print(f'=== {mid} ({time.time()-t0:.0f}s) restored-cmp=OK')
        for k, (m, fails) in res.items():
            print(f'  {k}: {m}  RED={fails}')
    print('tree porcelain after:', repr(subprocess.run(['git', 'status', '--porcelain'], cwd=TIP, capture_output=True, text=True).stdout.strip()))

if __name__ == '__main__':
    main(sys.argv[1:])
