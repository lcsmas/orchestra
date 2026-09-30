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
