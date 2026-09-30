#!/usr/bin/env python3
import sys, os, shutil, filecmp, subprocess
sys.path.insert(0, '/home/lmas/rev-a2-delta/probes')
import mutate as m
mid, arm = sys.argv[1], sys.argv[2]
f, old, new = m.M[mid]
path = os.path.join(m.TIP, f); bk = os.path.join(m.BK, mid + '.probe.bak')
assert not subprocess.run(['git','status','--porcelain'],cwd=m.TIP,capture_output=True,text=True).stdout.strip(), 'dirty'
shutil.copyfile(path, bk); src = open(path).read(); assert src.count(old) == 1
open(path, 'w').write(src.replace(old, new))
try:
    env = dict(os.environ, N='6', R=os.environ.get('R','3'))
    p = subprocess.run(['/home/lmas/rev-a2-delta/probes/run-probe.sh', arm], env=env, capture_output=True, text=True, timeout=600)
    print(mid, arm, '=>', (p.stdout.strip().splitlines() or ['<no output>'])[-1][:420])
finally:
    shutil.copyfile(bk, path); os.utime(path, None)
assert filecmp.cmp(bk, path, shallow=False); print('restored-cmp=OK')
print('porcelain:', repr(subprocess.run(['git','status','--porcelain'],cwd=m.TIP,capture_output=True,text=True).stdout.strip()))
