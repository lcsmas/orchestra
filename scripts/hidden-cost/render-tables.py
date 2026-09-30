#!/usr/bin/env python3
"""Render the evidence directory into markdown tables (docs/research/hidden-cost-inventory/evidence/tables.md).
Every number in docs/research/hidden-cost-inventory.md is copied from THIS output, never typed.
   python3 scripts/hidden-cost/render-tables.py [evidence-dir] > tables.md"""
import json, os, sys, glob

EV = sys.argv[1] if len(sys.argv) > 1 else 'docs/research/hidden-cost-inventory/evidence'
out = []
p = out.append

def load(name):
    f = os.path.join(EV, name)
    return json.load(open(f)) if os.path.exists(f) else None

SKIP = {'electron-zygote', 'electron-utility', 'other', 'electron-other', 'mcp-child'}

def app_tables():
    for f in sorted(glob.glob(os.path.join(EV, 'app-*.json'))):
        r = json.load(open(f))
        label = r['label']
        p(f"### `{os.path.basename(f)}` — ws={r['ws']} fakeNet={r.get('fakeNet')} v{r['pkgVersion']} void={r['void'] or 'none'}")
        p('')
        p('| window | s | vis start→end | CSS anims | main own | main children | renderer | GPU | claude | keeper | RSS all MB | execs/min |')
        p('|---|---|---|---|---|---|---|---|---|---|---|---|')
        for w in r['windows']:
            c = w['cpu']
            def pct(k, kind='ownCpuS'):
                return f"{100 * c[k][kind] / w['seconds']:.2f}%" if k in c else '–'
            e = r['events'].get(w['name'], {})
            per = e.get('execTotal', 0) / (w['seconds'] / 60)
            p(f"| {w['name']} | {w['seconds']:.0f} | {w['visibilityStart']}→{w['visibilityEnd']} | {w.get('runningCssAnimations')} | {pct('electron-main')} | {pct('electron-main','waitedKidsCpuS')} | {pct('electron-renderer')} | {pct('electron-gpu-process')} | {pct('claude')} | {pct('keeper')} | {w['rssKB']//1024} | {per:.0f} |")
        p('')
        for w in r['windows']:
            e = r['events'].get(w['name'], {})
            top = list(e.get('execByKey', {}).items())[:8]
            if not top: continue
            p(f"- **{w['name']}** spawns/min: " + '; '.join(f"`{k}` {v['perMin']}" for k, v in top))
            net = {k: v['perMin'] for k, v in e.get('dns', {}).items()}
            if net: p(f"  - DNS attempts/min: {net}")
            inet = {k: v['count'] for k, v in e.get('connectInet', {}).items()}
            if inet: p(f"  - inet connect attempts (count in window): {inet}")
        b = r['events'].get('boot')
        if b:
            p(f"- **boot** (launch→UI ready {r.get('bootToUiMs')} ms): {b['execTotal']} spawns; top: " + '; '.join(f"`{k}` {n}" for k, n in list(b['execByKey'].items())[:8]) + f"; DNS {b.get('dns')}")
        for key in ('hideProof', 'focusCycles', 'sessions', 'runningRowsRendered'):
            if r.get(key) is not None: p(f"- {key}: `{json.dumps(r[key])[:300]}`")
        p('')

def scn_tables():
    for f in sorted(glob.glob(os.path.join(EV, 'scn-*.json'))):
        r = json.load(open(f))
        p(f"### `{os.path.basename(f)}` — {json.dumps(r.get('cfg'))} load@start={r.get('loadavgAtStart')} error={r.get('error')}")
        p('')
        p('| window | s | model req | count_tokens | other req | procs spawned | hook-script execs | main-analogue CPU ms | CLI own CPU ms | CLI children CPU ms | keeper CPU ms | MCP CPU ms | runner reaped-children CPU ms | renderer-IPC events | IPC JSON bytes |')
        p('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
        for w in r['windows']:
            c = w['cpu']; g = lambda k, kind: c.get(k, {}).get(kind, 0)
            q = w['requests']
            p(f"| {w['name']} | {w['seconds']} | {q['model']} | {q['count_tokens']} | {q['other']} | {w['execTotal']} | {w['hookScriptExecs']} | {w.get('mainProcessCpuMs')} | {g('cli','ownCpuMs')} | {g('cli','waitedKidsCpuMs')} | {g('keeper','ownCpuMs')} | {g('mcp','ownCpuMs')} | {w.get('runnerKidsCpuMs')} | {w['rendererIpc']['events']} | {w['rendererIpc']['jsonBytes']} |")
        p('')
        for w in r['windows']:
            if w['dns'] or w['connectInet']: p(f"- {w['name']}: DNS {w['dns']} · inet {w['connectInet']}")
        p(f"- final RSS (kB, VmRSS) by class: `{r.get('finalRssKB')}`; controls: `{json.dumps(r.get('controls'))}`")
        p('')

def hook_table():
    r = load('hook-cost.json')
    if not r: return
    p(f"### hook-cost.json — runs={r['runs']} peers={r['peers']} orchestra CLI on PATH={r['orchestraCliOnPath']} load@start={r['loadavg']}")
    p('')
    p('| event | hook commands | processes/event | wall ms/event | CPU ms/event |')
    p('|---|---|---|---|---|')
    for ev, e in r['events'].items():
        p(f"| {ev} | {e['hooksFiredPerEvent']} | {e['execsPerEvent']} | {e['wallMsPerEvent']} | {e['cpuMsPerEvent']} |")
    p('')

def text_blocks():
    for name in ['cli-cost-help.txt', 'cli-cost-whoami.txt', 'npx-mcp-cost.txt', 'git-poll-cost-metarepo.txt', 'git-poll-cost-orchestra.txt', 'field-census.txt', 'field-live-children-90s.txt']:
        f = os.path.join(EV, name)
        if os.path.exists(f):
            p(f"### `{name}`"); p(''); p('```'); p(open(f).read().rstrip()); p('```'); p('')
    r = load('loop-scan-cost.json')
    if r:
        p(f"### loop-scan-cost.json — ws={r['ws']} runs={r['runs']} load={r['loadavg']}"); p('')
        p('| transcript MB | bytes read/sweep | wall ms | CPU ms | unchanged-fleet control (wall/CPU ms) |'); p('|---|---|---|---|---|')
        for c in r['cases']:
            p(f"| {c['transcriptMB']} | {c['bytesReadPerSweep']:,} | {c['wallMsMedian']} | {c['cpuMsMedian']} | {c['unchangedFleetControl']['wallMs']}/{c['unchangedFleetControl']['cpuMs']} |")
        p('')

app_tables(); scn_tables(); hook_table(); text_blocks()
print('\n'.join(out))
