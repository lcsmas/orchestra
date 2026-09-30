#!/usr/bin/env python3
"""FIELD facts about the LIVE machine's Orchestra (read-only): store shape, transcript sizes the loop-scan sweep reads, renderer CPU-threshold
warnings from the live log, GitHub rate-limit read. Nothing is written or signalled.   python3 scripts/hidden-cost/field-notes.py"""
import json, os, re, time, glob, subprocess, collections
H = os.path.expanduser('~')
st = json.load(open(f'{H}/.config/orchestra/orchestra/store.json'))
ws = [w for w in st['workspaces'] if not w.get('archived')]
print(f"store.json: {len(st['workspaces'])} workspaces, {len(ws)} active, {len(st['repos'])} repos")
kinds = collections.Counter((w.get('kind', 'worktree'), 'sandbox' if (w.get('host') or {}).get('kind') == 'sandbox' else 'local') for w in ws)
print('  active by kind:', dict(kinds))
print('  active per repoPath:', dict(collections.Counter(os.path.basename(w.get('repoPath') or '') or '(none)' for w in ws)))
print('  with linkedPrs:', sum(1 for w in ws if w.get('linkedPrs')), ' accounts:', len(st.get('accounts', [])))
accts = {a['id']: a for a in st.get('accounts', [])}
def cfgdir(w):
    a = accts.get(w.get('accountId'))
    if not a:
        for r in st['repos']:
            if r['path'] == w.get('repoPath') and r.get('accountId') in accts: a = accts[r['accountId']]
    return os.path.expanduser(((a or {}).get('configDir') or '~/.claude').replace('${HOME}', H))
sizes, recent = [], []
now = time.time()
for w in ws:
    if not w.get('worktreePath'): continue
    base = os.path.join(cfgdir(w), 'projects', re.sub(r'[^A-Za-z0-9]', '-', w['worktreePath']))
    f = os.path.join(base, (w.get('sdkSessionId') or '') + '.jsonl') if w.get('sdkSessionId') else None
    if not (f and os.path.exists(f)):
        cands = glob.glob(os.path.join(base, '*.jsonl')); f = max(cands, key=os.path.getmtime) if cands else None
    if not f: continue
    s = os.stat(f); sizes.append(s.st_size)
    if now - s.st_mtime < 300: recent.append(s.st_size)
CAP = 8 * 1024 * 1024
print(f"transcripts: {len(sizes)} workspaces, median {sorted(sizes)[len(sizes)//2]/1e6:.2f} MB, max {max(sizes)/1e6:.1f} MB; loop-scan (5 min sweep, cap 8 MB) would read "
      f"{sum(min(x, CAP) for x in recent)/1e6:.1f} MB from the {len(recent)} transcripts changed in the last 5 min ({sum(min(x, CAP) for x in sizes)/1e6:.1f} MB if all changed)")
log = f'{H}/.config/orchestra/logs/orchestra.log'
hits = [l for l in open(log, errors='replace') if 'electron-cpu over threshold' in l]
tsec = lambda l: time.mktime(time.strptime(l[:19], '%Y-%m-%dT%H:%M:%S'))
names = sorted(set(re.findall(r'— ([A-Za-z]+) \(pid (\d+)\)', ''.join(hits))))
span = (tsec(hits[-1]) - tsec(hits[0])) / 60 if hits else 0
print(f"live log {log}: {len(hits)} 'electron-cpu over threshold' warnings (one per minute the process is >100% CPU); first {hits[0][:24]} last {hits[-1][:24]} = {span:.0f} min span; distinct (type,pid): {names}")
for label, env in (('env GITHUB_TOKEN', None), ('hosts.yml token', {'GITHUB_TOKEN': '', 'GH_TOKEN': ''})):
    e = dict(os.environ); 
    if env:
        e.pop('GITHUB_TOKEN', None); e.pop('GH_TOKEN', None)
    r = subprocess.run(['gh', 'api', 'rate_limit', '--jq', '.resources.core'], capture_output=True, text=True, env=e)
    print(f'gh rate_limit core ({label}): {r.stdout.strip() or r.stderr.strip()[:120]}')
