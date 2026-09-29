#!/usr/bin/env bash
# #198 D20 (T11): runs every arm of e2e-hook-cost.mjs, one process each; a missing
# line is a failed arm. BASE_REPO=<tree> adds the byte-identity arm (vs that tree's
# hook); REAL_CLI=1 adds the real `claude` arms (haiku, network + auth, ~3 min).
# SUBJECT_REPO=<tree> drives another tree (G1: on master every arm but
# transcript_control must print ok:false).
set -u
cd "$(dirname "$0")/.."
ARMS="edit_real_size failed_write_real_size websearch_nested_id reinstall_during_hook install_failure_no_tmp scaling transcript_control"
[ -n "${BASE_REPO:-}" ] && ARMS="$ARMS identity"
[ "${REAL_CLI:-0}" = 1 ] && ARMS="$ARMS real_cli_edit real_cli_websearch"
RC=0
for arm in $ARMS; do
  line=$(timeout 600 node --experimental-strip-types --import ./scripts/.r2-register.mjs \
           scripts/e2e-hook-cost.mjs "$arm" 2>/dev/null | tail -1)
  [ -n "$line" ] || line="{\"arm\":\"$arm\",\"ok\":false,\"error\":\"no output\"}"
  echo "$line"
  case "$line" in *'"ok":true'*) : ;; *) RC=1 ;; esac
done
exit $RC
