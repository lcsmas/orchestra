# Session-identity rig (#379, ADR 0008)

Proves through the SHIPPED path that the host resolves a session's bus identity per CLI call: real `sdkSend` → real keeper → real
`claude` CLI against the local fake Anthropic API (zero tokens), the real hooks server on a real `$ORCHESTRA_SOCK`, a real `bus.sqlite`,
and the built `dist-electron/cli.js` as the `orchestra` the agent's Bash tool runs. Same containment as `scripts/session-budget/`
(bwrap net+pid namespaces, scratch HOME / ORCHESTRA_HOME / CLAUDE_CONFIG_DIR through `scratch-guard.mjs`; no bwrap → `VOID`, exit 3).
The session key is never printed or put in a fact (length / sha256 only).

```
pnpm run test:session-identity                        # the 5 arms (~12 s; rebuilds the CLI + keeper bundles first)
node scripts/session-identity/run.mjs --arm same_turn # one arm: same_turn | superseded | app_closed | attach_keeps_key | restart_window
node scripts/session-identity/run.mjs --proof         # + the must-FAIL mutants (load-time edits of src/, nothing on disk)
node scripts/session-identity/run.mjs --selftest      # every judge clause reddens under its mutation (no containers)
node scripts/session-identity/run.mjs --repo <tree>   # another tree: copy this dir into it first (the master must-FAIL run)
```

Output: `  PASS|FAIL <clause>` lines, `SESSION-IDENTITY <arm>: PASS|FAIL`, then hygiene (`~/.claude*`/`~/.orchestra*` listing unchanged, no trace
of the run's scratch root) and `SESSION-IDENTITY: PASS|FAIL`. Needs `build/bus-abi/better_sqlite3-abi127.node` (or node_modules at ABI 127).

| Arm | Proves |
|---|---|
| `same_turn` | A member (under a LEAD run) runs `orchestra promote` then `orchestra send` in ONE turn: the live CLI's env still carries the LEAD's run (stale, so the arm means something) and a session key; the send lands in the member's NEW run, rc 0, no restart (same keeper/CLI pid+start, same `sdkSessionId`); `session-keys.json` holds sha256 of that key (0600) and the key is in no file under the scratch root / tmp, no model request, no runner output. |
| `superseded` | After a fresh session start (`sdkRestart`), the OLD key is refused by the host and by a hand-run CLI (`send`/`check` rc 1, "superseded", no row), the NEW key is answered (control: wrong env run, the CLI still reads the host's), the registry holds the new hash only, the new session's own send lands. |
| `app_closed` | After `promote`, `stopHooksServer()` (the CLI keeps living): the next `send` is refused by the `bus-run-stale` marker (rc 1, "stale run", no row), `check` is allowed (rc 0); marker names the member's new run. |
| `restart_window` | (review MAJOR-1) The member is a COORDINATOR whose run has `fencing` ON and generation 1 (a session spawned now bakes 1): the real `sdkRestart(fresh)` bumps to 2 and starts no session; INSIDE that window the replaced key is not vouched for (`unregistered`, never the new generation), a hand-run `send` with the old env (key + generation 1) is rejected by the DB fence ("stale coordinator generation", no row), then the successor's send lands and the old key reads `superseded`. |
| `attach_keeps_key` | Two app processes over one ORCHESTRA_HOME: the first quits without stopping its keeper; the second `sdkAttachIfDetached`es the SAME keeper+CLI: the registry hash/issuedAt are untouched (the attach minted a key it did not register), K1 is still accepted (a random key is not), the reattached session's own send lands. |

`--proof` mutants (each must red EXACTLY its clauses, listed in `mutants.mjs`): `no-revoke-at-bump`, `host-answers-parent-run`, `key-not-in-cli-env`,
`verify-accepts-any-key`, `attach-reregisters`, `no-marker-file`, `key-logged`, `key-printed`.
Must-FAIL on pristine master: `same_turn` reds `a1`, `b2`, `c_row_in_new_run`, `e1`, `e2` (no key, the send is refused by the stale marker).
NOT covered: the packaged Electron app, sandbox/remote sessions, a CLI-side mutant (the CLI bundle is not load-mutated; master stands in).

Hygiene (`hygiene.mjs`, selftested): the live `~/.claude*`/`~/.orchestra*` listing FAILS on an added entry carrying the rig's marks and on ANY removed entry except the known transients (`telemetry`, `sessions`, `session-env`, `shell-snapshots`); other diffs are NOTEs (concurrent live sessions share those dirs).
