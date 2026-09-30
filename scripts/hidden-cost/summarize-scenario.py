#!/usr/bin/env python3
"""Print a session-scenario result.json as per-window tables.  python3 scripts/hidden-cost/summarize-scenario.py <result.json> [--top 12]"""
import json, sys
r = json.load(open(sys.argv[1]))
top = int(sys.argv[sys.argv.index('--top') + 1]) if '--top' in sys.argv else 12
print(f"label={r.get('label')} containment={r.get('containment')} load@start={r.get('loadavgAtStart')} error={r.get('error')}")
print('cfg', json.dumps(r.get('cfg')))
print('controls', json.dumps(r.get('controls')))
for w in r['windows']:
    q = w['requests']
    c = w['cpu']
    def cp(k): return c.get(k, {'ownCpuMs': 0, 'waitedKidsCpuMs': 0})
    print(f"\n== {w['name']} {w['seconds']}s  API: model={q['model']} count_tokens={q['count_tokens']} other={q['other']} {w.get('otherPaths') or ''}")
    print(f"   procs spawned (exec log): {w['execTotal']}  hook-script execs: {w['hookScriptExecs']}   main-analogue CPU {w.get('mainProcessCpuMs')} ms   renderer-IPC events {w['rendererIpc']['events']} ({w['rendererIpc']['jsonBytes']} B JSON) {w['rendererIpc']['byType']}")
    print(f"   CPU ms  cli own {cp('cli')['ownCpuMs']} (children waited {cp('cli')['waitedKidsCpuMs']})  keeper {cp('keeper')['ownCpuMs']}  mcp {cp('mcp')['ownCpuMs']}  hook-script {cp('hook-script')['ownCpuMs']}")
    for k, n in list(w['execByKey'].items())[:top]: print(f"      {n:4d}  {k}")
    if w['dns'] or w['connectInet']: print('   dns', w['dns'], 'inet', w['connectInet'])
print('\nfinal RSS KB by class', r.get('finalRssKB'))
