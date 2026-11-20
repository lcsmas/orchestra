// #475 — role-guard false positives from the first real v2 trial. The VERBATIM denied commands (scripts/role-guard/vf2-trial-cases.json,
// extracted from the trial transcripts) run through the INSTALLED command form with real PreToolUse JSON incl. `cwd`:
//   BEFORE = the frozen pre-#475 guard (scripts/role-guard/pre-475-guard.sh) must DENY each one with the trial's own message;
//   AFTER  = the live guard must ALLOW it, and every sibling (same shape, real repo target / unresolvable variable) must still DENY.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_ROLE_GUARD_CMD, ROLE_GUARD_SCRIPT, ROLE_SENTINEL_FILE } from './role-guard.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/role-guard/vf2-trial-cases.json'), 'utf8'));
const PRE475 = fs.readFileSync(path.join(repo, 'scripts/role-guard/pre-475-guard.sh'), 'utf8');

// NOT under os.tmpdir(): /tmp is scratch for the guard, so a /tmp root would make every "repo write" case vacuous.
const root = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.rgv-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, 'home');
const WT = '@WT@';

function install(script: string, role: string, name: string): string {
  const w = path.join(home, '.orchestra', 'worktrees', `rgv-${name}`);
  fs.mkdirSync(path.join(w, '.orchestra'), { recursive: true });
  fs.writeFileSync(path.join(w, '.orchestra', 'role-guard.sh'), script, { mode: 0o755 });
  fs.writeFileSync(path.join(w, '.orchestra', ROLE_SENTINEL_FILE), role);
  return w;
}
/** The hook payload exactly as Claude Code sends it (incl. `cwd`), the hook env a fleet member has (TMPDIR = its scratch dir). */
function run(w: string, command: string, o: { cwd?: string; tmpdir?: string; env?: Record<string, string> } = {}) {
  const payload = JSON.stringify({
    session_id: 's', transcript_path: `${home}/.claude/p/s.jsonl`, cwd: o.cwd ?? w, permission_mode: 'default', hook_event_name: 'PreToolUse',
    tool_name: 'Bash', tool_input: { command, description: 'x' }, tool_use_id: 'toolu_1',
  }).split(WT).join(w);
  const r = spawnSync('bash', ['-c', HOOK_ROLE_GUARD_CMD], {
    input: payload,
    env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_WS_ID: 'ws-1', ORCHESTRA_WORKTREE: w, TMPDIR: o.tmpdir ?? '/var/tmp/orch-1000-b17728/ws-test', ...o.env },
    encoding: 'utf8', timeout: 40_000,
  });
  return { code: r.status, err: r.stderr };
}

interface Sibling { name: string; prepend?: string; replace?: [string, string]; expected: 'deny'; denyRe: string }
interface Vf2Case { id: string; role: string; cwd: string; tmpdir: string; command: string; verbatimDeny: string; rootCause: string; siblings: Sibling[] }
const cases: Vf2Case[] = FIXTURE.cases;
const sibCommand = (c: Vf2Case, s: Sibling): string => {
  const out = s.prepend !== undefined ? s.prepend + c.command : c.command.replace(s.replace![0], s.replace![1]);
  assert.notEqual(out, c.command, `${c.id}: sibling "${s.name}" must differ from the verbatim command`);
  return out;
};

test('the fixture is the trial: 18 false positives (+ 3 by-design chain denials as controls), every verbatim deny names a role', () => {
  assert.equal(cases.length, 18);
  assert.equal(FIXTURE.byDesign.length, 3);
  for (const c of cases) assert.ok(c.command.length > 20 && c.verbatimDeny.length > 10 && c.tmpdir.startsWith('/var/tmp/'), c.id);
  assert.deepEqual([...new Set(cases.map((c) => c.role))].sort(), ['coordinator', 'reviewer', 'verifier']);
});

for (const c of cases) {
  test(`BEFORE (pre-#475 guard) denies ${c.id} [${c.role}] with the trial's own message`, () => {
    const r = run(install(PRE475, c.role, `pre-${c.role}`), c.command, { cwd: c.cwd, tmpdir: c.tmpdir });
    assert.equal(r.code, 2, `the unfixed guard must FAIL this case (else the fixture proves nothing): ${r.err}`);
    assert.ok(r.err.includes(c.verbatimDeny), `${r.err.slice(0, 200)} ⟂ ${c.verbatimDeny}`);
  });
  test(`AFTER allows ${c.id} [${c.role}] — ${c.rootCause}`, () => {
    const r = run(install(ROLE_GUARD_SCRIPT, c.role, `post-${c.role}`), c.command, { cwd: c.cwd, tmpdir: c.tmpdir });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, '');
  });
  for (const s of c.siblings) {
    test(`AFTER still denies the sibling of ${c.id}: ${s.name}`, () => {
      const r = run(install(ROLE_GUARD_SCRIPT, c.role, `sib-${c.role}`), sibCommand(c, s), { cwd: c.cwd, tmpdir: c.tmpdir });
      assert.equal(r.code, 2, `sibling must stay denied: ${r.err}`);
      assert.match(r.err, new RegExp(s.denyRe));
      assert.ok(r.err.includes(`role: ${c.role}`), r.err);
    });
  }
}
for (const b of FIXTURE.byDesign) {
  test(`check + force-push chain stays denied BY DESIGN: ${b.id}`, () => {
    const r = run(install(ROLE_GUARD_SCRIPT, b.role, `bd-${b.role}`), b.command, { cwd: b.cwd });
    assert.equal(r.code, 2);
    assert.match(r.err, /chained with a destructive act/);
  });
}

// ---- two-direction probes (shapes from the #468 reviews + this ticket's classes), every write-guarded role ----------------------
const scratchRoot = path.join(root, 'xtmp', 'ws-7'); // a TMPDIR that is NOT under /tmp, /var/tmp or agent-tmp
const agentTmp = path.join(home, '.orchestra', 'agent-tmp', 'ws-1');
interface Probe { name: string; cmd: string; deny?: RegExp; cwd?: string; tmpdir?: string; env?: Record<string, string> }
const ALLOW: Probe[] = [
  { name: 'positional parameters of a function are bound to the call arguments', cmd: 'f(){ echo x > $TMPDIR/o-$1.log; }; f a; f b; g(){ echo x > "$1"; }; g $TMPDIR/ok.txt' },
  { name: 'two loops over the same variable (literal tokens) are not a reassignment hazard', cmd: 'for v in A B; do mkdir -p $TMPDIR/app$v; done; for v in A B; do for n in 1 2; do echo x > $TMPDIR/var$v-$n.log; done; done' },
  { name: 'brace default with :? (set TMPDIR)', cmd: 'echo hi > ${TMPDIR:?}/o.txt' },
  { name: 'for over literals / seq / brace range, $RANDOM, $$, $(date): one safe component', cmd: 'for i in $(seq 1 3); do echo x > $TMPDIR/f-$i.log; done; for j in {1..3}; do echo x > $TMPDIR/g-$j.log; done; echo x > $TMPDIR/r-$RANDOM-$$.log; echo x > "$TMPDIR/d-$(date +%Y%m%d-%H%M).log"' },
  { name: 'a function body is judged at the CALL: relative write after cd $VAR', cmd: 'D=$TMPDIR/s; f(){ echo x > out.txt; }; cd $D; f; f' },
  { name: 'prefix assignment inside the command line is fine for scratch', cmd: 'LC_ALL=C sort -o $TMPDIR/o.txt $TMPDIR/i.txt; RGV=1 echo x > $TMPDIR/p.txt' },
  { name: 'sed -i with a plain s///g script on a scratch file', cmd: 'sed -i s/a/b/g $TMPDIR/f; sed -i -e "s/x/y/" -e "/z/d" $TMPDIR/f' },
  { name: 'arithmetic is not a write: (( x > 1 )), $(( 5 > 3 )), $(( a>b ? 1 : 0 ))', cmd: '(( x > 1 )); echo $(( 5 > 3 )) $(( a>b ? 1 : 0 )); [ $((2>1)) = 1 ] && echo y' },
  { name: '${TMPDIR:-/tmp} (the hook env knows TMPDIR)', cmd: 'echo hi > ${TMPDIR:-/tmp}/o.txt' },
  { name: 'd=$(mktemp -d); write under it', cmd: 'd=$(mktemp -d); echo ok > $d/res.txt; e=$(mktemp); echo ok > $e' },
  { name: 'cd $(mktemp -d) && relative write', cmd: 'cd $(mktemp -d) && echo ok > res.txt' },
  { name: 'mktemp -d -t TEMPLATE', cmd: 'd=$(mktemp -d -t foo.XXXX); echo ok > $d/res.txt' },
  { name: 'a long ordinary command stays well inside the scan budget', cmd: 'echo "a b" \'c d\' > $TMPDIR/x; '.repeat(1200) },
  { name: 'loop VAR inside the LAST component of a $TMPDIR path (real-world: log per iteration)', cmd: 'for i in 1 2 3; do node t.js > $TMPDIR/run-$i.log 2>&1; done; for f in a b; do echo x > $TMPDIR/seat/$f; done; echo y > "$TMPDIR/b-$(date +%s).log"' },
  { name: 'docker run … sh -c writing a CONTAINER path under scratch', cmd: 'docker run --rm img sh -c "echo x > /var/tmp/q/out.txt"' },
  { name: 'angle-bracket text inside a quoted brief', cmd: 'orchestra spawn --name x --task "report <branch> @ <tip>, then <ack>" 2>&1 | tail -1' },
  { name: 'shell-escaped quotes inside a quoted brief (the trial shape)', cmd: 'orchestra spawn --task "run \\"$(orchestra token)\\" then \\"<a> @ <b>\\" ok" | cat' },
  { name: 'escaped inner quotes around a > (reviewer m2 FP)', cmd: 'gh issue comment 1 --body "He said \\"x > 3\\" ok"' },
  { name: 'single-quoted angle text into scratch', cmd: "echo '<a> @ <b>, <c>' > $TMPDIR/o.txt" },
  { name: 'heredoc into a $TMPDIR target, body has >', cmd: "cat > $TMPDIR/a.mjs <<'EOF'\nconst f = (x) => x > 1;\nEOF\nnode $TMPDIR/a.mjs" },
  { name: 'VAR assigned in the command, used with $VAR and ${VAR}', cmd: 'S=$TMPDIR/s; mkdir -p $S; echo x > $S/f; echo y >> ${S}/g' },
  { name: 'VAR built from another VAR', cmd: 'S=$TMPDIR/f0; P=$S/package.json; git show origin/main:package.json > $P' },
  { name: 'export VAR=scratch', cmd: 'export S=$TMPDIR/a; echo x > $S/f' },
  { name: '${TMPDIR} and a quoted path with a space', cmd: 'echo x > ${TMPDIR}/f; echo y > "${TMPDIR}/a b"' },
  { name: 'relative target after cd $VAR (scratch)', cmd: 'S=$TMPDIR/f0 && mkdir -p $S && cd $S && git show origin/main:package.json > package.json' },
  { name: 'cd $D || exit: the failure branch leaves, the cwd stays tracked', cmd: 'D=$TMPDIR/s; cd $D || exit 1; echo a > a.ts' },
  { name: 'relative target after cd $VAR on its own line', cmd: 'D=$TMPDIR/s\ncd $D\necho x > out.txt' },
  { name: 'relative target when the payload cwd IS scratch', cmd: 'echo x > rel.txt; ls > ./sub/rel2.txt', cwd: `${agentTmp}/clone` },
  { name: 'subshell cd into scratch, write inside it', cmd: 'D=$TMPDIR/s; (cd $D && echo x > f)' },
  { name: 'sed -i on a scratch file ($TMPDIR)', cmd: 'sed -i s/a/b/ $TMPDIR/ops/c.md' },
  { name: 'sed -i -e … -e … on two scratch files', cmd: 'sed -i -e s/a/b/ -e s/c/d/ $TMPDIR/a $TMPDIR/b' },
  { name: 'sed -i.bak on a scratch file', cmd: 'sed -i.bak s/a/b/ $TMPDIR/f' },
  { name: 'sed -E -i with a quoted script on a quoted scratch path', cmd: `sed -E -i 's/a b/c/' "$TMPDIR/f"` },
  { name: 'sed -i on a relative file when cwd is scratch', cmd: 'sed -i s/a/b/ f', cwd: `${agentTmp}/clone` },
  { name: 'sed WITHOUT -i on a repo file', cmd: 'sed -n 1,5p src/a.ts; sed -E s/a/b/ src/a.ts > $TMPDIR/o' },
  { name: 'tee into scratch (VAR + quoted)', cmd: 'S=$TMPDIR/q; echo x | tee $S/o | tee -a "$S/p"' },
  { name: '~/.orchestra/agent-tmp target', cmd: 'echo x >> ~/.orchestra/agent-tmp/ws-1/log' },
  { name: '2>&1, &>/dev/null, >&2, 2>/dev/null', cmd: 'ls nope 2>&1 >/dev/null; ls &>/dev/null; echo a >&2; ls 2>/dev/null' },
  { name: 'process substitution', cmd: 'diff <(sort a) <(sort b); echo x > >(tee $TMPDIR/l)' },
  { name: 'bash -c writing into a $VAR scratch', cmd: 'S=$TMPDIR/b; bash -c "echo x > $S/f"' },
  { name: 'a VAR from the hook env that resolves into scratch', cmd: 'echo x > $RGV_SCRATCH/f', env: { RGV_SCRATCH: '/var/tmp/orch-1000-b17728/ws-test/e' } },
  { name: 'TMPDIR outside /tmp and agent-tmp is still the role\'s scratch', cmd: 'echo x > $TMPDIR/f; echo y > rel.txt', tmpdir: scratchRoot, cwd: scratchRoot },
  { name: 'a spawn brief with escaped quotes AFTER a scratch write', cmd: 'echo x > $TMPDIR/b.md; orchestra spawn --task "ack \\"<x>\\" @ <y>"' },
  { name: 'function body cd stays isolated, the write is absolute scratch', cmd: 'D=$TMPDIR/s; run(){ cd $D; echo x > f; }; run; echo y > $TMPDIR/g' },
];
const DENY: Probe[] = [
  { name: 'a function argument that is a repo path', cmd: 'g(){ echo x > "$1"; }; g src/a.ts', deny: /shell write to '[$]1'/ },
  { name: 'a function argument that is unresolvable', cmd: 'g(){ echo x > "$1"; }; g $(ls)', deny: /shell write to '[$]1'/ },
  { name: 'a function body reads $1 from the CALL, not from an outer function', cmd: 'g(){ echo x > "$1"; }; h(){ g $TMPDIR/ok; echo y > $1; }; h src/b.ts', deny: /shell write to '[$]1'/ },
  { name: 'sed -i s///w FILE (script-level write)', cmd: 'sed -i s/x/y/w\\ src/pwn $TMPDIR/f', deny: /sed -i edits files in place/ },
  { name: 'sed -i with -f script', cmd: 'sed -i -f $TMPDIR/s.sed $TMPDIR/f', deny: /sed -i edits files in place/ },
  { name: 'a variable with spaces is word-split', cmd: 'V="$TMPDIR/a src/b"; echo x | tee $V', deny: /shell write to '[$]V'/ },
  { name: 'unquoted brace alternatives in a target', cmd: 'echo x | tee $TMPDIR/{a,b}', deny: /shell write/ },
  { name: 'a glob that climbs out with ..', cmd: 'echo x | tee $TMPDIR/*/../../x', deny: /shell write/ },
  { name: 'subshell ((…)) with a write is NOT arithmetic', cmd: '((echo a > src/a.ts); echo b)', deny: /shell write to 'src\/a\.ts'/ },
  { name: 'x=$((…; …)) subshell', cmd: 'x=$((echo a > src/a.ts); echo b)', deny: /shell write to 'src\/a\.ts'/ },
  { name: '$(( $( write ) + 1 )) command substitution inside arithmetic', cmd: 'echo $(( $(echo a > src/a.ts; echo 1) + 1 ))', deny: /shell write to 'src\/a\.ts'/ },
  { name: '(( x = $( write ) ))', cmd: '(( x = $(echo a > src/a.ts) ))', deny: /shell write to 'src\/a\.ts'/ },
  { name: 'a backgrounded cd runs in a subshell', cmd: 'D=$TMPDIR/s; cd $D & echo a > f', deny: /shell write to 'f'/ },
  { name: 'a piped cd (lhs) runs in a subshell', cmd: 'D=$TMPDIR/s; cd $D | cat; echo a > f', deny: /shell write to 'f'/ },
  { name: 'a piped cd (rhs) runs in a subshell', cmd: 'D=$TMPDIR/s; ls | cd $D; echo a > f', deny: /shell write to 'f'/ },
  { name: 'variables assigned in a subshell do not survive it', cmd: '(D=$TMPDIR/s); cd $D; echo a > f', deny: /shell write to 'f'/ },
  { name: 'variables assigned in a function body do not survive it', cmd: 'f(){ D=$TMPDIR/s; }; f; cd $D; echo a > f', deny: /shell write to 'f'/ },
  { name: 'unset VAR', cmd: 'D=$TMPDIR/s; unset D; cd $D; echo a > f', deny: /shell write to 'f'/ },
  { name: 'printf -v VAR', cmd: 'D=$TMPDIR/s; printf -v D src; echo a > $D/f', deny: /shell write to '\$D\/f'/ },
  { name: 'VAR[0]= element assignment', cmd: 'D=$TMPDIR/s; D[0]=src; echo a > $D/f', deny: /shell write to '\$D\/f'/ },
  { name: '~user is not HOME (cwd in scratch)', cmd: 'echo a > ~root/a.ts', cwd: `${agentTmp}/clone`, deny: /shell write to '~root\/a\.ts'/ },
  { name: "$'\\x2f…' ANSI-C quoting is unresolvable (cwd in scratch)", cmd: "echo a > $'\\x2fhome\\x2fzz/a'", cwd: `${agentTmp}/clone`, deny: /shell write/ },
  { name: 'cd ~user is an unknown cwd', cmd: 'cd ~root; echo a > a.ts', cwd: `${agentTmp}/clone`, deny: /shell write to 'a\.ts'/ },
  { name: 'an UNKNOWN var with a :- default is still unresolved (fail closed)', cmd: 'echo a > ${UNSETVAR:-/var/tmp/q}/f', deny: /shell write/ },
  { name: 'mktemp with a template relative to the CWD', cmd: 'd=$(mktemp foo.XXXX); echo x > $d', deny: /shell write to '\$d'/ },
  { name: 'mktemp -p into the repo', cmd: 'd=$(mktemp -d -p src); echo x > $d/f', deny: /shell write to '\$d\/f'/ },
  { name: 'mktemp with an absolute template', cmd: 'd=$(mktemp -d /home/zz/x.XXXX); echo x > $d/f', deny: /shell write to '\$d\/f'/ },
  { name: 'a pathologically nested unterminated quote chain is denied (scan budget), fast', cmd: 'echo ' + '"$(echo '.repeat(19) + 'x', deny: /too complex/ },
  { name: 'unset VAR target', cmd: 'echo x > $UNSET/f', deny: /shell write to '\$UNSET\/f'/ },
  { name: 'unresolvable part INSIDE a scratch path ($TMPDIR/$UNSET) — fail closed', cmd: 'echo x > $TMPDIR/$UNSET/f', deny: /shell write to '\$TMPDIR\/\$UNSET\/f'/ },
  { name: 'unresolvable part in a MIDDLE component of a scratch path — fail closed', cmd: 'for d in $(ls); do echo x > $TMPDIR/$d/f.log; done', deny: /shell write/ },
  { name: 'an unresolvable part as the FIRST component', cmd: 'for d in a b; do echo x > $d-$TMPDIR/f.log; done', deny: /shell write/ },
  { name: 'unresolvable last component under a REPO dir', cmd: 'for i in 1 2; do echo x > src/run-$i.log; done', deny: /shell write to 'src\/run-\$i\.log'/ },
  { name: 'docker run … sh -c "… > bind-mounted repo path" (shell word at ANY position)', cmd: 'docker run --rm -v $PWD:/w img sh -c "echo x > /w/src/a.ts"', deny: /shell write to '\/w\/src\/a\.ts'/ },
  { name: 'xargs bash -c "… > repo"', cmd: 'ls | xargs bash -c "echo x > src/a.ts"', deny: /shell write to 'src\/a\.ts'/ },
  { name: 'VAR from $( ) (unresolvable)', cmd: 'S=$(cat $TMPDIR/p); echo x > $S/f', deny: /shell write to '\$S\/f'/ },
  { name: 'VAR reassigned to a repo dir', cmd: 'S=$TMPDIR/a; S=src; echo x > $S/f', deny: /shell write/ },
  { name: 'VAR first a repo dir, then scratch (conditional-assignment hazard)', cmd: 'S=src; [ -d x ] && S=$TMPDIR/a; echo x > $S/f', deny: /shell write/ },
  { name: 'VAR assigned a relative repo path', cmd: 'S=src/rev; cat > $S/o.mjs <<EOF\nx\nEOF', deny: /shell write to '\$S\/o\.mjs'/ },
  { name: 'for-loop VAR', cmd: 'for f in a b; do echo x > $f; done', deny: /shell write to '\$f'/ },
  { name: 'for-loop VAR shadowing a scratch VAR', cmd: 'D=$TMPDIR/a; for D in x y; do echo x > $D/f; done', deny: /shell write to '\$D\/f'/ },
  { name: 'a nested $( ) must not overwrite the word being read (inner scratch path hides a repo target)', cmd: 'echo x > src/$(echo /var/tmp/q)', deny: /shell write to 'src\/\$\(echo/ },
  { name: 'same through backticks', cmd: 'echo x > src/`echo /var/tmp/q`', deny: /shell write to 'src[/]/ },
  { name: 'a path that STARTS unresolved stays denied even when the cwd is scratch ($X may be absolute)', cmd: 'echo x > $UNSET-out.log', cwd: `${agentTmp}/clone`, deny: /shell write to '\$UNSET-out\.log'/ },
  { name: 'VAR += appends an unknown suffix', cmd: 'D=$TMPDIR/a; D+=/../../x; echo a > $D/a.ts', deny: /shell write/ },
  { name: 'cd … || true: a failed cd leaves the cwd elsewhere', cmd: 'D=$TMPDIR/s; cd $D || true; echo a > a.ts', deny: /shell write to 'a\.ts'/ },
  { name: 'for over a NON-literal list keeps no old value', cmd: 'D=$TMPDIR/a; for D in $(ls); do echo a > $D/f; done', deny: /shell write to '[$]D[/]f'/ },
  { name: 'read VAR', cmd: 'read X; echo x > $X/f', deny: /shell write/ },
  { name: 'a hook-env VAR that points into the repo', cmd: 'echo x > $RGV_REPO/f', env: { RGV_REPO: `${WT}/src` }, deny: /shell write to '\$RGV_REPO\/f'/ },
  { name: 'relative write with the payload cwd in the repo', cmd: 'echo x > src/a.ts', deny: /shell write to 'src\/a\.ts'/ },
  { name: 'relative write after cd into the repo', cmd: `S=$TMPDIR/s; cd $S && cd ${WT} && echo x > f`, deny: /shell write to 'f'/ },
  { name: 'relative write after cd into an unresolvable dir', cmd: 'cd $(cat $TMPDIR/p) && echo x > f', deny: /shell write to 'f'/ },
  { name: 'subshell cd does not leak: the write is in the repo', cmd: 'D=$TMPDIR/s; (cd $D && ls); echo x > f', deny: /shell write to 'f'/ },
  { name: 'cd inside $( ) does not leak', cmd: 'D=$TMPDIR/s; X=$(cd $D && ls); echo x > f', deny: /shell write to 'f'/ },
  { name: 'cd in a function body does not leak', cmd: 'D=$TMPDIR/s; run(){ cd $D; }; run; echo x > f', deny: /shell write to 'f'/ },
  { name: 'cd - is unknown', cmd: 'D=$TMPDIR/s; cd $D; cd -; echo x > f', deny: /shell write to 'f'/ },
  { name: '.. climbs out of $TMPDIR', cmd: 'echo x > $TMPDIR/../../../../home/x/f', deny: /shell write/ },
  { name: '.. climbs out of /var/tmp', cmd: 'echo x > /var/tmp/../home/x/f', deny: /shell write/ },
  { name: 'cd .. out of scratch, relative write', cmd: 'D=$TMPDIR/s && cd $D && cd ../../../../../home/x && echo x > f', deny: /shell write to 'f'/ },
  { name: 'a real write after a quoted brief', cmd: 'orchestra spawn --task "ack \\"<x>\\" @ <y>" && echo x > src/a.ts', deny: /shell write to 'src\/a\.ts'/ },
  { name: 'a real $( ) inside the quoted brief', cmd: 'orchestra spawn --task "ack $(echo x > src/a.ts)"', deny: /shell write to 'src\/a\.ts'/ },
  { name: 'backticks inside a quoted string', cmd: 'echo "a `echo x > src/a.ts` b"', deny: /shell write to 'src\/a\.ts'/ },
  { name: '$( ) in an echo', cmd: 'echo "$(echo x > f)"', deny: /shell write to 'f'/ },
  { name: 'redirect after an escaped quote', cmd: 'echo \\" > src/a.ts', deny: /shell write to 'src\/a\.ts'/ },
  { name: 'echo "x\\"y" > f', cmd: 'echo "x\\"y" > f', deny: /shell write to 'f'/ },
  { name: 'unbalanced quote does not hide the write', cmd: 'echo "x > f', deny: /shell write to 'f'/ },
  { name: "odd quote of the other kind", cmd: `echo 'a " b' > src/a.ts; echo "c"`, deny: /shell write to 'src\/a\.ts'/ },
  { name: 'second redirect of two', cmd: 'echo x > $TMPDIR/ok > src/a.ts', deny: /shell write to 'src\/a\.ts'/ },
  { name: 'tee -- -name: the dash-name after -- is a file', cmd: 'echo x | tee -- -src/a.ts', deny: /shell write to '-src\/a\.ts'/ },
  { name: 'tee with one repo file among scratch ones', cmd: 'echo x | tee $TMPDIR/ok src/a.ts', deny: /shell write to 'src\/a\.ts'/ },
  { name: 'tee to an unresolvable VAR', cmd: 'echo x | tee $UNSET/f', deny: /shell write/ },
  { name: 'wrapper: bash -c to an unresolvable VAR', cmd: 'bash -c "echo x > $UNSET/f"', deny: /shell write/ },
  { name: 'wrapper: eval cd does not leak out of the eval', cmd: 'D=$TMPDIR/s; eval "cd $D"; echo x > f', deny: /shell write to 'f'/ },
  { name: 'wrapper: eval "… > repo"', cmd: 'eval "echo x > src/a.ts"', deny: /shell write to 'src\/a\.ts'/ },
  { name: 'wrapper: ssh host "…> repo"', cmd: 'ssh -p 22 h "echo x > src/a.ts"', deny: /shell write/ },
  { name: 'wrapper: sudo bash -c', cmd: 'sudo bash -c "echo x > src/a.ts"', deny: /shell write/ },
  { name: 'sed -i on a repo file', cmd: 'sed -i s/a/b/ src/a.ts', deny: /sed -i edits files in place/ },
  { name: 'sed -i, one repo operand among scratch ones', cmd: 'sed -i s/a/b/ $TMPDIR/ok src/a.ts', deny: /sed -i edits files in place/ },
  { name: 'sed -i with NO file operand', cmd: 'sed -i s/a/b/', deny: /sed -i edits files in place/ },
  { name: 'sed -i.bak on a repo file', cmd: 'sed -i.bak s/a/b/ src/a.ts', deny: /sed -i edits files in place/ },
  { name: 'sed --in-place=.b on a repo file', cmd: 'sed --in-place=.b s/a/b/ src/a.ts', deny: /sed -i edits files in place/ },
  { name: 'sed -i -e SCRIPT on a repo file', cmd: 'sed -i -e s/a/b/ src/a.ts', deny: /sed -i edits files in place/ },
  { name: 'sed -i -f scratch-script on a repo file', cmd: 'sed -i -f $TMPDIR/s.sed src/a.ts', deny: /sed -i edits files in place/ },
  { name: 'sed -ni (cluster) on a repo file', cmd: 'sed -ni 1p src/a.ts', deny: /sed -i edits files in place/ },
  { name: 'sed -i on an unresolvable VAR', cmd: 'sed -i s/a/b/ $UNSET/f', deny: /sed -i edits files in place/ },
  { name: 'sed -i inside bash -c', cmd: 'bash -c "sed -i s/a/b/ src/a.ts"', deny: /sed -i edits files in place/ },
  { name: 'sed -i after sudo/env wrappers', cmd: 'sudo env FOO=1 sed -i s/a/b/ src/a.ts', deny: /sed -i edits files in place/ },
  { name: 'sed -i on a relative file with the cwd in the repo', cmd: 'sed -i s/a/b/ f', deny: /sed -i edits files in place/ },
];
const WRITE_ROLES = ['coordinator', 'verifier', 'reviewer'] as const;

function probeBad(script: string, tag: string, firstOnly = false, roles: readonly string[] = WRITE_ROLES): string[] {
  const bad: string[] = [];
  for (const role of roles) {
    const w = install(script, role, `${tag}-${role}`);
    const check = (p: Probe, wantDeny: boolean) => {
      const env = p.env && Object.fromEntries(Object.entries(p.env).map(([k, v]) => [k, v.split(WT).join(w)]));
      const r = run(w, p.cmd, { cwd: p.cwd, tmpdir: p.tmpdir, env });
      const ok = wantDeny ? r.code === 2 && (!p.deny || p.deny.test(r.err)) && r.err.includes(`role: ${role}`) : r.code === 0 && r.err === '';
      if (!ok) bad.push(`${role}: ${wantDeny ? 'DENY' : 'ALLOW'} ${p.name} → rc=${r.code} ${r.err.slice(0, 100)}`);
      return ok;
    };
    for (const p of ALLOW) if (!check(p, false) && firstOnly) return bad;
    for (const p of DENY) if (!check(p, true) && firstOnly) return bad;
  }
  return bad;
}
function fixtureBad(script: string, tag: string, firstOnly = false): string[] {
  const bad: string[] = [];
  for (const c of cases) {
    const w = install(script, c.role, `${tag}-f-${c.role}`);
    const a = run(w, c.command, { cwd: c.cwd, tmpdir: c.tmpdir });
    if (a.code !== 0) { bad.push(`${c.id}: allow-arm rc=${a.code} ${a.err.slice(0, 100)}`); if (firstOnly) return bad; }
    for (const s of c.siblings) {
      const r = run(w, sibCommand(c, s), { cwd: c.cwd, tmpdir: c.tmpdir });
      if (r.code !== 2) { bad.push(`${c.id}: sibling "${s.name}" rc=${r.code}`); if (firstOnly) return bad; }
    }
  }
  return bad;
}

test('probes: every ALLOW shape is allowed and every DENY shape denied, for coordinator / verifier / reviewer', () => {
  assert.deepEqual(probeBad(ROLE_GUARD_SCRIPT, 'probe'), []);
});
test('probes are NOT vacuous: the pre-#475 guard fails the ALLOW arms that are this ticket\'s false positives', () => {
  const bad = probeBad(PRE475, 'probe-pre');
  const falsePositives = bad.filter((b) => b.includes(': ALLOW ')).length;
  assert.ok(falsePositives >= 20 * WRITE_ROLES.length / 2, `pre-#475 must fail many ALLOW probes, failed ${falsePositives}`);
});
test('the implementer (no write guard) and a role-less workspace are untouched', () => {
  const w = install(ROLE_GUARD_SCRIPT, 'implementer', 'impl');
  assert.equal(run(w, 'echo x > src/a.ts; sed -i s/a/b/ src/a.ts').code, 0);
});

// ---- gate FAIL round (verifier comment 7027396632 + bypass review 7027216694): every shape below REALLY writes into the repo dir when run in bash -------------
// Ground truth: the command is executed by real bash in a sandbox (cwd + TMPDIR as the hook payload says) and a file must land in the repo dir;
// the guard (live script) must DENY the same command and the frozen pre-#475 guard (= master) does too (so none of these is a NEW deny→allow).
import { execFileSync } from 'node:child_process';
const SBX = path.join(root, 'sbx');
const SBX_REPO = path.join(SBX, 'repo');
const SBX_SCR = path.join(SBX, 'scr');
interface GroundTruth { name: string; cmd: string; cwd: 'repo' | 'scr'; landed?: string; landedAny?: boolean; masterAllows?: boolean; setup?: () => void; env?: Record<string, string> }
const sub = (s: string) => s.split('@REPO@').join(SBX_REPO).split('@SCR@').join(SBX_SCR);
const ln = (from: string, to: string) => () => fs.symlinkSync(sub(from), sub(to));
const GT: GroundTruth[] = [
  { name: 'word split of a resolved value (tee $V)', cmd: 'V="@SCR@/a @REPO@/b"; echo x | tee $V', cwd: 'scr', landed: 'b' },
  { name: 'brace expansion in a target', cmd: 'echo x | tee {@SCR@/a,@REPO@/b}', cwd: 'scr', landed: 'b' },
  { name: 'last component = $(cmd) output with ..', cmd: 'S=$TMPDIR/w; mkdir -p $S; echo x > $S/$(echo ../../repo/a)', cwd: 'scr', landed: 'a' },
  { name: 'last component = for-loop word with ..', cmd: 'S=$TMPDIR/w; mkdir -p $S; for f in ../../repo/a; do echo x > $S/$f; done', cwd: 'scr', landed: 'a' },
  { name: 'last component = read word', cmd: 'S=$TMPDIR/w; mkdir -p $S; echo ../../repo/a | { read f; echo x > $S/$f; }', cwd: 'scr', landed: 'a' },
  { name: 'last component = backticks output', cmd: 'S=$TMPDIR/w; mkdir -p $S; echo x > $S/`echo ../../repo/a`', cwd: 'scr', landed: 'a' },
  { name: 'eval reassigns a scratch VAR', cmd: 'P=$TMPDIR/ok; eval "P=@REPO@"; echo x > $P/a', cwd: 'scr', landed: 'a' },
  { name: 'function reassigns a scratch VAR', cmd: 'P=$TMPDIR/ok; f(){ P=@REPO@; }; f; echo x > $P/a', cwd: 'scr', landed: 'a' },
  { name: 'VAR reassigned AFTER the function that uses it is defined', cmd: 'S=@SCR@; f(){ echo x > $S/x; }; S=@REPO@; f', cwd: 'scr', landed: 'x' },
  { name: 'function cd moves the shell', cmd: 'cd @SCR@; f(){ cd @REPO@; }; f; echo x > a.js', cwd: 'scr', landed: 'a.js' },
  { name: 'eval cd moves the shell', cmd: 'cd @SCR@; eval "cd @REPO@"; echo x > a.js', cwd: 'scr', landed: 'a.js' },
  { name: 'source of a script that cds', cmd: 'cd @SCR@; source ./cd.sh; echo x > a.js', cwd: 'scr', landed: 'a.js', setup: () => fs.writeFileSync(path.join(SBX_SCR, 'cd.sh'), `cd ${SBX_REPO}\n`) },
  { name: '. (dot) of a script that cds', cmd: 'cd @SCR@; . ./cd.sh; echo x > a.js', cwd: 'scr', landed: 'a.js', setup: () => fs.writeFileSync(path.join(SBX_SCR, 'cd.sh'), `cd ${SBX_REPO}\n`) },
  { name: 'CDPATH redirects a relative cd', cmd: 'cd @SCR@; CDPATH=@REPO@ cd src; echo x > a.js', cwd: 'scr', landed: 'src/a.js' },
  { name: 'declare -n nameref re-points a scratch VAR', cmd: 'P=$TMPDIR/ok; declare -n P=Q; Q=@REPO@; echo x > $P/a', cwd: 'scr', landed: 'a' },
  { name: 'symlink in scratch → repo (relative target)', cmd: 'echo x > link/a', cwd: 'scr', landed: 'a', setup: ln('@REPO@', '@SCR@/link') },
  { name: 'symlink in scratch → repo ($TMPDIR target)', cmd: 'echo x > $TMPDIR/link/a', cwd: 'repo', landed: 'a', masterAllows: true, setup: ln('@REPO@', '@SCR@/link') },
  { name: 'sed s///w FILE', cmd: "printf 'x\\n' > @SCR@/f; sed -i 's/x/y/w @REPO@/pwn' @SCR@/f", cwd: 'scr', landed: 'pwn' },
  { name: 'sed s///e executes', cmd: "echo 'touch @REPO@/p2' > @SCR@/f; sed -i -e 's/^t/t/e' @SCR@/f", cwd: 'scr', landed: 'p2' },
  { name: 'mktemp after TMPDIR was reassigned here', cmd: 'TMPDIR=@REPO@; f=$(mktemp); echo x > $f', cwd: 'scr', landedAny: true },
  { name: 'prefix assignment does not outlive its command', cmd: 'RGV_W=@SCR@/x true; echo x > $RGV_W/f', cwd: 'scr', landed: 'f', env: { RGV_W: '@REPO@' } },
  { name: 'quoted } inside a brace default does not desync the lexer', cmd: "echo ${X:-'}'}; echo hi > src/f; echo 'x'", cwd: 'repo', landed: 'src/f' },
];
const gtSandbox = (g: GroundTruth) => {
  fs.rmSync(SBX, { recursive: true, force: true });
  fs.mkdirSync(path.join(SBX_REPO, 'src'), { recursive: true });
  fs.mkdirSync(SBX_SCR, { recursive: true });
  g.setup?.();
};
const gtEnv = (g: GroundTruth) => Object.fromEntries(Object.entries(g.env ?? {}).map(([k, v]) => [k, sub(v)]));
for (const g of GT) {
  test(`REAL bash writes into the repo, the guard DENIES it (master did too): ${g.name}`, () => {
    gtSandbox(g);
    const before = fs.readdirSync(SBX_REPO).length;
    spawnSync('bash', ['-c', sub(g.cmd)], { cwd: g.cwd === 'repo' ? SBX_REPO : SBX_SCR, env: { PATH: process.env.PATH, HOME: home, TMPDIR: SBX_SCR, ...gtEnv(g) }, encoding: 'utf8', timeout: 20_000 });
    if (g.landed) assert.ok(fs.existsSync(path.join(SBX_REPO, g.landed)), `ground truth: ${g.landed} must land in the repo dir when bash runs this`);
    if (g.landedAny) assert.ok(fs.readdirSync(SBX_REPO).length > before, 'ground truth: something must land in the repo dir');
    for (const [label, script] of [['live', ROLE_GUARD_SCRIPT], ['master', PRE475]] as const) {
      gtSandbox(g);
      const r = run(install(script, 'verifier', `gt-${label}`), sub(g.cmd), { cwd: g.cwd === 'repo' ? SBX_REPO : SBX_SCR, tmpdir: SBX_SCR, env: gtEnv(g) });
      if (label === 'master' && g.masterAllows) continue; // parity with master (a literal $TMPDIR/link path already passed there), still closed by the live guard
      assert.equal(r.code, 2, `${label} guard must DENY (rc=${r.code}) ${r.err.slice(0, 120)}`);
    }
  });
}

function gtBad(script: string, tag: string): string[] {
  const bad: string[] = [];
  for (const g of GT) {
    gtSandbox(g);
    const r = run(install(script, 'verifier', `${tag}-gt`), sub(g.cmd), { cwd: g.cwd === 'repo' ? SBX_REPO : SBX_SCR, tmpdir: SBX_SCR, env: gtEnv(g) });
    if (r.code !== 2) { bad.push(`GT ${g.name} rc=${r.code}`); break; }
  }
  return bad;
}
test('a command past the size cap is denied BEFORE the scanner (mawk is quadratic: 3 MB took 109 s = hook timeout = fail-open)', () => {
  const big = (n: number) => 'echo hello world; '.repeat(Math.ceil(n / 18));
  for (const role of WRITE_ROLES) {
    const w = install(ROLE_GUARD_SCRIPT, role, `cap-${role}`);
    assert.equal(run(w, big(60_000)).code, 0, 'a 60 KB command (real max is 12.5 KB) still passes');
    const r = run(w, big(70_000));
    assert.equal(r.code, 2); assert.match(r.err, /too large/);
  }
  assert.equal(run(install(ROLE_GUARD_SCRIPT, 'implementer', 'cap-impl'), big(70_000)).code, 0, 'no write check, no cap');
  const noCap = ROLE_GUARD_SCRIPT.replace('-gt 65536 ]', '-gt 65536000 ]');
  assert.notEqual(noCap, ROLE_GUARD_SCRIPT);
  assert.equal(run(install(noCap, 'verifier', 'cap-mut'), big(70_000)).code, 0, 'without the cap the same command is not refused — the arm above can fail');
  // 3 MB through the real mawk when the host has one (Ubuntu/Debian default awk), the default awk otherwise: denied fast either way
  const mawk = spawnSync('bash', ['-c', 'command -v mawk'], { encoding: 'utf8' }).stdout.trim();
  const shim = path.join(root, 'shim-awk');
  fs.mkdirSync(shim, { recursive: true });
  if (mawk) fs.symlinkSync(mawk, path.join(shim, 'awk'), 'file');
  const t0 = Date.now();
  const r3 = run(install(ROLE_GUARD_SCRIPT, 'verifier', 'cap-3mb'), big(3_000_000), { env: mawk ? { PATH: `${shim}:${process.env.PATH}` } : {} });
  assert.equal(r3.code, 2); assert.match(r3.err, /too large/);
  assert.ok(Date.now() - t0 < 15_000, `3 MB must be refused fast (${Date.now() - t0} ms, awk=${mawk || 'default'})`);
});

test('a scanner crash is LOUD (deny), never a silent fail-open', () => {
  const broken = ROLE_GUARD_SCRIPT.replace('RG_CWD="$cwd" awk "$awk_writes"', 'RG_CWD="$cwd" awk "$awk_writes BROKEN ("');
  assert.notEqual(broken, ROLE_GUARD_SCRIPT);
  const r = run(install(broken, 'verifier', 'crash'), 'echo x > src/a.ts');
  assert.equal(r.code, 2);
  assert.match(r.err, /write scanner could not run/);
  const quiet = broken.replace('if [ "$wrc" != 0 ]', 'if false');
  assert.equal(run(install(quiet, 'verifier', 'crash-quiet'), 'echo x > src/a.ts').code, 0, 'the same crash with the check removed is silent — the arm above can fail');
});

// ---- MUTANTS: each breaks ONE clause of the new scanner; the fixture + probes must redden (baseline clean) ----------------------
test('baseline is clean; every #475 mutant reddens the fixture/probes', () => {
  assert.deepEqual(fixtureBad(ROLE_GUARD_SCRIPT, 'base'), []);
  const mutants: Array<[string, string, string]> = [
    ['an escaped quote inside a quoted string ends it (the trial bug)', 'if (c2 == "\\"" || c2 == "\\\\" || c2 == "$"', 'if (c2 == "\\\\" || c2 == "$"'],
    ['a quoted string is never parsed as one (angle text reads as a redirect)', 'if (c == "\\"") { wq = 1; dqparse(); continue }', 'if (c == "\\"") { P++; continue }'],
    ['$VAR never resolves (scratch VAR targets denied)', 'if (nm in vals) return (vpoison[nm]) ? UNRES : vals[nm]', 'if (nm in vals) return UNRES'],
    ['$VAR from the hook env never resolves', 'if ((nm in ENVIRON) && ENVIRON[nm] != "") return ENVIRON[nm]', ''],
    ['an unresolvable word counts as scratch (fail open)', 'if (br || index(v, UNRES)) { emit(kind, disp); return }', 'if (br) { emit(kind, disp); return }'],
    ['a nested $( ) overwrites the outer word (its value leaks into the target)', 'scope_out()\n    wv = a; wd = b; wq = c; wany = d; bd = g\n    inner', 'scope_out()\n    inner'],
    ['VAR += is an ordinary assignment', 'poisonvar(nm); return }\n  sub("=.*$", "", nm)', 'return }\n  sub("=.*$", "", nm)'],
    ['cd … || true keeps the cwd', 'if (rest !~ "^(exit|return)([ ;&|)]|$)") cwd = ""', ''],
            ['a shell -c only counts at command position (docker run … sh -c "…" hidden)', 'for (j = i; j <= k; j++) {\n    nm = CW[f, j]', 'for (j = i; j <= i; j++) {\n    nm = CW[f, j]'],
    ['a re-assigned VAR keeps its last value (no poison)', 'vpoison[nm] = 1\n  vals[nm] = v', 'vals[nm] = v'],
    ['cd is not tracked (relative target after a scratch cd denied)', '  cwd = absp(tgt)\n', '  cwd = cwd\n'],
    ['a relative target resolves as scratch', '  return norm(cwd "/" t)\n}', '  return norm("/tmp/" t)\n}'],
    ['an unknown cwd resolves relative targets as scratch', '  if (cwd == "") return ""\n', '  if (cwd == "") return "/tmp/x"\n'],
    ['.. is not collapsed (escapes through $TMPDIR/..)', 'if (a[i] == "..") { if (k > 0) k--; continue }', ''],
    ['a subshell cd/vars leak out', 'scope_in()\n      parse_seq(")")\n      scope_out()\n      continue', 'parse_seq(")")\n      continue'],
    ['a resolved value with spaces / braces is still a path (word split / brace re-expansion)', 'function san(v) { return (v ~ "[ \\t{}]") ? UNRES : v }', 'function san(v) { return v }'],
    ['an unquoted brace in a tee/sed/redirect word is ignored', 'judge("W", CD[f, j], CW[f, j], CB[f, j])', 'judge("W", CD[f, j], CW[f, j], 0)'],
    ['eval does not poison variables / cwd', 'if (sk != "") run_code(sk)\n    poison_all()', 'if (sk != "") run_code(sk)'],
    ['source / . does not poison variables / cwd', 'if (base == "source" || base == ".") { poison_all(); return }', 'if (base == "source" || base == ".") { return }'],
    ['declare -n does not poison variables', 'if (CW[f, j] ~ "^-[a-zA-Z]*n") poison_all()', ''],
    ['CDPATH is ignored by cd', 'if (cdpath && substr(tgt, 1, 1) != "/") { cwd = ""; return }', ''],
    ['function positional parameters are not bound', 'for (p = 1; p <= 9 && i + p <= k; p++) POS[p] = CW[f, i + p]', ''],
    ['a function call does not run its body at the call site', 'FNact[nm] = 1; run_code(FNbody[nm]); FNact[nm] = 0', 'FNact[nm] = 1; FNact[nm] = 0'],
    ['a function call does not apply its variable effects', 'm = split(FNvars[nm], a, " ")', 'm = 0'],
    ['a function call does not apply its cd effect', 'if (FNcd[nm]) { cwd = ""', 'if (0) { cwd = ""'],
    ['a prefix assignment outlives its command', 'if (n == 0 || n == k) { process_cmd2(f, k, term, inpipe_cmd); return }', 'if (1) { process_cmd2(f, k, term, inpipe_cmd); return }'],
    ['sed w/e commands and -f scripts are not looked at', 'if (ffile || scr ~', 'if (0 && scr ~'],
    ['mktemp counts as scratch even after TMPDIR was reassigned', 'if (!("TMPDIR" in vals) && (inner ~', 'if ((inner ~'],
    ['a quote inside a brace expansion is not honoured', 'if (ch == "\'" || ch == "\\"") { mode = ch; continue }', ''],
    ['the symlink check is advisory only', '[ "$okp" = 1 ] || deny', '[ "$okp" = 1 ] || true'],
    ['a scope exit (subshell / $( ) / function / eval) keeps the inner cwd', 'cwd = SNC[sd]\n', '\n'],
    ['a scope exit keeps the inner variables', 'split("", vals); split("", vpoison)\n', '\n'],
    ['subshell ((…;…)) is skipped as arithmetic', 'if (index(body, ";") || index(body, "$(") || index(body, "\\140")) return 0\n', '\n'],
    ['a piped / backgrounded cd moves the shell', 'if (inpipe_cmd || (t1 == "|" && t2 != "|") || (t1 == "&" && t2 != "&")) { cwd = old; return }', ''],
    ['unset keeps the old value', 'if (base == "unset") {', 'if (base == "unset-x") {'],
    ['printf -v keeps the old value', 'if (base == "printf") {', 'if (base == "printf-x") {'],
    ['VAR[i]= keeps the old value', 'if (nm ~ "^[A-Za-z_][A-Za-z0-9_]*[[]") { sub("[[].*$", "", nm); poisonvar(nm); return }', ''],
    ['~user resolves as a relative path', '      wany = 1; wv = UNRES; wd = "~"; P++; continue', ''],
    ['ANSI-C quoting resolves as a literal', 'if (e > 0) { wv = wv UNRES; wd = wd substr(S, P, e + 2); P += e + 2; return }', 'if (e > 0) { wv = wv substr(S, P + 2, e - 1); wd = wd substr(S, P, e + 2); P += e + 2; return }'],
    ['an unknown var takes its :- default', 'if (index(v, UNRES) == 0 && v == "")', 'if (v == "" || index(v, UNRES))'],
    ['an arbitrary command substitution counts as a safe component (mktemp/date only)', '"/.mktemp"\n  return UNRES', '"/.mktemp"\n  return "/var/tmp/.mktemp"'],
    ['the scan has no budget (exponential on nested unterminated quotes)', 'BUDGET = 300000;', 'BUDGET = 3000000000000;'],
    ['a $( ) body is not scanned (data)', 'scope_in()\n    parse_seq(")")\n    scope_out()\n    wv = a', 'scope_in()\n    while (P <= N && substr(S, P, 1) != ")") P++; P++\n    scope_out()\n    wv = a'],
        ['the payload cwd is ignored', 'cwd = envget("RG_CWD")', 'cwd = ""'],
    ['sed -i operands are never judged', 'judge("SEDI", CD[f, idx[j]], CW[f, idx[j]], CB[f, idx[j]])', 'nf = nf'],
    ['sed -i on a scratch file is still denied', 'if (!inpl) return\n  if (!haveS', 'if (!inpl) return\n  emit("SEDI", "x")\n  if (!haveS'],
    ['sed -i.bak is not an in-place edit', 'if (w ~ "^-[a-zA-Z]*i") inpl = 1', 'if (w ~ "^-[a-zA-Z]*i$") inpl = 1'],
    ['sed -i with no file operand is allowed', 'if (nf == 0) emit("SEDI", "(no file operand)")', ''],
    ['-e scripts are mistaken for the file list', 'else if (w ~ "^-[a-zA-Z]*e$") { haveS = 1; j++; scr = scr " " CW[f, j] }', ''],
    ['a for loop over non-literal words keeps the old value', 'if (safe) setvar(nm, first); else poisonvar(nm)', 'if (safe) setvar(nm, first)'],
    ['eval code is never scanned', 'if (sk != "") run_code(sk)', ''],
    ['ssh remote command is never scanned', 'if (code != "") run_code(code)', ''],
    ['TMPDIR from the hook env is not the role\'s scratch', 'if (TMPD != "" && under(p, TMPD)) return 1', ''],
  ];
  for (const [name, from, to] of mutants) {
    assert.ok(ROLE_GUARD_SCRIPT.includes(from), `mutant "${name}": anchor not found in the live script`);
    const m = ROLE_GUARD_SCRIPT.replace(from, to);
    assert.notEqual(m, ROLE_GUARD_SCRIPT);
    const viaFixture = fixtureBad(m, `m${name.length}`, true);
    const viaGt = viaFixture.length ? viaFixture : gtBad(m, `mg${name.length}`);
    const bad = viaGt.length ? viaGt : probeBad(m, `mp${name.length}`, true, ['verifier']); // a mutant only has to redden ONE role
    assert.ok(bad.length > 0, `mutant "${name}" survived — neither the fixture nor the probes can see it`);
  }
});
