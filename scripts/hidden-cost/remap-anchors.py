#!/usr/bin/env python3
"""Line numbers drift when the tree moves (a rebase). This re-finds every row of evidence/anchors.tsv by (path, token) — the nearest
line that still contains the token — rewrites anchors.tsv, and rewrites every matching `path:oldline` citation in the report.
A row whose token is gone is reported and left unchanged (check-anchors.py then fails on it: a human decides).
   python3 scripts/hidden-cost/remap-anchors.py            # dry run prints the moves
   python3 scripts/hidden-cost/remap-anchors.py --write"""
import re, sys
EV = 'docs/research/hidden-cost-inventory/evidence/anchors.tsv'
REPORT = 'docs/research/hidden-cost-inventory.md'
rows = [l.rstrip('\n').split('\t') for l in open(EV) if l.strip()]
report = open(REPORT).read()
moves, lost, out = {}, [], []
for id_, loc, tok in rows:
    path, line = loc.rsplit(':', 1); line = int(line)
    try: lines = open(path).read().split('\n')
    except Exception: lost.append((id_, loc, 'file missing')); out.append((id_, loc, tok)); continue
    if line <= len(lines) and tok in lines[line - 1]:
        out.append((id_, loc, tok)); continue
    cands = [i + 1 for i, l in enumerate(lines) if tok in l]
    if not cands: lost.append((id_, loc, f'token {tok!r} gone')); out.append((id_, loc, tok)); continue
    new = min(cands, key=lambda c: abs(c - line))
    moves[loc] = f'{path}:{new}'; out.append((id_, f'{path}:{new}', tok))
print(f'{len(moves)} anchors moved, {len(lost)} lost')
for o, n in list(moves.items())[:12]: print(f'  {o} -> {n}')
for l in lost: print('  LOST', l)
if '--write' in sys.argv:
    # the same token can be found on a different occurrence: dedupe rows by location, keep first
    seen, res = set(), []
    for r in out:
        if r[1] in seen: continue
        seen.add(r[1]); res.append(r)
    open(EV, 'w').write('\n'.join('\t'.join(r) for r in res) + '\n')
    for o, n in moves.items(): report = report.replace(f'`{o}`', f'`{n}`')
    open(REPORT, 'w').write(report)
    print('written')
