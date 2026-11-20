#!/usr/bin/env python3
# #478 — pick the coordinator's handoff bound N from a real OPS transcript (rehearsal rts-vf2-local-1). Read-only.
#   python3 -I docs/evidence/478-measure-handoff-bound.py <session.jsonl>   > docs/evidence/478-handoff-bound.txt
# 1) per turn (turnPosition.turnIndex): API requests, cache_read, context at its last request (cache_read+cache_creation+input).
# 2) replay the SAME per-turn sequence (requests/turn, context growth/turn) with a handoff every N turns: the context resets to a fresh base b0,
#    the handoff turn costs 4 extra requests at the current context + 3k written, the fresh base is re-created (x1.25). Weighted cost: write 1.25x, read 0.1x.
import json, sys, collections
f = sys.argv[1]
turn, seen, rows = 0, set(), collections.OrderedDict()
for l in open(f):
    o = json.loads(l)
    tp = o.get('turnPosition')
    if o['type'] == 'user' and tp and tp.get('promptIndex') == 0:
        turn = tp['turnIndex']
    if o['type'] == 'assistant':
        m = o['message']; mid = m.get('id'); u = m.get('usage') or {}
        if mid in seen: continue
        seen.add(mid)
        r = rows.setdefault(turn, dict(calls=0, cr=0, ctx=0))
        r['calls'] += 1; r['cr'] += u.get('cache_read_input_tokens', 0)
        r['ctx'] = u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0) + u.get('input_tokens', 0)
tot = sum(r['cr'] for r in rows.values())
print(f"{len(rows)} turns, {sum(r['calls'] for r in rows.values())} API requests, total cache_read {tot/1e6:.1f} M tokens")
ts = sorted(rows); ctx = [rows[t]['ctx'] for t in ts]
calls = [rows[t]['calls'] for t in ts][2:]            # turns 1-2 = boot + the brief read (41 requests): not a steady-state turn
g = [max(0, ctx[i] - ctx[i - 1]) for i in range(2, len(ctx))]
print(f"steady state: {sum(calls)/len(calls):.2f} requests/turn, context +{sum(g)/len(g):.0f} tok/turn (first 60 turns +{sum(g[:60])/60:.0f}, last 60 +{sum(g[-60:])/60:.0f})")
print(f"context after the brief (turn 2): {ctx[1]/1e3:.0f}k; at turn 100: {ctx[99]/1e3:.0f}k; at the end (turn {ts[-1]}): {ctx[-1]/1e3:.0f}k")
cum = 0
print('turn  requests  cache_read(M)  cum%  context(k)')
for t in ts:
    cum += rows[t]['cr']
    if t % 30 == 0 or t == ts[-1]: print(f"{t:4d}  {rows[t]['calls']:8d}  {rows[t]['cr']/1e6:13.2f}  {100*cum/tot:3.0f}%  {rows[t]['ctx']/1e3:9.0f}")
def sim(N, b0):
    c, cost, since = 159e3, 0.0, 0   # every arm starts from the real post-brief context; only a handoff resets it to b0
    for k, gr in zip(calls, g):
        cost += k * c * 0.1 + 1.25 * gr; c += gr; since += 1
        if N and since >= N:
            cost += 4 * c * 0.1 + 1.25 * 3000 + 1.25 * b0; c = b0; since = 0
    return cost / 1e6
base = sim(0, 159e3)
print(f"\nweighted cost over the {len(calls)} steady turns, no handoff: {base:.1f} M base-input-token equivalents")
print('handoff every N turns: weighted cost vs no handoff, by fresh-context base b0 (summary + state/ledger re-read)')
print('   N   ' + '  '.join(f'b0={int(b/1e3)}k' for b in (60e3, 100e3, 160e3)))
for N in (8, 12, 16, 20, 24, 30, 40, 60, 80, 120):
    print(f'{N:4d}   ' + '  '.join(f'{100*(sim(N,b)/base-1):+6.0f}%' for b in (60e3, 100e3, 160e3)))
for b in (60e3, 100e3, 160e3):
    best = min(range(4, 121), key=lambda n: sim(n, b))
    print(f'b0={int(b/1e3)}k: minimum at N={best} ({100*(sim(best,b)/base-1):+.1f}%); N=30 is {100*(sim(30,b)-sim(best,b))/base:+.1f} points from it, N=40 {100*(sim(40,b)-sim(best,b))/base:+.1f}')
print('NOT MODELLED: the 5-min / 1-h prompt-cache TTL (an idle gap re-writes the whole context at 1.25x: favours a LOWER N), the quality cost of a handoff (favours a HIGHER N), a coordinator whose turns are heavier than this one.')
