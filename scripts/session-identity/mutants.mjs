// Load-time MUTANTS of the shipped source for the session-identity must-FAIL proof (`run.mjs --proof`). Registered by identity-runner.mjs
// (`module.register`) BEFORE src/ is imported: the source is rewritten as node loads it — nothing on disk, no restore step.
// Each anchor must match EXACTLY ONCE (else PATTERN-GONE: a mutant that matched nothing would make its must-FAIL run pass vacuously).
// EXPECT names the arm each mutant is run on and the EXACT clause set it must red (judge.mjs ids) — more or fewer is a finding.

export const MUTANTS = {
  // The host answers the PARENT's run instead of the workspace's nearest orchestrator: a promotion never reaches the session's next call (the #379 symptom, host side).
  'host-answers-parent-run': { file: '/src/main/session-identity-host.ts', find: /      return ws \? nearestOrchestratorId\(ws, \(x\) => store\.getWorkspace\(x\)\) : null;\n/g, replace: '      return ws ? (ws.parentId ?? ws.id) : null;\n' },
  // The session key is minted and registered but never handed to the CLI's env: the CLI is keyless and falls back to its baked run.
  'key-not-in-cli-env': { file: '/src/main/agent-sdk.ts', find: /    if \(opts\.sessionKey\) env\[SESSION_KEY_ENV\] = opts\.sessionKey;\n/g, replace: '' },
  // The host vouches for ANY key of a workspace that has one: a replaced session is no longer fenced (#128 lost).
  'verify-accepts-any-key': { file: '/src/main/session-identity.ts', find: /      return presented\.length === stored\.length && crypto\.timingSafeEqual\(presented, stored\) \? 'ok' : 'superseded';\n/g, replace: "      void presented; void stored; return 'ok';\n" },
  // The pre-fix registration point: a key is registered whenever a start is MADE, so an attach to a surviving keeper supersedes the live CLI.
  'attach-reregisters': { file: '/src/main/keeper-client.ts', find: /(              attachedTurnInFlight = ack\.turnInFlight === true;\n)/g, replace: '$1              beforeFreshSpawn?.();\n' },
  // Promote no longer writes the fallback's marker file: with the host down the CLI trusts its baked (old) run and the send lands in it.
  'no-marker-file': { file: '/src/main/workspaces.ts', find: /        await writeStaleRunMarkerFile\(ws, newAnchorId\);\n        hostResolved\.push\(ws\.id\);\n/g, replace: '        hostResolved.push(ws.id);\n' },
  // The host logs the key it registers: the secret reaches the app log file (at rest).
  'key-logged': { file: '/src/main/session-identity-host.ts', find: /  slog\.info\(`session key registered for \$\{wsId\}`\);/g, replace: '  slog.info(`session key registered for ${wsId} ${key}`);' },
  // The host prints the key it registers: the secret reaches the process's stdout (not a file).
  'key-printed': { file: '/src/main/session-identity-host.ts', find: /  slog\.info\(`session key registered for \$\{wsId\}`\);/g, replace: '  console.log(`session key registered for ${wsId} ${key}`);' },
};

/** mutant -> the arm it runs on and the exact clause ids it must red. */
export const EXPECT = {
  'host-answers-parent-run': { arm: 'same_turn', red: ['c_row_in_new_run'] },
  'key-not-in-cli-env': { arm: 'same_turn', red: ['a1_key_in_cli_env', 'b2_send_rc0', 'c_row_in_new_run', 'e1_registry_hash', 'e2_key_not_at_rest'] },
  'verify-accepts-any-key': { arm: 'superseded', red: ['h1_host_refuses_old_key', 'r1_old_send_refused', 'r2_old_check_refused', 'r3_old_send_wrote_no_row'] },
  'attach-reregisters': { arm: 'attach_keeps_key', red: ['b1_registry_unchanged_by_attach', 'b2_live_cli_still_holds_k1', 'c1_host_accepts_k1_after_attach', 'c3_hand_cli_k1_resolved_by_host', 'c4_reattached_session_send_lands'] },
  'no-marker-file': { arm: 'app_closed', red: ['p2_marker_names_new_run', 's1_send_refused_by_marker', 's2_refused_send_wrote_no_row'] },
  'key-logged': { arm: 'same_turn', red: ['e2_key_not_at_rest'] },
  'key-printed': { arm: 'same_turn', red: ['e3_key_not_in_output'] },
};

let active = null;

export async function initialize(data) {
  active = data?.mutant ?? null;
  if (active && !MUTANTS[active]) throw new Error(`unknown mutant: ${active}`);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!active || !url.endsWith(MUTANTS[active].file)) return result;
  const m = MUTANTS[active];
  const src = String(result.source);
  const hits = [...src.matchAll(m.find)].length;
  if (hits !== 1) throw new Error(`mutant ${active}: PATTERN-GONE — anchor matched ${hits}× in ${m.file} (want exactly 1); the mutant no longer describes the shipped code`);
  return { ...result, source: src.replace(m.find, m.replace) };
}
