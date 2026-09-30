#!/usr/bin/env python3
"""Print an app-idle-rig result.json as tables: per-window CPU/RSS, exec keys per minute, DNS/connect.
   python3 scripts/hidden-cost/summarize-app.py <result.json> [--top 25]"""
import json, sys
r = json.load(open(sys.argv[1]))
top = int(sys.argv[sys.argv.index('--top') + 1]) if '--top' in sys.argv else 25
print(f"label={r['label']} ws={r['ws']} version={r['pkgVersion']} bootToUiMs={r.get('bootToUiMs')} rows={r.get('rowsMounted')} void={r.get('void')}")
print('controls:', json.dumps(r.get('controls')))
for w in r['windows']:
    print(f"\n== window {w['name']} {w['seconds']}s vis {w['visibilityStart']}->{w['visibilityEnd']} procs={w['nProcs']} rss={w['rssKB']//1024}MB orchestra.log +{w['orchestraLogBytes']}B")
    for k, v in sorted(w['cpu'].items()):
        pct = 100 * v['ownCpuS'] / w['seconds']
        kid = 100 * v['waitedKidsCpuS'] / w['seconds']
        print(f"   {k:24s} own {v['ownCpuS']:7.2f}s ({pct:5.2f}% of 1 core)  waited-children {v['waitedKidsCpuS']:6.2f}s ({kid:5.2f}%)  n={v['n']} rss={v['rssKB']//1024}MB")
    e = r['events'].get(w['name'], {})
    print(f"   execs total {e.get('execTotal')} ({e.get('execTotal', 0) / (w['seconds'] / 60):.1f}/min)")
    for k, v in list(e.get('execByKey', {}).items())[:top]:
        print(f"      {v['perMin']:7.2f}/min  {v['count']:5d}  {k}")
    print('   dns:', {k: v['count'] for k, v in e.get('dns', {}).items()}, ' inet:', {k: v['count'] for k, v in e.get('connectInet', {}).items()}, ' unix connects:', e.get('connectUnixCount'))
b = r['events'].get('boot', {})
print(f"\n== boot (launch → UI ready, {r.get('bootToUiMs')} ms): execs {b.get('execTotal')}")
for k, n in list(b.get('execByKey', {}).items())[:top]: print(f"      {n:4d}  {k}")
print('   dns:', b.get('dns'), ' inet:', b.get('connectInet'))
print('gh stub calls sample:', r.get('ghCallsSample'))
