// #538 — the repo's own INTEGRATION HARNESS in the frozen-test writer's brief: PURE half. Resolution order: the harness DECLARED in the fanout state
// (`state init|set --harness`), else a documented discovery over the target ref's file list + root package.json, else none (the brief keeps its
// self-contained wording and says so). I/O (reading the target ref) is in fanout-harness-facts.ts; the brief is built by acceptorBrief (fanout-acceptance.ts).

/** What discovery reads: tracked paths of the TARGET ref (never an implementer's worktree) + its root package.json text. */
export interface RepoFacts { files: string[]; packageJson: string | null }

export interface HarnessScript { name: string; run: string }
export interface DiscoveredHarness { scripts: HarnessScript[]; specs: string[]; fixtures: string[]; packageManager: 'pnpm' | 'yarn' | 'npm' }

export type ResolvedHarness =
  | { source: 'declared'; ref: string }
  | { source: 'discovered'; found: DiscoveredHarness }
  | { source: 'none'; inspected: boolean };

export const MAX_SPECS = 4;
export const MAX_FIXTURES = 3;

/** package.json script names that run integration/e2e tests: `e2e`, `test:e2e`, `test:integration`, `integration`, `test:int`, `e2e:ci`, `test-e2e`… */
export const SCRIPT_NAME = /^(?:test[:_-])?(?:e2e|integration|int)(?:[:_-].*)?$/i;
/** A spec by NAME: `app.e2e-spec.ts`, `x.e2e.test.ts`, `y.integration.spec.js`, `z.int-spec.ts`, `a.e2e.ts`. */
export const SPEC_BY_NAME = /\.(?:e2e|integration|int)(?:[-.](?:spec|test))?\.[cm]?[jt]sx?$/i;
/** A spec by LOCATION: a test file under an `e2e/` or `integration/` directory (`test/e2e/orders.spec.ts`, `tests/integration/test_x.py`). */
export const SPEC_BY_DIR = /(?:^|\/)(?:e2e|integration|integration-tests?)\/(?:.*\/)?[^/]*(?:\.(?:spec|test)\.[cm]?[jt]sx?|test_[^/]*\.py|[^/]*_test\.py)$/i;
/** An app-module boot fixture by basename (extension stripped): the helper the repo's own integration specs create the app with. */
export const FIXTURE_NAME = /^(?:test-app|create-test-app|create-app|app\.fixture|app-fixture|testing-module|test-module|bootstrap-test|e2e-setup|setup-e2e|test-server)$/i;
const IGNORED = /(?:^|\/)(?:node_modules|dist|build|coverage|\.git)\//;

/** Discovered names go into an agent's prompt: only plain path / script-name characters survive (a newline or shell text in a tracked file name is dropped, never quoted). */
export const SAFE_NAME = /^[\w@./:+-]{1,120}$/;

const baseNoExt = (p: string): string => (p.split('/').pop() ?? p).replace(/\.[cm]?[jt]sx?$|\.py$/i, '');

/** `scripts` of a package.json text; a missing/invalid file or a non-string value is ignored (a discovery never throws). */
export function packageScripts(text: string | null): Record<string, string> {
  if (!text) return {};
  try {
    const j: unknown = JSON.parse(text);
    const s = typeof j === 'object' && j !== null ? (j as { scripts?: unknown }).scripts : null;
    if (typeof s !== 'object' || s === null) return {};
    return Object.fromEntries(Object.entries(s as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch { return {}; }
}

/** The documented default discovery: integration/e2e scripts of the root package.json, specs by name or directory, an app-boot fixture by name. Deterministic (sorted, capped). */
export function discoverHarness(facts: RepoFacts): DiscoveredHarness | null {
  const files = facts.files.filter((f) => !IGNORED.test(f) && SAFE_NAME.test(f)).sort();
  const packageManager = files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : 'npm';
  const scripts = Object.entries(packageScripts(facts.packageJson))
    .filter(([name]) => SCRIPT_NAME.test(name) && SAFE_NAME.test(name))
    .map(([name, cmd]) => ({ name, run: `${packageManager} run ${name}`, cmd }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, run }) => ({ name, run }));
  const specs = files.filter((f) => SPEC_BY_NAME.test(f) || SPEC_BY_DIR.test(f)).slice(0, MAX_SPECS);
  const fixtures = files.filter((f) => FIXTURE_NAME.test(baseNoExt(f)) && !specs.includes(f)).slice(0, MAX_FIXTURES);
  return scripts.length || specs.length || fixtures.length ? { scripts, specs, fixtures, packageManager } : null;
}

/** Declared beats discovered; nothing declared and nothing found = `none` (`inspected` false = the repo could not be read at all). */
export function resolveHarness(declared: string | null | undefined, facts: RepoFacts | null): ResolvedHarness {
  if (declared && declared.trim()) return { source: 'declared', ref: declared.trim() };
  if (!facts) return { source: 'none', inspected: false };
  const found = discoverHarness(facts);
  return found ? { source: 'discovered', found } : { source: 'none', inspected: true };
}

/** The `--run-cmd` stays a direct runner call on the frozen files (the #510 allowlist): the harness names WHAT to boot, not the command the gate runs. */
const RUN_CMD_NOTE = '`--run-cmd` is still a DIRECT runner call on your frozen files (the harness\'s own runner, from the allowlist in `orchestra fanout acceptance --help`, not `npm run`): if the harness cannot be run that way from your worktree (a runner flag or config off the allowlist, services you do not have), freeze the closest allowlisted call you can run, or do not freeze, and say so in your worker_done — do NOT rewrite or copy the harness.';

/** The brief's harness lines (one string per line). `target` = the branch the harness is read from. Without a harness: ONE line, the rest of the brief is unchanged. */
export function harnessBriefLines(h: ResolvedHarness, target: string): string[] {
  if (h.source === 'none') {
    return [h.inspected
      ? 'Integration harness: none was declared in the fanout state and none was found in the repo (no integration/e2e script, spec or app-boot fixture): keep the tests self-contained as above, and say in your worker_done if the repo does have an integration entry.'
      : 'Integration harness: none was declared in the fanout state and the repo could not be inspected: keep the tests self-contained as above, and say in your worker_done if the repo has an integration entry.'];
  }
  const named = h.source === 'declared'
    ? `Integration harness (DECLARED by the coordinator in the fanout state): ${h.ref}`
    : `Integration harness (FOUND by Orchestra on ${target}, not declared — read it before you rely on it): ${[
      h.found.scripts.length ? `script${h.found.scripts.length > 1 ? 's' : ''} ${h.found.scripts.map((s) => `\`${s.run}\``).join(', ')}` : '',
      h.found.specs.length ? `existing specs ${h.found.specs.join(', ')}` : '',
      h.found.fixtures.length ? `app-boot fixture ${h.found.fixtures.join(', ')}` : '',
    ].filter(Boolean).join('; ')}`;
  return [
    `${named}.`,
    `Every frozen test MUST (a) boot the FULL application module through that harness, exactly as the repo's existing integration specs do — never a hand-assembled module or a cherry-picked provider list (it passes alone and fails once tickets compose on ${target}); (b) open its OWN execution context per test — its own DB connection / query runner / transaction, created in that test's setup and released in its teardown: never share one across tests, never reuse one the app already released.`,
    `Import the harness as it stands on ${target}; never copy, edit or re-implement it (it is not hashed: a change to it is the candidate's). ${RUN_CMD_NOTE}`,
  ];
}
