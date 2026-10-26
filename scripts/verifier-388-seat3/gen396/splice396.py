import os
T=os.environ['TMPDIR']; WT=T+'/wt-gui/scripts/'
src=open(WT+'e2e-browser-popups.mjs').read().split('\n')
m=next(i for i,l in enumerate(src) if l.startswith('// ═════════════════════════════════════ main'))
f=next(i for i,l in enumerate(src) if l.startswith('const after = liveCanary();'))
mine=open(T+'/v3rig/gen396/main396.js').read().split('\n')
head=src[:m]
s='\n'.join(head+mine+src[f:])
def rep(old,new):
    global s
    assert s.count(old)==1,(old[:60],s.count(old)); s=s.replace(old,new)
rep("const ARMS = new Set(flag('--arms', 'blank,oauth,xsite,hostile,extproto,storm,ws,cleanup').split(','));","const ARMS = new Set();")
open(WT+'v3-popups-drive.mjs','w').write(s)
print('regenerated',len(s))
