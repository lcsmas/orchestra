#!/bin/bash
cd /home/lmas/.orchestra/worktrees/reviewer-a17-cand
M=/home/lmas/.orchestra/tmp/a17-mut
run_one() {
  n="$1"
  RG_SCRIPTS_DIR=$M/$n bash scripts/verify-release-gate.sh > $M/$n.rig.log 2>&1; echo "rig_rc=$?" >> $M/$n.rig.log
  case "$n" in
    gate_after_master) RG_SCRIPTS_DIR=$M/$n bash scripts/a17-probe.sh tomaster > $M/$n.probe.log 2>&1 ;;
    ci_skip_gate|abi_under_ci) RG_SCRIPTS_DIR=$M/$n bash scripts/a17-probe.sh cionly > $M/$n.probe.log 2>&1 ;;
  esac
  echo done > $M/$n.done
}
for n in fail_key tests_key pass_key ci_skip_gate abi_noexit abi_under_ci gate_after_master; do run_one $n & done
wait
echo ALLDONE > $M/ALLDONE
