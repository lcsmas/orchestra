#!/usr/bin/env bash
# Accès mobile 413 rig (#408) — CPU load + ABBA-interleaved arms + aggregate + verdict. Loopback only: no Electron, no live state, no host package.
# Usage: scripts/acces-mobile-413-rig.sh [--runs 500] [--batch 50] [--load 8] [--topology same|split|both] [--arms unfixed,fixed]
#                                         [--unfixed-rev <rev>] [--fixed-src <dir>] [--client both] [--out <jsonl>]
#        scripts/acces-mobile-413-rig.sh --aggregate <jsonl> [--runs 500]     (re-derive the verdict of a committed run; no server is started)
# `fixed` = this tree (or --fixed-src, e.g. a mutant copy); `unfixed` = `git archive <rev>` (default: 98fe09ff, the integration tip BEFORE the #408 fix — a fixed sha, it never moves). Verdict:
#   fixed arm: every run of every flavor read the 413 (>= --runs per flavor) · unfixed arm: at least one flavor reads -1 (the instrument CAN say FAIL).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
RUNS=500 BATCH=50 LOAD=8 TOPO=both ARMS=unfixed,fixed REV=98fe09ff6a8f97f1191e0c6bfd853ff1407b5281 FIXED_SRC="${ROOT}" CLIENT=both OUT="" AGG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs) RUNS="$2"; shift 2;; --batch) BATCH="$2"; shift 2;; --load) LOAD="$2"; shift 2;; --topology) TOPO="$2"; shift 2;;
    --arms) ARMS="$2"; shift 2;; --unfixed-rev) REV="$2"; shift 2;; --fixed-src) FIXED_SRC="$(cd "$2" && pwd)"; shift 2;;
    --client) CLIENT="$2"; shift 2;; --out) OUT="$2"; shift 2;; --aggregate) AGG="$2"; shift 2;; *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
aggregate() {  # $1 jsonl  $2 min runs per flavor  $3 arms (comma list, or 'auto' = the arms present in the file)
python3 -I - "$1" "$2" "$3" <<'EOF'
import json, sys, collections
out, runs, arms = sys.argv[1], int(sys.argv[2]), sys.argv[3].split(',')
agg = collections.OrderedDict()
if arms == ['auto']: arms = sorted({json.loads(l)['arm'] for l in open(out) if l.strip()})
for line in open(out):
    r = json.loads(line)
    if 'skipped' in r: continue
    k = (r['arm'], r['topology'], r['client'])
    a = agg.setdefault(k, collections.Counter())
    for f in ('runs', 'read413', 'minus1', 'other', 'held', 'early', 'unbounded'): a[f] += r.get(f, 0)
    a['rev:' + str(r.get('rev', '?'))] = 1
    for c, n in (r.get('errCodes') or {}).items(): a['err:' + c] += n
print(f"{'arm':8} {'topology':8} {'client':12} {'runs':>6} {'read413':>8} {'-1':>6} {'other':>6} {'held':>5} {'early':>5} {'unb':>4}  errors")
for (arm, topo, cl), a in agg.items():
    errs = ','.join(f"{k[4:]}={v}" for k, v in a.items() if k.startswith('err:'))
    print(f"{arm:8} {topo:8} {cl:12} {a['runs']:6} {a['read413']:8} {a['minus1']:6} {a['other']:6} {a['held']:5} {a['early']:5} {a['unbounded']:4}  {errs}")
bad = False
if 'fixed' in arms:
    fx = [(k, a) for k, a in agg.items() if k[0] == 'fixed']
    ok = bool(fx) and all(a['read413'] == a['runs'] and a['runs'] >= runs and not a['held'] and not a['unbounded'] for k, a in fx if k[2] != 'hostile') and all(not a['held'] and not a['early'] and not a['unbounded'] and a['read413'] == a['runs'] for k, a in fx if k[2] == 'hostile')
    print('FIXED   :', 'CLEAN — every run of every flavor read the 413' if ok else 'DIRTY'); bad |= not ok
if 'unfixed' in arms:
    ux = [(k, a) for k, a in agg.items() if k[0] == 'unfixed']
    red = any(a['minus1'] > 0 for k, a in ux)
    print('UNFIXED :', 'RED as required — the instrument reads -1 (must-FAIL arm)' if red else 'NOT REPRODUCED — UNVERIFIED (the instrument cannot say FAIL)'); bad |= not red
revs = sorted({k[4:] for a in agg.values() for k in a if k.startswith('rev:')})
print('code under test:', ', '.join(revs))
print('RIG VERDICT:', 'DIRTY' if bad else 'CLEAN')
sys.exit(1 if bad else 0)
EOF
}
[[ -n "${AGG}" ]] && { aggregate "${AGG}" "${RUNS}" auto; exit $?; }
SCRATCH="$(mktemp -d "${TMPDIR:-/var/tmp}/acces-mobile-413-rig.XXXXXX")"
OUT="${OUT:-${SCRATCH}/results.jsonl}"; : > "${OUT}"
HOGS=()
cleanup() { for p in "${HOGS[@]:-}"; do [[ -n "${p}" ]] && kill "${p}" 2>/dev/null || true; done; rm -rf "${SCRATCH}"; }
trap cleanup EXIT
declare -A SRC SHA
if [[ ",${ARMS}," == *,unfixed,* ]]; then
  mkdir -p "${SCRATCH}/unfixed"
  git -C "${ROOT}" archive "${REV}" src | tar -x -C "${SCRATCH}/unfixed"
  ln -s "${ROOT}/node_modules" "${SCRATCH}/unfixed/node_modules"
  SRC[unfixed]="${SCRATCH}/unfixed"
  SHA[unfixed]="$(git -C "${ROOT}" rev-parse "${REV}")"
fi
SRC[fixed]="${FIXED_SRC}"
SHA[fixed]="$(git -C "${FIXED_SRC}" rev-parse HEAD 2>/dev/null || echo unknown)$(git -C "${FIXED_SRC}" diff --quiet HEAD -- src scripts 2>/dev/null || echo +dirty)"
[[ -f "${SRC[fixed]}/src/acces-mobile/server.ts" ]] || { echo "ABORT: no server.ts under ${SRC[fixed]}" >&2; exit 2; }
for ((i = 0; i < LOAD; i++)); do nice -n 10 node -e 'for(;;){}' & HOGS+=("$!"); done
echo "load: ${LOAD} busy loops (nice 10) · uptime: $(uptime | sed 's/.*load average/load average/')" >&2
IFS=, read -r -a ARMLIST <<< "${ARMS}"
IFS=, read -r -a TOPOS <<< "$([[ "${TOPO}" == both ]] && echo same,split || echo "${TOPO}")"
NB=$(( (RUNS + BATCH - 1) / BATCH ))
for ((b = 0; b < NB; b++)); do
  ORDER=("${ARMLIST[@]}"); (( b % 2 == 1 )) && ORDER=($(printf '%s\n' "${ARMLIST[@]}" | tac))   # alternate the order every batch
  for arm in "${ORDER[@]}"; do
    for topo in "${TOPOS[@]}"; do
      nice -n 10 node --experimental-strip-types --no-warnings "${HERE}/acces-mobile-413-rig.mjs" --src "${SRC[$arm]}" --runs "${BATCH}" --arm "${arm}" --rev "${SHA[$arm]}" --topology "${topo}" --client "${CLIENT}" >> "${OUT}" 2>/dev/null || true
    done
  done
done
echo "load after: $(uptime | sed 's/.*load average/load average/')" >&2
aggregate "${OUT}" "${RUNS}" "${ARMS}"
