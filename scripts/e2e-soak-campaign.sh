#!/usr/bin/env bash
# Load/soak campaign self-test (C5 #212): the real campaign with seeded leak / wedge / abort arms. ~13 min; run when the machine is calm (D7).
# Exit 0 = every arm as expected · 1 = an arm broke expectation · 3 = VOID (machine too busy to measure — re-run later).
set -u
cd "$(dirname "$0")/.."
exec node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/session-budget/soak-selftest.mjs "$@"
