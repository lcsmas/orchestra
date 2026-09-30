#!/usr/bin/env python3
"""Every EXTRAPOLATED number in docs/research/hidden-cost-inventory.md, computed from the MEASURED evidence + the printed FIELD parameters.
   python3 scripts/hidden-cost/derive.py > docs/research/hidden-cost-inventory/evidence/derived.txt
Formula for each line is printed beside it. FIELD parameters come from the live store/census (see evidence/field-*.txt) and are
constants below so a reader can substitute their own fleet."""
import json, os, re, sys
EV = 'docs/research/hidden-cost-inventory/evidence'
def load(n):
    f = os.path.join(EV, n)
    return json.load(open(f)) if os.path.exists(f) else None
def win(r, name):
    return next((w for w in r['windows'] if w['name'] == name), None) if r else None
def pct(w, cls, kind='ownCpuS'):
    return 100 * w['cpu'][cls][kind] / w['seconds'] if w and cls in w['cpu'] else None
def per_min(r, name):
    w = win(r, name); e = r['events'][name]
    return e['execTotal'] / (w['seconds'] / 60)
def keyed(r, name, prefix):
    w = win(r, name); e = r['events'][name]
    return sum(v['perMin'] for k, v in e['execByKey'].items() if k.startswith(prefix))

# FIELD parameters (live store.json + census, 2026-09-30; see evidence/field-notes.txt)
W_ACTIVE, W_GIT, REPOS, RUNNING_ROWS, CLIS = 33, 28, 4, 17, 18   # store.json 33 active / 28 git worktrees / 4 repos (evidence/field-notes.txt); 18 claude CLIs (field-census.txt); running rows ≈ CLIs − 1 (an idle one)
out = []
def line(label, value, formula):
    out.append(f"{label:58s} {value:>12}   = {formula}")
P = lambda x, d=1: f"{x:.{d}f}"

i8, w24, vis, hid, foc, ses = load('app-idle8.json'), load('app-ws24.json'), load('app-run8.json'), load('app-hid8.json'), load('app-focus8.json'), load('app-sess4.json')
out.append(f"FIELD parameters: active workspaces={W_ACTIVE} git-backed={W_GIT} repos={REPOS} running rows≈{RUNNING_ROWS} claude CLIs={CLIS}")
if i8 and w24:
    a = per_min(i8, 'steady-visible') / 8; b = per_min(w24, 'steady-visible') / 24
    line('poll spawns/min per git workspace (N=8)', P(a), 'idle8 steady-visible execs/min ÷ 8')
    line('poll spawns/min per git workspace (N=24)', P(b), 'ws24 steady-visible execs/min ÷ 24')
    per_ws = (a + b) / 2
    line('poll spawns/min at field scale', P(per_ws * W_GIT, 0), f'mean({P(a)},{P(b)}) × {W_GIT} git worktrees')
    line('poll spawns/s at field scale', P(per_ws * W_GIT / 60), 'above ÷ 60')
    for nm, r, n in (('N=8', i8, 8), ('N=24', w24, 24)):
        w = win(r, 'steady-visible'); tot = (pct(w, 'electron-main') or 0) + (pct(w, 'electron-main', 'waitedKidsCpuS') or 0)
        line(f'main+children CPU per poll spawn ({nm}), ms', P(tot / 100 * 60000 / per_min(r, 'steady-visible'), 2), '(main own% + waited-children%)/100 × 60000 ms ÷ spawns/min')
    w = win(w24, 'steady-visible'); tot = (pct(w, 'electron-main') or 0) + (pct(w, 'electron-main', 'waitedKidsCpuS') or 0)
    ms = tot / 100 * 60000 / per_min(w24, 'steady-visible')
    line('field polling CPU (main+children), % of one core', P(per_ws * W_GIT * ms / 60000 * 100, 1), 'field spawns/min × ms/spawn(N=24) ÷ 60000 × 100')
    line('spawns/min/ws that are NOT git (gh releases/pulls/actions)', P(keyed(i8, 'steady-visible', 'gh ') / 8, 2), 'idle8 steady gh execs/min ÷ 8')
    sw = win(i8, 'steady-visible')
    rel = [int(l.split(' ', 1)[0]) for l in open(os.path.join(EV, 'app-idle8.gh-calls.log')) if 'releases' in l]
    n_rel = sum(1 for t in rel if sw['t0'] <= t < sw['t1'])
    line('gh `releases` calls in the steady window (8 ws, 1 repo)', f"{n_rel}/{sw['seconds']:.0f}s", 'gh-calls.log lines matching `releases` with t0<=ts<t1 (ideal with a working per-repo cache: 1 per 30 s)')
    line('gh `releases` calls vs ideal (1 per 30 s per repo)', P(n_rel / (sw['seconds'] / 30), 1) + '×', 'calls ÷ (seconds ÷ RELEASE_CACHE_TTL 30 s)')
if i8:
    w = win(i8, 'steady-visible')
    line('idle app baseline: renderer / GPU / main-own, % of a core (N=8)', f"{P(pct(w,'electron-renderer'),2)}/{P(pct(w,'electron-gpu-process'),2)}/{P(pct(w,'electron-main'),2)}", 'idle8 steady-visible')
    line('usage-API attempts/min (1 account, failing net)', P(w['seconds'] and (i8['events']['steady-visible']['dns'].get('api.anthropic.com', {}).get('count', 0) / (w['seconds'] / 60)), 1), 'DNS lookups of api.anthropic.com in steady-visible ÷ minutes')
if vis:
    b, r_ = win(vis, 'steady-visible'), win(vis, 'steady-running')
    if b and r_ and not str(r_['visibilityStart']).startswith('eval-failed'):
        rows = 8
        for cls in ('electron-gpu-process', 'electron-renderer', 'electron-main'):
            d = pct(r_, cls) - pct(b, cls)
            line(f'running rows: extra {cls} % of a core per running row', P(d / rows, 2), f'(steady-running − steady-visible) ÷ {rows} rows')
        tot = sum(pct(r_, c) - pct(b, c) for c in ('electron-gpu-process', 'electron-renderer', 'electron-main'))
        line('running rows: total extra % of a core per running row', P(tot / rows, 2), 'sum of the three ÷ 8')
        line('running rows at field scale, % of a core', P(tot / rows * RUNNING_ROWS, 0), f'per-row × {RUNNING_ROWS} running rows')
        line('CSS animations idle → 8 running rows', f"{b.get('runningCssAnimations')}→{r_.get('runningCssAnimations')}", 'document.getAnimations().length')
if hid:
    b2, h = win(hid, 'steady-visible'), win(hid, 'steady-hidden')
    if h and b2:
        line('hidden window: spawns/min (sway visible=false)', P(per_min(hid, 'steady-hidden'), 0), 'hid8 steady-hidden')
        line('visible window: spawns/min (same run)', P(per_min(hid, 'steady-visible'), 0), 'hid8 steady-visible')
        line('hidden ÷ visible spawn rate', P(per_min(hid, 'steady-hidden') / per_min(hid, 'steady-visible'), 2), 'hid8')
        line('hidden window: document.visibilityState start→end', f"{h['visibilityStart']}→{h['visibilityEnd']}", 'read over CDP; sway get_tree visible=false proven (hideProof)')
        line('hidden window: renderer / GPU % of a core', f"{P(pct(h,'electron-renderer'),2)}/{P(pct(h,'electron-gpu-process'),2)}", 'hid8 steady-hidden')
        line('visible window: renderer / GPU % of a core', f"{P(pct(b2,'electron-renderer'),2)}/{P(pct(b2,'electron-gpu-process'),2)}", 'hid8 steady-visible')
        line('hidden window: main own+children % of a core', f"{P(pct(h,'electron-main'),2)}+{P(pct(h,'electron-main','waitedKidsCpuS'),2)}", 'hid8 steady-hidden')
if foc:
    w = win(foc, 'focus-cycles')
    if w:
        e = foc['events']['focus-cycles']['execByKey']
        f = e.get('git fetch', {}).get('count', 0); u = e.get('sh -c git-upload-pack', {}).get('count', 0)
        cyc = foc.get('focusCycles', {}).get('cycles', 0)
        line('focus cycles', str(cyc), 'alt-tabs driven through sway')
        line('git fetch spawns during focus window', str(f), f'`git fetch` count in focus-cycles')
        line('git fetch per focus event per repo', P(f / cyc, 2) if cyc else 'n/a', 'fetch count ÷ cycles (1 repo in the rig)')
        line('network handshakes (git-upload-pack) per focus per repo', P(u / cyc, 2) if cyc else 'n/a', 'git-upload-pack count ÷ cycles')
        line('field: fetches per focus (4 repos)', P(f / cyc * REPOS, 1) if cyc else 'n/a', f'per repo × {REPOS}')
print('\n'.join(out))

# ---- per-delta streaming cost (fg1 / bg1): (streaming-window % − same-run steady-visible %) × window seconds ÷ deltas ----
extra = []
for lab in ('fg1', 'bg1'):
    r = load(f'app-{lab}.json')
    if not r: continue
    base, st = win(r, 'steady-visible'), win(r, 'sessions-streaming')
    deltas = 1200
    for cls in ('electron-renderer', 'electron-gpu-process', 'electron-main'):
        d = (pct(st, cls) - pct(base, cls)) / 100 * st['seconds'] * 1000 / deltas
        extra.append(f"{'streaming '+lab+': extra '+cls+' ms per delta':58s} {d:12.2f}   = ({pct(st,cls):.2f}% − {pct(base,cls):.2f}%) × {st['seconds']:.1f} s ÷ {deltas} deltas")
print('\n'.join(extra))
