Real `node --test --test-reporter=tap` stdout (Node v22.22.0), one file per scenario; scratch path rewritten to `/scratch`.
The sources of these scenarios live in `scripts/e2e-fanout-freeze-check.mjs` (its fake repo runs the same shapes through the built CLI).
Exit codes at capture: pass/empty/skip 0; every other 1 (hangforever: killed by the wall-clock timeout, so no summary).

`*.jest.json` = `jest --json --outputFile=…` (jest 30.5.2, plain JS tests, one per scenario; timings zeroed, scratch path rewritten to `/scratch`).
Exit codes at capture: pass/skiptodo 0; every other 1. `exitcrash` (a test calls process.exit(3)) writes NO json file — jest dies with exit 3.

`*.n20.tap.txt` = Node v20.19.5, `*.n18.tap.txt` = Node v18.20.8 (same scenario sources). Node 18/20 label only SUITES with `type:`; a leaf test has a diagnostic block and no `type` (Node ≥ 22 labels both).

`*.jest29.json` = jest 29.7.0 captures of the expect-library cases (`rejects`, `assertions`, `beforeeachexpect`, `custom`, `viaframe`); the same five exist as `*.jest.json` for jest 30.5.2.
