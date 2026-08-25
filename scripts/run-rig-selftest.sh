#!/usr/bin/env bash
# Runnable target for scripts/e2e-contained-rig-selftest.sh (issue #76).
#
# WHY A WRAPPER, AND WHY NOT `pnpm run test`.
# The rig self-test needs a live compositor, so it cannot join the node --test
# suite that must stay runnable on a headless CI box. The naive alternatives are
# both worse than no target at all:
#   - putting it in `pnpm run test` → it FAILS on any box without sway;
#   - making it self-skip there    → it reports a comfortable GREEN while the
#     gate is absent. Wave-6 shipped exactly that (12 self-skipping CLI tests
#     inside a "1039 pass" suite). A test that skips itself is an ABSENT FAILURE
#     wearing a pass.
#
# So: a SEPARATE, FAIL-CLOSED target. The criterion it is built against is that
# a run which did NOT exercise the self-test must be DISTINGUISHABLE from one
# that did. That is enforced positively, not by absence of errors:
#
#   The child emits exactly one `RIG-SELFTEST: <outcome>` line. This wrapper
#   REQUIRES that line to exist and to read PASSED. If the child dies early, is
#   killed, or is replaced by something that prints nothing, there is no line
#   and the wrapper FAILS. Silence is never scored as success — which is the
#   one property a self-skip destroys.
#
# Exit codes:  0 = self-test genuinely ran and passed
#              1 = it ran and an arm failed  (or the terminator was missing)
#              2 = precondition unmet (no compositor) — NAMED, never a skip
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELFTEST="${HERE}/e2e-contained-rig-selftest.sh"
[[ -x "${SELFTEST}" ]] || { echo "FATAL: ${SELFTEST} not executable" >&2; exit 1; }

out="$("${SELFTEST}" 2>&1)"; rc=$?
printf '%s\n' "${out}"

# The positive terminator. A missing line is a FAILURE, never a pass: this is
# what makes "did not actually run" distinguishable from "ran and passed".
line="$(grep -E '^RIG-SELFTEST: ' <<<"${out}" | tail -1)"
if [[ -z "${line}" ]]; then
  echo >&2
  echo "✘ rig self-test produced NO 'RIG-SELFTEST:' outcome line (child rc=${rc})." >&2
  echo "  It did not run to a verdict — refusing to report success. (issue #76)" >&2
  exit 1
fi

echo
case "${line}" in
  'RIG-SELFTEST: PASSED'*)
    [[ "${rc}" == 0 ]] || { echo "✘ terminator says PASSED but rc=${rc}" >&2; exit 1; }
    echo "✔ rig self-test EXERCISED and PASSED — ${line#RIG-SELFTEST: }"
    exit 0 ;;
  'RIG-SELFTEST: PRECONDITION-UNMET'*)
    echo "⚠ rig self-test NOT EXERCISED — ${line#RIG-SELFTEST: }" >&2
    echo "  This is a NAMED precondition failure (rc=2), NOT a skip and NOT a pass." >&2
    exit 2 ;;
  *)
    echo "✘ rig self-test FAILED — ${line#RIG-SELFTEST: }" >&2
    exit 1 ;;
esac
