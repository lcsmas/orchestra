// #407 — the go / no-go on Electron's EnableCookieEncryption fuse, computed MECHANICALLY from the raw rig records
// (docs/evidence/407-cookie-fuse.jsonl) against the limits frozen in ledger #409 §Go-no-go. Pure: the rig (scripts/e2e-cookie-fuse.mjs) writes
// records, scripts/cookie-fuse-verdict.mjs feeds them here, src/shared/cookie-fuse-verdict.test.ts pins every branch.
//
// Verdicts: GO · GO-WITH-COST · HARD-NO-GO (an H1..H4 clause fired) · NO-GO (no H clause fired but a GO-needs clause fails — the completion of the
// frozen table) · UNVERIFIED (a control is missing or red, or a run/cookie minimum is not met — "a missing control = UNVERIFIED, never a go").
// Interpretations (stated so OPS/LEAD can veto): "lost" = not readable in the keyring state the cookie was readable in; the fuse-OFF step of arm (d)
// is the DOCUMENTED one-way, so it does not count as H3; H3 covers the pre-existing claude-login cookies in every fuse-ON step.

export type Partition = 'profile' | 'login';
export type Build = 'off' | 'on';
export type Keyring = 'unlocked' | 'locked' | 'none' | 'basic';
export type Scope = 'host' | 'recognised-desktop';

/** Row census of one partition's Cookies DB for one group of cookies (old = written by the fuse-OFF stock build; new = written in this step). */
export interface DbStats { total: number; plain: number; encrypted: number; both: number; empty: number; v10: number; v11: number; other: number }

export type Rec =
  | { kind: 'meta'; fuseWire: { off: string; on: string; byteDiff: number }; [k: string]: unknown }
  | { kind: 'control'; name: string; ok: boolean; detail?: string; run?: number }
  /** An attempt that died on infrastructure (a renderer that never answered, a CDP timeout) before finishing: its partial records are kept in the file but are no data point. */
  | { kind: 'runAborted'; run: number; reason: string }
  | { kind: 'boot'; run: number; branch: string; step: string; build: Build; keyring: Keyring; scope: Scope; timing: boolean; readyMs: number; crashed: boolean; hung: boolean;
      keyringOk: boolean; backend: string | null; backendExpected: string | null }
  | { kind: 'jar'; run: number; branch: string; step: string; phase: 'pre' | 'post'; partition: Partition; oldExpected: number; oldReadable: number; newExpected: number; newReadable: number; loginKept: boolean }
  | { kind: 'db'; run: number; branch: string; step: string; partition: Partition; old: DbStats; new: DbStats };

/** The limits of §Go-no-go #407 (frozen). */
export const LIMITS = {
  minRuns: 3,
  minCookies: 20,
  stallMs: 10_000,
  /** "no single run beyond 1.5× the limit" (Method). */
  stallSingleMs: 15_000,
  /** NULL control: the same arm twice reads |Δ| ≤ 25 % of the smallest limit (the 10 s stall). */
  nullMs: 2_500,
} as const;

/** Controls the verdict will not do without (names written by scripts/e2e-cookie-fuse.mjs). */
export const REQUIRED_CONTROLS: readonly string[] = ['instrument/reads-a-known-stall', 'oracle/reads-a-synthetic-sealed-row-as-sealed'];

/** Diagnostic decompositions (not arms of the ticket): they explain a verdict, they never make one. */
export const DIAGNOSTIC_BRANCHES: ReadonlySet<string> = new Set(['X', 'Y']);

export const emptyStats = (): DbStats => ({ total: 0, plain: 0, encrypted: 0, both: 0, empty: 0, v10: 0, v11: 0, other: 0 });

/** The oracle's own predicate for arm (a): every counted cookie has `encrypted_value` non-empty AND `value` empty (stats are a partition of the rows, so
 *  `encrypted === total` already excludes plain / both / empty rows), and there are at least `min` of them. */
export function isFullyEncrypted(s: DbStats, min: number = LIMITS.minCookies): boolean {
  return s.total >= min && s.encrypted === s.total;
}
/** The inverse the fuse-OFF build writes (the positive control): value in clear, `encrypted_value` empty. */
export function isFullyPlain(s: DbStats, min: number = LIMITS.minCookies): boolean {
  return s.total >= min && s.plain === s.total;
}

/** Row → class from the columns the oracle reads: `value` text and the length of `encrypted_value`. */
export function classifyRow(value: string, encLen: number): 'plain' | 'encrypted' | 'both' | 'empty' {
  if (encLen > 0) return value === '' ? 'encrypted' : 'both';
  return value === '' ? 'empty' : 'plain';
}
/** Chromium's os_crypt prefix of an `encrypted_value` (hex of its first 3 bytes): v10 = the built-in basic_text key, v11 = the keyring-held key. */
export function backendOfPrefix(hex3: string): 'v10' | 'v11' | 'other' {
  return hex3 === '763130' ? 'v10' : hex3 === '763131' ? 'v11' : 'other';
}
export function statsOf(rows: ReadonlyArray<{ value: string; encLen: number; prefix: string }>): DbStats {
  const s = emptyStats();
  for (const r of rows) {
    s.total++;
    s[classifyRow(r.value, r.encLen)]++;
    if (r.encLen > 0) s[backendOfPrefix(r.prefix)]++;
  }
  return s;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export type Verdict = 'GO' | 'GO-WITH-COST' | 'HARD-NO-GO' | 'NO-GO' | 'UNVERIFIED';
export interface Finding { fired: boolean; why: string[] }
export interface VerdictResult {
  verdict: Verdict;
  reasons: string[];
  hard: { H1: Finding; H2: Finding; H3: Finding; H4: Finding };
  go: { a: Finding; b: Finding; c: Finding; d: Finding }; // fired = the GO clause FAILS
  cost: { signedOutUntilUnlock: boolean; permanentLoss: boolean; why: string[] };
  controls: { ok: boolean; missing: string[] };
  oneWay: { measured: boolean; fuseOffReadsEncrypted: boolean | null; reflipRecovers: boolean | null };
  numbers: Record<string, unknown>;
}

/** One line per distinct finding: the same sentence from several runs ("run 1 …", "run 2 …") becomes "runs 1,2 …". */
export function squash(lines: readonly string[]): string[] {
  const groups = new Map<string, number[]>();
  for (const l of lines) {
    const m = /\brun (\d+)\b/.exec(l);
    const key = m ? l.replace(/\brun \d+\b/, 'run *') : l;
    const runs = groups.get(key) ?? [];
    if (m) runs.push(Number(m[1]));
    groups.set(key, runs);
  }
  return [...groups].map(([key, runs]) => (runs.length ? key.replace('run *', `${runs.length === 1 ? 'run' : 'runs'} ${[...new Set(runs)].join(',')}`) : key));
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const fmt = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n)} ms`);

type Boot = Extract<Rec, { kind: 'boot' }>;
type Jar = Extract<Rec, { kind: 'jar' }>;
type Db = Extract<Rec, { kind: 'db' }>;

/** The verdict over every record, plus the same verdict over the host-scope records only (the app's real desktop class — see `scopes`). */
export function computeVerdict(all: readonly Rec[]): VerdictResult & { scopes: { all: Verdict; host: Verdict } } {
  const full = verdictOf(all);
  const isExtra = (r: Rec) => (r.kind === 'boot' ? r.scope !== 'host' : r.kind === 'jar' || r.kind === 'db' ? r.branch.startsWith('G') : false);
  const host = verdictOf(all.filter((r) => !isExtra(r)));
  return { ...full, scopes: { all: full.verdict, host: host.verdict } };
}

export function verdictOf(all: readonly Rec[]): VerdictResult {
  // a run that ABORTED is not a data point (its partial records stay in the file); the count and the reasons are reported, never hidden
  const abortedRuns = all.filter((r): r is Extract<Rec, { kind: 'runAborted' }> => r.kind === 'runAborted');
  const abortedIds = new Set(abortedRuns.map((r) => r.run));
  // …except a recorded crash / hang of a fuse-ON boot: that is H2 evidence whatever happened to the rest of the attempt
  const runOf = (r: Rec): number | undefined => { const v = (r as { run?: unknown }).run; return typeof v === 'number' ? v : undefined; };
  const recs = all.filter((r) => { const run = runOf(r); return r.kind === 'runAborted' || run === undefined || !abortedIds.has(run) || (r.kind === 'boot' && r.build === 'on' && (r.crashed || r.hung)); });
  const boots = recs.filter((r): r is Boot => r.kind === 'boot');
  const jars = recs.filter((r): r is Jar => r.kind === 'jar');
  const dbs = recs.filter((r): r is Db => r.kind === 'db');
  const controlRecs = recs.filter((r): r is Extract<Rec, { kind: 'control' }> => r.kind === 'control');
  const meta = recs.find((r): r is Extract<Rec, { kind: 'meta' }> => r.kind === 'meta');
  const runsOf = (xs: ReadonlyArray<{ run: number }>) => [...new Set(xs.map((x) => x.run))].sort((a, b) => a - b);
  const jarAt = (run: number, step: string, p: Partition, phase: 'pre' | 'post' = 'pre') => jars.find((j) => j.run === run && j.step === step && j.partition === p && j.phase === phase);
  const dbAt = (run: number, step: string, p: Partition) => dbs.find((d) => d.run === run && d.step === step && d.partition === p);
  const PARTS: Partition[] = ['profile', 'login'];
  /** What a step lost, from THREE surfaces: the jar the app read at start ('pre'), the jar after its own writes ('post'), the DB rows still on disk afterwards. */
  const lostAt = (run: number, step: string, p: Partition): { lost: boolean; detail: string } | null => {
    const j = jarAt(run, step, p, 'pre');
    if (!j) return null;
    const post = jarAt(run, step, p, 'post');
    const d = dbAt(run, step, p);
    const parts: string[] = [];
    if (j.oldReadable < j.oldExpected) parts.push(`${j.oldReadable}/${j.oldExpected} pre-existing cookies readable at start`);
    if (!j.loginKept) parts.push('login LOST');
    if (post && post.oldReadable < post.oldExpected) parts.push(`${post.oldReadable}/${post.oldExpected} readable after the boot's own writes`);
    if (d && d.old.total < j.oldExpected) parts.push(`${d.old.total}/${j.oldExpected} pre-existing rows left in the Cookies DB`);
    return { lost: parts.length > 0, detail: parts.join(', ') };
  };
  const numbers: Record<string, unknown> = { abortedRuns: abortedRuns.length, abortReasons: squash(abortedRuns.map((r) => `${r.reason.slice(0, 120)}`)) };

  // ───────────────────────── controls (M2): a missing one is UNVERIFIED ─────────────────────────
  const missing: string[] = [];
  const runsW = runsOf(dbs.filter((d) => d.step === 'W1'));
  // positive control: the fuse-OFF stock build's rows (the "old" cookies, step W1) are in CLEAR — the oracle's own predicate for (a) must read RED on them
  const posRed = runsW.flatMap((r) => PARTS.map((p) => { const d = dbAt(r, 'W1', p); return d ? !isFullyEncrypted(d.old) && isFullyPlain(d.old) : false; }));
  numbers.positiveControl = { runs: runsW.length, partitionsRed: posRed.filter(Boolean).length, partitionsChecked: posRed.length };
  if (runsW.length < LIMITS.minRuns || posRed.length === 0 || !posRed.every(Boolean)) missing.push(`positive control: the fuse-OFF build's cookies must read RED (plain, not encrypted) in every partition of ≥${LIMITS.minRuns} runs — got ${posRed.filter(Boolean).length}/${posRed.length} over ${runsW.length} runs`);
  // the two builds really differ in the fuse and nothing else
  if (!meta) missing.push('meta record (fuse wire of the two builds) absent');
  else if (meta.fuseWire.byteDiff !== 1) missing.push(`fuse control: the fuse-ON copy differs from the fuse-OFF copy by ${meta.fuseWire.byteDiff} byte(s), want exactly 1 (the arms must differ in the fuse and nothing else)`);
  for (const c of controlRecs) if (!c.ok) missing.push(`control ${c.name} RED${c.detail ? `: ${c.detail}` : ''}`);
  // the two instruments that no arm exercises by itself: the TIMER must read a known injected stall, the DB reader must say "sealed" on a known sealed row (else a stuck-RED / stuck-flat oracle passes as a finding)
  for (const need of REQUIRED_CONTROLS) if (!controlRecs.some((c) => c.name === need && c.ok)) missing.push(`control ${need} absent or red — the instrument was never shown able to read a known ${need.startsWith('instrument') ? 'stall' : 'sealed row'}`);
  for (const b of boots) if (!b.keyringOk) missing.push(`boot ${b.run}/${b.step}: the private keyring was not in the claimed state '${b.keyring}'`);
  for (const b of boots) if (b.backendExpected !== null && b.backend !== b.backendExpected && !b.crashed && !b.hung) missing.push(`boot ${b.run}/${b.step}: safeStorage backend ${b.backend} ≠ ${b.backendExpected} expected for ${b.keyring}/${b.scope} — the arm did not test the state it claims`);
  // NULL control: the same arm twice (sway, locked keyring, same build, same starting world) reads |Δ| ≤ 25 % of the smallest limit
  const sameArmDeltas: number[] = [];
  for (const run of runsOf(boots)) for (const build of ['off', 'on'] as Build[]) {
    const g = boots.filter((b) => b.run === run && b.timing && b.build === build && b.keyring === 'locked' && b.scope === 'host');
    if (g.length >= 2) sameArmDeltas.push(Math.abs(g[0].readyMs - g[1].readyMs));
  }
  const nullMed = median(sameArmDeltas);
  numbers.nullControl = { pairs: sameArmDeltas.length, medianAbsDeltaMs: nullMed, maxAbsDeltaMs: sameArmDeltas.length ? Math.max(...sameArmDeltas) : null, limitMs: LIMITS.nullMs };
  if (sameArmDeltas.length < LIMITS.minRuns) missing.push(`null control: need ≥${LIMITS.minRuns} same-arm pairs, have ${sameArmDeltas.length}`);
  else if ((nullMed as number) > LIMITS.nullMs) missing.push(`null control: the same arm twice differs by median ${fmt(nullMed)} > ${LIMITS.nullMs} ms — the stall instrument is too noisy to judge a 10 s limit`);

  // ───────────────────────── run / cookie minimums ─────────────────────────
  const a1Runs = runsOf(dbs.filter((d) => d.step === 'A1'));
  if (a1Runs.length < LIMITS.minRuns) missing.push(`arm (a)/(b): ${a1Runs.length} run(s), need ≥${LIMITS.minRuns}`);
  for (const d of dbs.filter((x) => x.step === 'A1')) if (d.new.total < LIMITS.minCookies || d.old.total < LIMITS.minCookies) missing.push(`run ${d.run} ${d.partition}: ${d.old.total} old / ${d.new.total} new cookies in the DB, need ≥${LIMITS.minCookies} each`);

  // restore control (A2): the A1 snapshot, restored and booted in the SAME state it was written in (fuse ON, unlocked), reads back whole — else any loss
  // seen in D1 / C2* could be the snapshot's, not the state change's
  const a2Runs = runsOf(jars.filter((j) => j.step === 'A2'));
  for (const run of a1Runs) for (const p of PARTS) {
    const j = jarAt(run, 'A2', p, 'pre');
    if (!j) missing.push(`restore control A2 run ${run} ${p}: absent`);
    else if (j.oldReadable !== j.oldExpected || j.newReadable !== j.newExpected || !j.loginKept) missing.push(`restore control A2 run ${run} ${p}: ${j.oldReadable}/${j.oldExpected} old + ${j.newReadable}/${j.newExpected} new readable, login ${j.loginKept ? 'kept' : 'LOST'} — the restored snapshot is not whole in the state it was written in`);
  }
  numbers.restoreControl = { runs: a2Runs.length };

  // ───────────────────────── (a) + (b) ─────────────────────────
  const a: Finding = { fired: false, why: [] };
  const b: Finding = { fired: false, why: [] };
  let bLost = 0, bLoginLost = 0;
  for (const run of a1Runs) for (const p of PARTS) {
    const d = dbAt(run, 'A1', p);
    if (!d || !isFullyEncrypted(d.new)) { a.fired = true; a.why.push(`run ${run} ${p}: new cookies ${d ? `${d.new.encrypted}/${d.new.total} encrypted (plain ${d.new.plain}, both ${d.new.both}, empty ${d.new.empty})` : 'no DB record'}`); }
    const l = lostAt(run, 'A1', p);
    if (!l) { b.fired = true; b.why.push(`run ${run} ${p}: no jar record after the flip`); continue; }
    const j = jarAt(run, 'A1', p, 'pre')!;
    bLost += j.oldExpected - j.oldReadable;
    if (!j.loginKept) bLoginLost++;
    if (l.lost) { b.fired = true; b.why.push(`run ${run} ${p}: ${l.detail}`); }
  }
  numbers.a = { runs: a1Runs.length, encryptedNewCookies: sum(dbs.filter((d) => d.step === 'A1').map((d) => d.new.encrypted)), totalNewCookies: sum(dbs.filter((d) => d.step === 'A1').map((d) => d.new.total)) };
  numbers.b = { preExistingLost: bLost, loginsLost: bLoginLost, rowsStillPlainAfterFlip: sum(dbs.filter((d) => d.step === 'A1').map((d) => d.old.plain)), rowsEncryptedAfterFlip: sum(dbs.filter((d) => d.step === 'A1').map((d) => d.old.encrypted)) };

  // ───────────────────────── (c): fuse ON, keyring locked / absent / basic ─────────────────────────
  const h2: Finding = { fired: false, why: [] };
  const cMissingJar: string[] = [];
  const timing = boots.filter((x) => x.timing);
  const baselineOf = (keyring: Keyring, scope: Scope) => median(timing.filter((x) => x.build === 'off' && x.keyring === keyring && x.scope === scope).map((x) => x.readyMs));
  const cNumbers: Record<string, unknown> = {};
  const cStates: Array<{ keyring: Keyring; scope: Scope; branch: string }> = [
    { keyring: 'locked', scope: 'host', branch: 'CL' }, { keyring: 'none', scope: 'host', branch: 'CN' }, { keyring: 'basic', scope: 'host', branch: 'CB' },
    { keyring: 'locked', scope: 'recognised-desktop', branch: 'GL' }, { keyring: 'none', scope: 'recognised-desktop', branch: 'GN' },
  ];
  for (const st of cStates) {
    const onBoots = boots.filter((x) => x.build === 'on' && x.keyring === st.keyring && x.scope === st.scope && (x.timing || x.branch === 'C2'));
    const branchBoots = boots.filter((x) => x.branch === st.branch);
    if (branchBoots.length === 0 && onBoots.length === 0) { if (st.scope === 'host') missing.push(`arm (c) ${st.keyring}: no run`); continue; }
    const base = baselineOf(st.keyring, st.scope);
    const timed = onBoots.filter((x) => x.timing);
    const stallMed = base === null || timed.length === 0 ? null : (median(timed.map((x) => x.readyMs)) as number) - base;
    const stallMax = base === null || timed.length === 0 ? null : Math.max(...timed.map((x) => x.readyMs)) - base;
    cNumbers[`${st.scope}/${st.keyring}`] = { onBoots: timed.length, baselineMs: base, stallMedianMs: stallMed, stallMaxMs: stallMax };
    if (base === null) missing.push(`stall baseline (fuse OFF, ${st.scope}/${st.keyring}) absent`);
    if (stallMed !== null && stallMed > LIMITS.stallMs) { h2.fired = true; h2.why.push(`${st.scope}/${st.keyring}: median stall ${fmt(stallMed)} > ${LIMITS.stallMs} ms over baseline ${fmt(base)}`); }
    else if (stallMax !== null && stallMax > LIMITS.stallSingleMs) { h2.fired = true; h2.why.push(`${st.scope}/${st.keyring}: one run stalls ${fmt(stallMax)} > ${LIMITS.stallSingleMs} ms (1.5×) over baseline`); }
    for (const x of onBoots) if (x.crashed || x.hung) { h2.fired = true; h2.why.push(`${st.scope}/${st.keyring} run ${x.run} ${x.step}: ${x.crashed ? 'crash' : 'hang'}`); }
    for (const run of runsOf(branchBoots)) for (const p of PARTS) {
      const l = lostAt(run, st.branch + '1', p);
      if (!l) { cMissingJar.push(`${st.branch} run ${run} ${p}: no jar record (hung or crashed before the read)`); continue; }
      if (l.lost) { h2.fired = true; h2.why.push(`${st.scope}/${st.keyring} run ${run} ${p}: pre-existing plaintext cookies lost — ${l.detail}`); }
    }
    const runsInState = runsOf(branchBoots).length;
    if (st.scope === 'host' && runsInState < LIMITS.minRuns) missing.push(`arm (c) ${st.keyring}: ${runsInState} run(s), need ≥${LIMITS.minRuns}`);
  }
  numbers.c = cNumbers;

  // ───────────────────────── cost: cookies written encrypted under an UNLOCKED keyring, read later under a locked/absent one ─────────────────────────
  const cost = { signedOutUntilUnlock: false, permanentLoss: false, why: [] as string[] };
  const c2Runs = runsOf(boots.filter((x) => x.branch === 'C2'));
  // each pair = [a start that cannot use the keyring key, the unlocked start after it]; the locked pair is required, the keyring-less and basic_text pairs are judged when measured
  const PAIRS: Array<[string, string, string, boolean]> = [['C2L', 'C2U', 'locked', true], ['C2N', 'C2NU', 'keyring-less', false], ['C2B', 'C2BU', 'basic_text', false]];
  for (const [first, second, label, required] of PAIRS) for (const run of required ? c2Runs : runsOf(jars.filter((j) => j.step === first))) for (const p of PARTS) {
    const j1 = jarAt(run, first, p, 'pre');
    const j2 = jarAt(run, second, p, 'pre');
    if (!j1 || (!j2 && required)) { missing.push(`cost arm ${first}/${second} run ${run} ${p}: jar record absent (${first} ${!!j1}, ${second} ${!!j2})`); continue; }
    if (!j2) { missing.push(`cost arm ${first} run ${run} ${p}: measured without its unlocked follow-up ${second} — "recoverable after unlock" cannot be judged`); continue; }
    const unreadable = j1.newReadable < j1.newExpected;
    const recovered = j2.newReadable === j2.newExpected && j2.oldReadable === j2.oldExpected;
    if (unreadable) cost.signedOutUntilUnlock = true;
    if (unreadable && !recovered) { cost.permanentLoss = true; cost.why.push(`run ${run} ${p}: encrypted cookies unreadable at the ${label} start (${j1.newReadable}/${j1.newExpected}) and NOT back after unlock (${j2.newReadable}/${j2.newExpected})`); }
    const l = lostAt(run, first, p);
    if (l?.lost) { h2.fired = true; h2.why.push(`${first} run ${run} ${p}: pre-existing cookies lost at a ${label} start after the unlocked one — ${l.detail}`); }
  }
  if (cost.signedOutUntilUnlock && !cost.permanentLoss) cost.why.push('encrypted-under-unlocked cookies are unreadable at a locked start and recover after unlock ("signed out until unlock")');
  if (c2Runs.length < LIMITS.minRuns) missing.push(`cost arm (C2): ${c2Runs.length} run(s), need ≥${LIMITS.minRuns}`);
  numbers.cost = { runs: c2Runs.length, signedOutUntilUnlock: cost.signedOutUntilUnlock, permanentLoss: cost.permanentLoss };

  // ───────────────────────── (d): the fuse turned back OFF ─────────────────────────
  const d: Finding = { fired: false, why: [] };
  const dRuns = runsOf(boots.filter((x) => x.branch === 'A' && x.step === 'D1'));
  let offReadsEnc: boolean | null = null, reflip: boolean | null = null;
  for (const run of dRuns) for (const p of PARTS) {
    const j1 = jarAt(run, 'D1', p, 'pre'), j2 = jarAt(run, 'D2', p, 'pre');
    if (!j1 || !j2) { missing.push(`(d) run ${run} ${p}: incomplete — D1 ${!!j1} D2 ${!!j2}`); continue; }
    const readsEnc = j1.newReadable === j1.newExpected;
    offReadsEnc = offReadsEnc === null ? readsEnc : offReadsEnc && readsEnc;
    const back = j2.newReadable === j2.newExpected && j2.oldReadable === j2.oldExpected;
    reflip = reflip === null ? back : reflip && back;
  }
  if (dRuns.length < LIMITS.minRuns) missing.push(`(d) measured in ${dRuns.length} run(s), need ≥${LIMITS.minRuns}`);
  numbers.d = { runs: dRuns.length, fuseOffReadsEncrypted: offReadsEnc, reflipRecovers: reflip,
    oldReadableWithFuseOff: sum(PARTS.flatMap((p) => dRuns.map((r) => jarAt(r, 'D1', p, 'pre')?.oldReadable ?? 0))), newReadableWithFuseOff: sum(PARTS.flatMap((p) => dRuns.map((r) => jarAt(r, 'D1', p, 'pre')?.newReadable ?? 0))) };

  // (c) as a GO clause = no loss, no stall, no crash/hang (the very conditions of H2), and every jar read happened
  const c: Finding = { fired: h2.fired || cMissingJar.length > 0, why: [...h2.why, ...cMissingJar] };

  // ───────────────────────── H1..H4 ─────────────────────────
  const H1: Finding = { fired: b.fired, why: b.why.slice() };
  const H2: Finding = h2;
  // H3: a pre-existing claude-login cookie lost in ANY fuse-ON step (the fuse-OFF step D1 of (d) is the documented one-way)
  const H3: Finding = { fired: false, why: [] };
  for (const j of jars.filter((x) => x.partition === 'login' && x.phase === 'pre' && x.step !== 'D1' && !DIAGNOSTIC_BRANCHES.has(x.branch) && !x.step.startsWith('W') && !x.step.startsWith('S'))) {
    if (j.oldReadable < j.oldExpected || !j.loginKept) { H3.fired = true; H3.why.push(`run ${j.run} ${j.step}: claude-login ${j.oldReadable}/${j.oldExpected} pre-existing cookies readable, login ${j.loginKept ? 'kept' : 'LOST'}`); }
  }
  // H4: the fuse-wire check can be made a must-FAIL release step — it needs the wire of the two builds to read back distinctly from the binaries
  const H4: Finding = { fired: !(meta && meta.fuseWire.off === 'disabled' && meta.fuseWire.on === 'enabled'), why: [] };
  if (H4.fired) H4.why.push('the fuse wire of the off/on builds does not read back as disabled/enabled from the binaries');

  for (const f of [H1, H2, H3, H4, a, b, c, d]) f.why = squash(f.why);
  cost.why = squash(cost.why);
  const controls = { ok: missing.length === 0, missing: squash(missing) };
  const reasons: string[] = [];
  let verdict: Verdict;
  if (!controls.ok) { verdict = 'UNVERIFIED'; reasons.push(...controls.missing); }
  else if (H1.fired || H2.fired || H3.fired || H4.fired) {
    verdict = 'HARD-NO-GO';
    for (const [k, f] of Object.entries({ H1, H2, H3, H4 })) if (f.fired) reasons.push(`${k}: ${f.why.join('; ') || 'fired'}`);
  } else if (a.fired || b.fired || c.fired || d.fired || cost.permanentLoss) {
    verdict = 'NO-GO';
    for (const [k, f] of Object.entries({ a, b, c, d })) if (f.fired) reasons.push(`(${k}) fails: ${f.why.join('; ')}`);
    if (cost.permanentLoss) reasons.push(`cost arm: ${cost.why.join('; ')}`);
  } else if (cost.signedOutUntilUnlock) { verdict = 'GO-WITH-COST'; reasons.push(...cost.why); }
  else { verdict = 'GO'; reasons.push('(a)(b)(c)(d) all hold; encrypted cookies stay readable at a locked/absent-keyring start'); }

  return {
    verdict, reasons, hard: { H1, H2, H3, H4 }, go: { a, b, c, d }, cost, controls,
    oneWay: { measured: dRuns.length >= LIMITS.minRuns, fuseOffReadsEncrypted: offReadsEnc, reflipRecovers: reflip },
    numbers,
  };
}
