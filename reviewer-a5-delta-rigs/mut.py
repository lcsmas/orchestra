import subprocess, sys, os, shutil, hashlib, re, json, filecmp
WT='/home/lmas/.orchestra/worktrees/orchestra-happy-aspen-87ad7e48'
os.chdir(WT)
CAND_HASH='5ccc480fdfbd57f69d3c952379428686c72c48d1f1bae940d0621cbec259d510'
SUITES=['src/main/bus-parent-run.test.ts','src/main/message-channel-gate.test.ts','src/cli/canonicalize-recipient.test.ts','src/cli/fencing-members.test.ts','src/cli/bus-verbs.test.ts','src/main/bus-run-anchor.test.ts','src/main/wave-run-id.test.ts','src/main/wave-run-anchor-wiring.test.ts']
def sh(cmd, **kw): return subprocess.run(cmd, capture_output=True, text=True, **kw)
def clihash(): return hashlib.sha256(open('dist-electron/cli.js','rb').read()).hexdigest()
def build():
    r=sh(['pnpm','run','build:cli']); assert r.returncode==0, r.stdout[-400:]+r.stderr[-400:]
def run_suites(extra_rig=False):
    r=sh(['node','--test','--experimental-strip-types',*SUITES])
    out=r.stdout
    def num(k):
        m=re.search(r'^# %s (\d+)'%k,out,re.M); return int(m.group(1)) if m else -1
    fails=re.findall(r'^\s*not ok \d+ - (.*)$',out,re.M)
    res=dict(pass_=num('pass'),fail=num('fail'),skipped=num('skipped'),failing=fails[:12])
    if extra_rig:
        rr=sh(['node','scripts/verify-promote-run-refresh.mjs'])
        rf=re.findall(r'^\s*FAIL (.*)$',rr.stdout,re.M)
        res['rig_fail']=len(rf); res['rig_failing']=[x[:90] for x in rf[:8]]; res['rig_allpass']='ALL PASS' in rr.stdout
    return res
def mutate(name, f, old, new, cli=False, rig=False):
    bak='/home/lmas/.orchestra/reviewer-a5-delta-work/bak-'+os.path.basename(f)
    assert sh(['git','diff','--quiet','--',f]).returncode==0, 'tree dirty before '+name
    shutil.copyfile(f,bak)
    src=open(f).read(); n=src.count(old)
    if n!=1:
        print(f'{name}: PATTERN COUNT {n} (need 1) — SKIP'); return
    open(f,'w').write(src.replace(old,new))
    try:
        if cli:
            build(); assert clihash()!=CAND_HASH, name+': bundle unchanged'
        res=run_suites(rig)
    finally:
        shutil.copyfile(bak,f)
    assert filecmp.cmp(bak,f,shallow=False), 'cmp failed '+name
    assert sh(['git','diff','--quiet','--',f]).returncode==0, 'tree dirty after '+name
    if cli:
        build(); assert clihash()==CAND_HASH, name+': rebuilt CLI != candidate hash'
    verdict='RED' if (res['fail']>0 or res['pass_']<178 or res.get('rig_fail',0)>0) else 'SURVIVES'
    print(f'{name}: {verdict} {json.dumps(res)} -> restored clean',flush=True)
if __name__=='__main__':
    sel=sys.argv[1:]
    M=json.load(open('/home/lmas/.orchestra/reviewer-a5-delta-work/mutants.json'))
    # control: unmutated
    print('CONTROL (unmutated):', json.dumps(run_suites(True)),flush=True)
    for m in M:
        if sel and m['name'] not in sel: continue
        mutate(m['name'],m['file'],m['old'],m['new'],m.get('cli',False),m.get('rig',False))
