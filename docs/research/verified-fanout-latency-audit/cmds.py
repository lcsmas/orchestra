import json,sys,re,datetime,collections,statistics
sys.path.insert(0,'/tmp/vfaudit')
from tx import bashcls,T
waits=[];suites=[];bg=collections.Counter();bgk=collections.Counter()
for p in sys.argv[1:]:
    rows=[]
    for l in open(p,errors='replace'):
        try: rows.append(json.loads(l))
        except: pass
    br=[r.get('gitBranch') for r in rows if r.get('gitBranch') not in (None,'HEAD')]
    br=br[-1] if br else ''
    pend={}; lastbg=''
    for r in rows:
        if r.get('type')=='assistant' and isinstance(r['message'].get('content'),list):
            for x in r['message']['content']:
                if x.get('type')=='tool_use' and x['name'] in('Bash','Monitor'):
                    cmd=x['input'].get('command','') or x['input'].get('until','') or json.dumps(x['input'])[:300]
                    if x['input'].get('run_in_background'):
                        lastbg=cmd; bg[bashcls(cmd)]+=1
                    pend[x['id']]=(T(r['timestamp']),cmd,lastbg,x['name'])
        elif r.get('type')=='user' and isinstance(r['message'].get('content'),list):
            for x in r['message']['content']:
                if isinstance(x,dict) and x.get('type')=='tool_result' and x.get('tool_use_id') in pend:
                    t0,cmd,lb,nm=pend.pop(x['tool_use_id']); d=T(r['timestamp'])-t0
                    k=bashcls(cmd) if nm=='Bash' else 'wait/poll'
                    if k=='wait/poll': waits.append((d,br,cmd[:150].replace('\n',' '),bashcls(lb) if lb else '-',lb[:100].replace('\n',' ')))
                    if k=='test-suite': suites.append((d,br,cmd[:120].replace('\n',' ')))
waits.sort(reverse=True)
tot=sum(w[0] for w in waits)
print('WAIT total %.1fh n=%d'%(tot/3600,len(waits)))
by=collections.Counter()
for w in waits: by[w[3]]+=w[0]
print('wait attributed to last background job class:',{k:round(v/3600,1) for k,v in by.most_common()})
for w in waits[:25]: print('%5.0fs %-28s WAITCMD: %s\n        BG[%s]: %s'%(w[0],w[1][:28],w[2][:110],w[3],w[4]))
print()
print('background launches by class',bg.most_common())
full=[s[0] for s in suites if re.search(r'pnpm (run )?test\s*($|2>|\||>|;|&)',s[2])]
print('full pnpm test foreground runs n=%d median=%.0fs p90=%.0fs'%(len(full),statistics.median(full),sorted(full)[int(len(full)*.9)]) if full else 'no full')
