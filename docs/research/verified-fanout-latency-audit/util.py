import json,sys,datetime,collections
sys.path.insert(0,'/tmp/vfaudit'); from tx import T
for p in sys.argv[1:]:
    rows=[json.loads(l) for l in open(p,errors='replace') if l.strip()]
    rows=[r for r in rows if r.get('timestamp') and r.get('type') in('user','assistant')]
    br=[r.get('gitBranch') for r in rows if r.get('gitBranch') not in (None,'HEAD')][-1]
    # busy intervals: between consecutive events unless the gap follows a non-tool user prompt boundary with end_turn
    busy=collections.Counter()
    for a,b in zip(rows,rows[1:]):
        ta,tb=T(a['timestamp']),T(b['timestamp'])
        idle = (b['type']=='user' and not (isinstance(b['message'].get('content'),list) and any(isinstance(x,dict) and x.get('type')=='tool_result' for x in b['message']['content'])))
        if idle: continue
        t=ta
        while t<tb:
            bucket=int(t//1800)*1800; nxt=min(tb,bucket+1800); busy[bucket]+=nxt-t; t=nxt
    print('==',br)
    print(' '.join(f"{datetime.datetime.fromtimestamp(k,datetime.UTC).strftime('%H:%M')}:{v/18:.0f}%" for k,v in sorted(busy.items()) if v>0))
