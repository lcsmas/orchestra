// Load-time MUTANTS of the shipped source for the session-budget must-FAIL arms (#208).
// Registered by session-runner.mjs (`module.register`) BEFORE src/ is imported: the source text is
// rewritten as node loads it, so the mutant is a real edit of the shipped file inside its own
// resolution tree — with NOTHING written to disk (no restore step, no dirty release tree).
// Every mutant asserts its anchor matches EXACTLY ONCE, else the run throws PATTERN-GONE: a mutant
// that silently matched nothing would make its must-FAIL arm pass vacuously.

/** name -> { file suffix, regex (global), replace } */
export const MUTANTS = {
  // Review round 2 F1: an app-code edit that hands the CLI a traffic-suppressing env knob (buildSdkEnv copies process.env then adds
  // the workspace vars). The runner's own env is clean, so only the CLI's /proc environ can see it.
  'traffic-knob-in-sdk-env': {
    file: '/src/main/agent-sdk.ts',
    find: /(  env\.ORCHESTRA_BRANCH = ws\.branch;\n)/g,
    replace: "$1  env.DISABLE_TELEMETRY = '1';\n",
  },
  // Review round 2 F2: a startup call from the APP process (main) to a host nobody budgeted. Node's fetch ignores the proxy env
  // unless the runner started with NODE_USE_ENV_PROXY=1; without that wiring the attempt dies at DNS inside the netns, unseen.
  'app-fetch-new-host': {
    file: '/src/main/agent-sdk.ts',
    find: /(  void consume\(session\);\n)(?=(?:  \/\/[^\n]*\n)*  return session;\n)/g,
    replace: "$1  void fetch('https://telemetry.example.invalid/boot').catch(() => {});\n",
  },
  // #176 re-added: the pre-fix code called refreshContextUsage(wsId) right after consume() started
  // (git show 89ae8b4b^:src/main/agent-sdk.ts) — a boot-time getContextUsage() before the first turn.
  'boot-context-read': {
    file: '/src/main/agent-sdk.ts',
    find: /(  void consume\(session\);\n)(?=(?:  \/\/[^\n]*\n)*  return session;\n)/g,
    replace: '$1  refreshContextUsage(wsId);\n',
  },

  // ── #210: the delete path (src/main/workspaces.ts `stopStructuredSession`, wave A #201) ──────────────────
  // Skip the whole stop (the tombstone stays): a delete leaves the session's keeper + CLI + MCP servers running.
  'delete-skips-stop': {
    file: '/src/main/workspaces.ts',
    find: /(async function stopStructuredSession\(id: string\): Promise<void> \{\n  forbidKeeperLaunch\(id\);[^\n]*\n)/g,
    replace: '$1  return;\n',
  },
  // Skip only the descendant sweep: the CLI dies with its keeper, a descendant that outlives it (--stubborn MCP) does not.
  'delete-skips-tree-sweep': {
    file: '/src/main/workspaces.ts',
    find: /  await killKeeperTree\(id, tree, 'workspace-deleted'\)\.catch\([^\n]*\n/g,
    replace: '',
  },
  // The renderer IPC handler stops the live session BEFORE deleteWorkspace — a second, independent stopper.
  'ui-skips-sdkstop': {
    file: '/src/main/api-handlers.ts',
    find: /(  deleteWorkspace: \(id\) => \{\n)    sdkStopMany\(\[id\]\);\n/g,
    replace: '$1',
  },
};

/** BUNDLE mutants: text edits of the built `keeper.js` COPY the runner installs into the scratch ORCHESTRA_HOME
 *  (never dist-electron/keeper.js itself), applied by `mutateBundle` — the keeper daemon is what runs from that
 *  file, so this is the shipped artifact with one clause changed. Same exactly-once anchor rule. */
export const BUNDLE_MUTANTS = {
  // #210 process budget: the daemon starts a helper process next to the CLI.
  'keeper-extra-child': {
    find: /(  child = node_child_process\.spawn\(command, args, \{ cwd, env, stdio: \["pipe", "pipe", "pipe"\] \}\);\n)/g,
    replace: '  node_child_process.spawn("sleep", ["600"], { stdio: "ignore" });\n$1',
  },
  // #210 memory budget: the daemon holds 300 MB (a fill touches every page, so it is RSS, not just address space).
  'keeper-ballast': {
    find: /(  child = node_child_process\.spawn\(command, args, \{ cwd, env, stdio: \["pipe", "pipe", "pipe"\] \}\);\n)/g,
    replace: '  globalThis.__sbBallast = Buffer.alloc(300 * 1024 * 1024, 1);\n$1',
  },
};

/** `a+b` = several mutants at once (each name must be in one of the two tables). */
export const mutantNames = (spec) => (spec ? String(spec).split('+').filter(Boolean) : []);

/** Apply the BUNDLE mutants named in `spec` to the keeper bundle text; text unchanged when none. */
export function mutateBundle(spec, text) {
  let out = text;
  for (const name of mutantNames(spec)) {
    const m = BUNDLE_MUTANTS[name];
    if (!m) continue;
    const hits = [...out.matchAll(m.find)].length;
    if (hits !== 1) throw new Error(`mutant ${name}: PATTERN-GONE — anchor matched ${hits}× in keeper.js (want exactly 1); the mutant no longer describes the shipped bundle`);
    out = out.replace(m.find, m.replace);
  }
  return out;
}

let active = [];

export async function initialize(data) {
  active = mutantNames(data?.mutant);
  for (const n of active) if (!MUTANTS[n] && !BUNDLE_MUTANTS[n]) throw new Error(`unknown mutant: ${n}`);
  active = active.filter((n) => MUTANTS[n]);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  let src = null;
  for (const name of active) {
    const m = MUTANTS[name];
    if (!url.endsWith(m.file)) continue;
    src ??= String(result.source);
    const hits = [...src.matchAll(m.find)].length;
    if (hits !== 1) throw new Error(`mutant ${name}: PATTERN-GONE — anchor matched ${hits}× in ${m.file} (want exactly 1); the mutant no longer describes the shipped code`);
    src = src.replace(m.find, m.replace);
  }
  return src === null ? result : { ...result, source: src };
}
