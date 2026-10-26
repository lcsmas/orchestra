#!/usr/bin/env bash
# union of the #396 unit tests + tab policy + stub harness; non-zero if any is red
cd "$(git rev-parse --show-toplevel)" || exit 90
rc=0
node --test --experimental-strip-types src/shared/browser-popup-window.test.ts src/main/browser-popups.test.ts src/main/browser-panel-popups.test.ts src/main/browser-popups-wiring.test.ts src/shared/browser-tab-policy.test.ts src/main/browser-panel-tabs.test.ts > "${TMPDIR}/popunit.out" 2>&1 || rc=1
grep -E '^not ok' "${TMPDIR}/popunit.out" | cut -c1-200
node --experimental-strip-types scripts/verify-browser-tabs-panel.mjs > /dev/null 2>&1 || rc=1
exit $rc
