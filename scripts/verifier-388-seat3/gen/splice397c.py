import os
T=os.environ['TMPDIR']; WT=T+'/wt-gui/scripts/'
src=open(WT+'e2e-browser-agent-tabs.mjs').read().split('\n')
def idx(pred, start=0):
    for i in range(start,len(src)):
        if pred(src[i]): return i
    raise SystemExit('anchor missing')
a=idx(lambda l: l.startswith('const ARMS = ')); m0=idx(lambda l: l.startswith('const MUTANTS = {'), a); m1=idx(lambda l: l=='};', m0)
f0=idx(lambda l: l.startswith('const ARM_FNS = {')); f1=idx(lambda l: l=='};', f0)
arms=open(T+'/v3rig/gen/arms397c.js').read().split('\n')
out=src[:a]+["const ARMS = ['stale', 'routes', 'capshare', 'strip8', 'notice', 'bg', 'killers', 'kill2', 'popuptab', 'crash']; // seat 3 (verifier) drive for #397: helpers copied from the member's rig, ARMS/oracles are mine","const MUTANTS = {};"]+src[m1+1:f0]+arms+src[f1+1:]
s='\n'.join(out)
def rep(old,new):
    global s
    assert s.count(old)==1,(old[:60],s.count(old)); s=s.replace(old,new)
rep("const WS_NAMES = ['b397-one', 'b397-two'];","const WS_NAMES = ['b397-one', 'b397-two', 'b397-three'];")
rep("const [W1, W2] = world.workspaces;","const [W1, W2, W3] = world.workspaces;")
rep("const ctx = { world, armDir, W1, W2, FIX,","const ctx = { world, armDir, W1, W2, W3, FIX,")
open(WT+'v3-agent-tabs-drive.mjs','w').write(s)
print('regenerated', len(s))
