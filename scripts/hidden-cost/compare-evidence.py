#!/usr/bin/env python3
"""Side-by-side of the headline metrics between two evidence directories (e.g. before/after a rebase).
   python3 scripts/hidden-cost/compare-evidence.py <old-evidence-dir> <new-evidence-dir>"""
import json, os, sys
A, B = sys.argv[1], sys.argv[2]
def load(d, n):
    f = os.path.join(d, n)
    return json.load(open(f)) if os.path.exists(f) else None
def pct(r, win, cls, kind='ownCpuS'):
    w = next((x for x in r['windows'] if x['name'] == win), None) if r else None
    return None if not w or cls not in w['cpu'] else round(100 * w['cpu'][cls][kind] / w['seconds'], 2)
def spm(r, win):
    w = next((x for x in r['windows'] if x['name'] == win), None) if r else None
    return None if not w else round(r['events'][win]['execTotal'] / (w['seconds'] / 60), 1)
def rss(r, win):
    w = next((x for x in r['windows'] if x['name'] == win), None) if r else None
    return None if not w else w['rssKB'] // 1024
rows = []
for lab, win, cls in [('idle8', 'steady-visible', 'electron-renderer'), ('idle8', 'steady-visible', 'electron-gpu-process'), ('idle8', 'steady-visible', 'electron-main'),
                      ('ws24', 'steady-visible', 'electron-main'), ('run8', 'steady-running', 'electron-gpu-process'), ('run8', 'steady-running', 'electron-renderer'),
                      ('fg1', 'sessions-streaming', 'electron-renderer'), ('fg1', 'sessions-streaming', 'electron-gpu-process'), ('bg1', 'sessions-streaming', 'electron-renderer'),
                      ('sess4', 'sessions-streaming', 'electron-renderer')]:
    a, b = load(A, f'app-{lab}.json'), load(B, f'app-{lab}.json')
    rows.append((f'{lab} {win} {cls} %core', pct(a, win, cls), pct(b, win, cls)))
for lab, win in [('idle8', 'steady-visible'), ('ws24', 'steady-visible'), ('hid8', 'steady-hidden'), ('hid8', 'steady-visible')]:
    a, b = load(A, f'app-{lab}.json'), load(B, f'app-{lab}.json')
    rows.append((f'{lab} {win} spawns/min', spm(a, win), spm(b, win)))
for lab, win in [('idle8', 'steady-visible'), ('fg1', 'sessions-idle')]:
    a, b = load(A, f'app-{lab}.json'), load(B, f'app-{lab}.json')
    rows.append((f'{lab} {win} RSS MB', rss(a, win), rss(b, win)))
for name in ('scn-base.json',):
    a, b = load(A, name), load(B, name)
    for wn in ('turn0-tools0', 'turn1-tools1', 'turn2-tools3', 'idle'):
        g = lambda r, k: None if not r else next((w for w in r['windows'] if w['name'] == wn), {}).get(k)
        rows.append((f'{name} {wn} procs', g(a, 'execTotal'), g(b, 'execTotal')))
        rows.append((f'{name} {wn} count_tokens', (g(a, 'requests') or {}).get('count_tokens'), (g(b, 'requests') or {}).get('count_tokens')))
    rows.append((f'{name} final RSS kB', json.dumps(a and a.get('finalRssKB')), json.dumps(b and b.get('finalRssKB'))))
h1, h2 = load(A, 'hook-cost.json'), load(B, 'hook-cost.json')
for ev in ('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'):
    rows.append((f'hook {ev} procs/wall/cpu', h1 and (h1['events'][ev]['execsPerEvent'], h1['events'][ev]['wallMsPerEvent'], h1['events'][ev]['cpuMsPerEvent']), h2 and (h2['events'][ev]['execsPerEvent'], h2['events'][ev]['wallMsPerEvent'], h2['events'][ev]['cpuMsPerEvent'])))
print(f"{'metric':60s} {'old':>22s} {'new':>22s}")
for m, x, y in rows: print(f'{m:60s} {str(x):>22s} {str(y):>22s}')
