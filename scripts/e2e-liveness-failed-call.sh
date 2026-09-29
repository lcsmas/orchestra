#!/usr/bin/env bash
# #199 residual (T6b): runs every arm of e2e-liveness-failed-call.mjs, one process
# each; a missing line is a failed arm. REAL_CLI=1 adds the two arms that drive the
# real `claude` CLI (haiku, network + auth). SUBJECT_REPO=<tree> drives another
# tree's src/ (G1: on master the arms marked mustFailOnMaster must print ok:false).
set -u
cd "$(dirname "$0")/.."
ARMS="failed_call failed_call_long_sibling denied_call mismined_websearch genuine_hang parallel_batch_pending subagent_batch_keeps_parent empty_batch_no_fifo queued_submit_keeps_live coalesced_next_turn healthy upgrade_reinstall"
[ "${REAL_CLI:-0}" = 1 ] && ARMS="$ARMS real_cli_failed_call real_cli_denied_call"
RC=0
for arm in $ARMS; do
  line=$(timeout 240 node --experimental-strip-types --import ./scripts/.r2-register.mjs \
           scripts/e2e-liveness-failed-call.mjs "$arm" 2>/dev/null | tail -1)
  [ -n "$line" ] || line="{\"arm\":\"$arm\",\"ok\":false,\"error\":\"no output\"}"
  echo "$line"
  case "$line" in *'"ok":true'*) : ;; *) RC=1 ;; esac
done
exit $RC
