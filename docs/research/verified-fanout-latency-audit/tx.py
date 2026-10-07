import json,sys,re,glob,os,datetime,collections
def T(s): return datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
def bashcls(cmd):
    c=cmd
    if re.search(r'\bsleep\b|until .*do|while .*sleep|wait_for|Monitor',c): return 'wait/poll'
    if re.search(r'pnpm (run )?test\b|node --test|npm test',c): return 'test-suite'
    if re.search(r'mutant|mutat|mut\.py|run-mutant',c,re.I): return 'mutation'
    if re.search(r'e2e|sway|AppImage|rig|electron|headless|grim',c,re.I): return 'e2e/rig'
    if re.search(r'pnpm (run )?build|vite build|electron-builder|build:cli|build:bus-abi|tsc --noEmit|pnpm install|electron-rebuild',c): return 'build/tsc/install'
    if re.search(r'^\s*(cd [^;&]*&&\s*)?gh\b|\bgh (api|issue|pr)\b',c): return 'gh/ledger'
    if re.search(r'\borchestra\b',c): return 'orchestra-cli'
    if re.search(r'\bgit\b',c): return 'git'
    return 'other-bash'
def analyze(path):
    rows=[]
    for line in open(path,errors='replace'):
        try: rows.append(json.loads(line))
        except: pass
    rows=[r for r in rows if r.get('timestamp') and r.get('type') in('user','assistant')]
    if len(rows)<5: return None
    first_user=next((r for r in rows if r['type']=='user'),None)
    brief=''
    if first_user:
        m=first_user['message'].get('content')
        brief=m if isinstance(m,str) else ' '.join(x.get('text','') for x in m if isinstance(x,dict))
    pending={}  # tool_use_id -> (t, name, cls)
    tool=collections.Counter(); model=0; idle=0; prev_t=None; prev_kind=None
    for r in rows:
        t=T(r['timestamp']); msg=r['message']; content=msg.get('content')
        if r['type']=='assistant':
            if prev_t is not None and prev_kind in('user','toolres'):
                d=t-prev_t
                if d<900: model+=d
                else: idle+=d
            elif prev_t is not None and prev_kind=='assistant':
                d=t-prev_t
                if d<900: model+=d
            if isinstance(content,list):
                for x in content:
                    if x.get('type')=='tool_use':
                        name=x['name']; inp=x.get('input',{})
                        k=name
                        if name=='Bash': k='bash:'+bashcls(inp.get('command',''))
                        elif name in('Read','Grep','Glob'): k='read/search'
                        elif name in('Edit','Write'): k='edit'
                        elif name in('ScheduleWakeup',): k='wakeup'
                        pending[x['id']]=(t,k)
            prev_t=t; prev_kind='assistant'
        else:
            is_res=False
            if isinstance(content,list):
                for x in content:
                    if isinstance(x,dict) and x.get('type')=='tool_result':
                        is_res=True
                        p=pending.pop(x.get('tool_use_id'),None)
                        if p: tool[p[1]]+=t-p[0]
            if not is_res and prev_t is not None:
                idle+=t-prev_t   # human/host prompt: time since last event = idle waiting
            prev_t=t; prev_kind='toolres' if is_res else 'user'
    span=T(rows[-1]['timestamp'])-T(rows[0]['timestamp'])
    brs=[r.get('gitBranch') for r in rows if r.get('gitBranch') and r.get('gitBranch')!='HEAD']
    return dict(span=span,model=model,idle=idle,tool=tool,brief=brief[:4000],branch=brs[-1] if brs else '')
def role(b):
    bl=b.lower()
    if re.search(r'you are the ops|\bops\b.*coordinat|you are ops',bl): return 'OPS'
    if re.search(r'verifier',bl[:600]): return 'verifier'
    if re.search(r'review',bl[:600]): return 'reviewer'
    return 'implementer'
if __name__=='__main__':
    agg=collections.defaultdict(lambda: collections.Counter())
    n=collections.Counter()
    for p in sys.argv[1:]:
        a=analyze(p)
        if not a: continue
        b=a['branch']
        if b.startswith('ops-'): r='OPS'
        elif re.search(r'verifier',b): r='verifier'
        elif b.startswith('review'): r='reviewer'
        elif re.fullmatch(r'[a-z]+-[a-z]+',b) or b in('HEAD',''): r=role(a['brief'])+'?'
        elif re.search(r'-[tabc]\d+b?$|-\d{3}$|-b0$|-a17$',b): r='implementer'
        else: r='other'
        if r=='other': continue
        n[r]+=1
        agg[r]['span']+=a['span']; agg[r]['model']+=a['model']; agg[r]['idle']+=a['idle']
        for k,v in a['tool'].items(): agg[r][k]+=v
        print(f"{r:11} span={a['span']/60:6.0f}m model={a['model']/60:5.0f}m idle={a['idle']/60:5.0f}m tools={sum(a['tool'].values())/60:5.0f}m top="+', '.join(f'{k}:{v/60:.0f}' for k,v in a['tool'].most_common(4)), a['branch'])
    print()
    for r,c in agg.items():
        tot=c['model']+sum(v for k,v in c.items() if k not in('span','model','idle'))
        print(f"== {r} (n={n[r]}) span={c['span']/3600:.1f}h busy={tot/3600:.1f}h model={c['model']/3600:.1f}h ({c['model']/tot:.0%} of busy) idle={c['idle']/3600:.1f}h")
        for k,v in c.most_common():
            if k in('span','model','idle'): continue
            print(f"     {k:28} {v/3600:5.1f}h  {v/tot:4.0%}")
