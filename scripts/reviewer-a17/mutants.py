# Reviewer-a17 in-copy mutants of scripts/release.sh + release-gate.sh (candidate 16749f03).
# Each mutant = a dir with the three scripts; run the candidate's own rig with RG_SCRIPTS_DIR=<dir>.
import os, shutil
SRC='<candidate>/scripts'; M='<out>'
def mk(name, fname, old, new):
    d=f'{M}/{name}'; os.makedirs(d)
    for f in ('release.sh','release-preflight.sh','release-gate.sh'): shutil.copy(f'{SRC}/{f}', f'{d}/{f}')
    p=f'{d}/{fname}'; s=open(p).read(); assert s.count(old)==1, name
    open(p,'w').write(s.replace(old,new))
mk('fail_key','release-gate.sh','|| !seen["fail"] ||','||')            # survives 55/55
mk('tests_key','release-gate.sh','!seen["tests"] || ','')             # survives 55/55
mk('pass_key','release-gate.sh','|| !seen["pass"] ','')               # survives 55/55
mk('ci_skip_gate','release.sh','  rg_run_gate || exit 1','  [ "$CI_ONLY" = 1 ] || rg_run_gate || exit 1')   # survives 55/55; probe P2 ships red
mk('abi_noexit','release.sh','rg_prepare_native || exit 1','rg_prepare_native || true')                      # KILLED by abi_fail (2 FAIL)
# gate_after_master: swap the "release gate (#207)" block with "advance master (pre-bump)" — survives 55/55; probe P1 moves origin/master on red
