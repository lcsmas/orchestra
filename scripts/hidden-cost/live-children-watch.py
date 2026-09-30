#!/usr/bin/env python3
"""C2 #209 — FIELD sampler (read-only): watch the direct children of the LIVE Orchestra main process for N seconds and
count short-lived helper spawns by argv class. Reads /proc/<pid>/task/*/children + /proc/<child>/cmdline every ~15 ms —
catches processes that live >= ~15 ms (a `git diff`/`gh api` lives 5-500 ms), so counts are a LOWER BOUND (positive control:
the number of distinct pids seen is printed next to the reading).
   python3 scripts/hidden-cost/live-children-watch.py [seconds=60]"""
import os, sys, time, re, collections
secs = float(sys.argv[1]) if len(sys.argv) > 1 else 60
def main_pid():
    """The Electron MAIN process of the installed app: `<mount>/orchestra` (or electron) with no --type= and not the CLI verb."""
    up = float(open('/proc/uptime').read().split()[0]); best = None
    for d in os.listdir('/proc'):
        if not d.isdigit(): continue
        try:
            cmd = open(f'/proc/{d}/cmdline', 'rb').read().split(b'\0'); line = b' '.join(cmd)
        except Exception: continue
        if b'--type=' in line or not cmd or b' cli' in line: continue
        if re.search(rb'\.mount_Orche[^/]*/orchestra$', cmd[0]):
            age = up - int(open(f'/proc/{d}/stat').read().rsplit(')', 1)[1].split()[19]) / 100
            if best is None or age > best[1]: best = (int(d), age)
    return best[0] if best else None
pid = main_pid()
if not pid: sys.exit('live Orchestra main pid not found')
seen = {}; last = {}
t0 = time.time()
while time.time() - t0 < secs:
    try:
        for tid in os.listdir(f'/proc/{pid}/task'):
            try:
                for c in open(f'/proc/{pid}/task/{tid}/children').read().split():
                    last[c] = time.time()
                    try: cur = open(f'/proc/{c}/cmdline', 'rb').read().split(b'\0')
                    except Exception: cur = None
                    # a fresh child shows the PARENT's argv until it execs: keep the LAST non-empty reading that differs from the parent's
                    if c not in seen: seen[c] = (time.time(), cur or [b'?'])
                    elif cur and cur != seen[c][1] and any(cur): seen[c] = (seen[c][0], cur)
            except Exception: pass
    except Exception: break
    time.sleep(0.004)
def key(cmd):
    a = [x.decode('utf8', 'replace') for x in cmd if x]
    if not a: return '?'
    base = os.path.basename(a[0])
    if base == 'git':
        i = 1
        while i < len(a):
            if a[i] in ('-C', '-c'): i += 2; continue
            if a[i].startswith('-'): i += 1; continue
            return 'git ' + a[i]
        return 'git'
    if base == 'gh': return 'gh ' + re.sub(r'\d+', 'N', ' '.join(x for x in a[1:3]))[:60]
    return base + (' ' + a[1][:30] if len(a) > 1 and not a[1].startswith('-') else '')
c = collections.Counter(key(v[1]) for v in seen.values())
print(f'live main pid={pid} watched {secs:.0f}s distinct child pids seen={len(seen)}')
for k, n in c.most_common(20): print(f'{n:5d}  {n/secs*60:6.1f}/min  {k}')

if '--detail' in sys.argv:
    print('--- detail: full argv (first 160 chars) + observed lifetime ms, for classes orchestra / node / ?')
    det = collections.defaultdict(list)
    for c, (t, cmd) in seen.items():
        k = key(cmd)
        if k.startswith('orchestra') or k.startswith('node') or k == '?':
            det[' '.join(x.decode('utf8', 'replace') for x in cmd if x)[:160]].append((last[c] - t) * 1000)
    for line, lifes in sorted(det.items(), key=lambda kv: -len(kv[1]))[:12]:
        print(f'{len(lifes):5d}x  life median {sorted(lifes)[len(lifes)//2]:6.0f} ms  {line}')
