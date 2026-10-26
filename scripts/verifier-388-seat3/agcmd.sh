#!/usr/bin/env bash
# union of the #397-related unit tests + tab-policy/panel-tabs + stub harness; non-zero if any is red
cd "$(git rev-parse --show-toplevel)" || exit 90
rc=0
node --test --experimental-strip-types src/shared/browser-agent-tabs.test.ts src/shared/cdp-proxy-core-agent-tabs.test.ts src/shared/cdp-proxy-core.test.ts src/main/browser-panel-agent-tabs.test.ts src/main/browser-agent-tabs-wiring.test.ts src/main/browser-panel-tabs.test.ts src/shared/browser-cli.test.ts src/main/browser-cli-wiring.test.ts src/main/browser-cdp-proxy.test.ts src/shared/browser-tab-policy.test.ts > "${TMPDIR}/agcmd.out" 2>&1 || rc=1
grep -E '^not ok' "${TMPDIR}/agcmd.out" | cut -c1-200
exit $rc
