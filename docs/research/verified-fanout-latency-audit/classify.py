import json,re,datetime,collections,sys
def ts(s): return datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
def cls(h):
    hl=h.lower()
    if re.search(r'wave closed',hl): return 'CLOSE'
    if re.search(r'\bg4\b|merged master|merged tip|merged:',hl): return 'MERGEGATE'
    if re.search(r'review|reviewer',hl) and not re.search(r'nominat|addressed|dispositioned|fixed',hl): return 'REVIEW'
    if re.search(r'verif|pre-merge g0|final pre-merge|re-gate|matrix|verdict',hl): return 'GATE'
    if re.search(r'nominat|fix round|delta|addressed|dispositioned|re-point|done',hl): return 'NOM'
    if re.search(r'rebase|ref update|re-tip',hl): return 'REBASE'
    if re.search(r'question|lead|ops',hl): return 'COORD'
    return 'OTHER'
def track(h):
    m=re.search(r'\b([TABC]\d+b?)\b',h)
    if m: return m.group(1)
    m=re.search(r'reviewer-([tabc]\d+b?)',h,re.I)
    if m: return m.group(1).upper()
    m=re.search(r'#(\d{3})',h)
    return '#'+m.group(1) if m else '?'
for n in map(int,sys.argv[1:]):
    cs=json.load(open(f'/tmp/vfaudit/c{n}.json'))
    ev=collections.defaultdict(list)
    for c in cs:
        h=c['body'].strip().split('\n')[0]
        ev[track(h)].append((ts(c['created_at']),cls(h),len(c['body'])))
    print('=====',n)
    for t,es in sorted(ev.items()):
        cnt=collections.Counter(e[1] for e in es)
        span=(es[-1][0]-es[0][0]).total_seconds()/60
        print(f"{t:6} n={len(es):3} span={span:6.0f}min  "+' '.join(f'{k}={v}' for k,v in sorted(cnt.items())),
              ' | '+' '.join(f"{e[0].strftime('%d%H:%M')}{e[1][0]}" for e in es))

# ---- latency pairing
import statistics
lat=collections.defaultdict(list)
for n in [198,224,234,237]:
    cs=json.load(open(f'/tmp/vfaudit/c{n}.json'))
    ev=collections.defaultdict(list)
    for c in cs:
        h=c['body'].strip().split('\n')[0]
        ev[track(h)].append((ts(c['created_at']),cls(h)))
    for t,es in ev.items():
        lastnom=None; lastrev=None
        for (tm,k) in es:
            if k=='NOM':
                if lastrev and (not lastnom or lastrev>lastnom): lat['review->fix-nom'].append(((tm-lastrev).total_seconds()/60,n,t))
                lastnom=tm
            elif k=='REVIEW' and lastnom: lat['nom->review'].append(((tm-lastnom).total_seconds()/60,n,t)); lastrev=tm
            elif k in('GATE','MERGEGATE') and lastnom: lat['nom->gate'].append(((tm-lastnom).total_seconds()/60,n,t))
    # gaps
    allt=sorted(ts(c['created_at']) for c in cs)
    gaps=sorted(((b-a).total_seconds()/60,a) for a,b in zip(allt,allt[1:]))[-4:]
    print(n,'largest gaps (min):',[(round(g),a.strftime('%m-%d %H:%M')) for g,a in gaps])
for k,v in lat.items():
    xs=sorted(x[0] for x in v if x[0]<600)
    print(k,'n=',len(xs),'median=%.0f p75=%.0f max=%.0f'%(statistics.median(xs),xs[int(len(xs)*.75)],xs[-1]))
