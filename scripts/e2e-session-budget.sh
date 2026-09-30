#!/usr/bin/env bash
# Session-budget suite (#208): the REAL session path + real `claude` CLI against a LOCAL FAKE Anthropic API
# (zero tokens). Arms: normal (must PASS) + boot-context-read (must FAIL). Rebuilds the keeper bundle first.
# Exit 0 = every arm as expected · 1 = an arm broke expectation · 3 = VOID (subject never mounted).
set -u
cd "$(dirname "$0")/.."
exec node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/session-budget/run.mjs "$@"
