#!/usr/bin/env bash
# union of the popup-related checks; non-zero if ANY is red
cd "$(git rev-parse --show-toplevel)" || exit 90
rc=0
node --test --experimental-strip-types src/shared/browser-tab-policy.test.ts src/main/browser-popups.test.ts src/main/browser-panel-popups.test.ts src/main/browser-popups-wiring.test.ts > "${TMPDIR}/popcmd.out" 2>&1 || rc=1
grep -E '^not ok' "${TMPDIR}/popcmd.out" | cut -c1-200
node --experimental-strip-types scripts/verify-browser-tabs-panel.mjs 2>&1 | grep -E '^FAIL' | cut -c1-200
node --experimental-strip-types scripts/verify-browser-tabs-panel.mjs > /dev/null 2>&1 || rc=1
exit $rc
