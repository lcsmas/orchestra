#!/usr/bin/env python3
"""Gate for docs/research/hidden-cost-inventory.md: (1) every row of evidence/anchors.tsv still finds its token on its line;
(2) every `path/to/file.ext:NNN` citation in the report equals a row of anchors.tsv (nothing is cited unverified).
   python3 scripts/hidden-cost/check-anchors.py   → exit 0 = ok, 1 = drift / unverified citation"""
import re, sys, os
EV = 'docs/research/hidden-cost-inventory/evidence/anchors.tsv'
REPORT = 'docs/research/hidden-cost-inventory.md'
rows = [l.rstrip('\n').split('\t') for l in open(EV) if l.strip()]
bad = 0
anchors = set()
for id_, loc, tok in rows:
    path, line = loc.rsplit(':', 1)
    anchors.add(loc)
    try: text = open(path).read().split('\n')[int(line) - 1]
    except Exception as e: print(f'DRIFT {id_} {loc}: {e}'); bad += 1; continue
    if tok not in text: print(f'DRIFT {id_} {loc}: token {tok!r} not on that line: {text.strip()[:80]!r}'); bad += 1
cited = set(re.findall(r'`((?:src|scripts)/[\w./-]+\.\w+:\d+)`', open(REPORT).read()))
for c in sorted(cited - anchors): print(f'UNVERIFIED citation (not in anchors.tsv): {c}'); bad += 1
print(f'anchors={len(rows)} cited={len(cited)} bad={bad}')
sys.exit(1 if bad else 0)
