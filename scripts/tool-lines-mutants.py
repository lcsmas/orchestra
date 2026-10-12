#!/usr/bin/env python3
"""#374 desktop tool lines: break each changed clause in place, run the suite that owns it, require RED, restore byte-exact (backup + cmp).
Usage: python3 -I scripts/tool-lines-mutants.py [id-prefix ...]            (repo root; no argument = every unit/SSR mutant)
       E2E_RIG_BASE=<scratch> python3 -I scripts/tool-lines-mutants.py --e2e [id-prefix ...]
                                      (BUILT-APP mutants: copy the tree under $TOOL_LINES_E2E_SCRATCH, mutate, rebuild, run scripts/e2e-tool-lines.sh,
                                       require the named L-clause red. HEAVY RIG: needs the fleet token + MemAvailable > 6 GB)
The phone-side clauses of the same change (the projection calling the shared toolLine, the glyph injection) live in scripts/acces-mobile-mutants.py (T*)."""
import os, shutil, subprocess, sys, filecmp

ROOT = os.getcwd()
TL = 'src/shared/tool-line.test.ts'
RI = 'src/shared/agent-render-items.test.ts'
AC = 'src/renderer/components/agent/agent-components.test.ts'
SMOKE = 'scripts/tool-lines-render-smoke.mjs'   # judged with `node <file>`, not node --test
# (id, file, original, replacement, suite)
MUTANTS = [
    ('D1-state-running-as-ok', 'src/shared/tool-line.ts', "return !m.toolResult ? 'running' :", "return !m.toolResult ? 'ok' :", TL),
    ('D2-state-error-as-ok', 'src/shared/tool-line.ts', "m.toolResult.isError ? 'error' : 'ok'", "m.toolResult.isError ? 'ok' : 'ok'", TL),
    ('D3-glyph-error-is-tick', 'src/shared/tool-line.ts', "error: '✗' }", "error: '✓' }", TL),
    ('D4-glyph-running-is-tick', 'src/shared/tool-line.ts', "running: '…',", "running: '✓',", TL),
    ('D5-label-ignores-tool-name', 'src/shared/tool-line.ts', "toolLabel(m.toolUse?.name || 'tool', m.toolUse?.input)", "toolLabel('tool', m.toolUse?.input)", TL),
    ('D6-builder-own-label-no-state', 'src/shared/agent-render-items.ts', "rows: run.map((message) => ({ id: message.id, ...toolLine(message), message })),", "rows: run.map((message) => ({ id: message.id, label: message.toolUse?.name ?? 'tool', state: 'ok' as const, message })),", RI),
    ('D7-builder-todowrite-folded', 'src/shared/agent-render-items.ts', "m.toolUse?.name === 'TodoWrite'", "m.toolUse?.name === 'TodoWriteX'", RI),
    ('D8-builder-group-id-unstable', 'src/shared/agent-render-items.ts', "id: `tg:${run[0].id}`,\n        rows:", "id: `tg:${run[run.length - 1].id}`,\n        rows:", RI),
    ('D9-builder-run-never-flushed-by-text', 'src/shared/agent-render-items.ts', "      flush();\n      const divider =\n        m.role === 'user'", "      const divider =\n        m.role === 'user'", RI),
    ('D10-builder-lone-tool-dropped', 'src/shared/agent-render-items.ts', "if (run && run.length > 0) {\n      items.push({\n        kind: 'tool-group',", "if (run && run.length > 1) {\n      items.push({\n        kind: 'tool-group',", RI),
    ('D11-empty-tool-name-blank-label', 'src/shared/tool-line.ts', "m.toolUse?.name || 'tool'", "m.toolUse?.name ?? 'tool'", TL),
    ('D12-skill-label-wrong-key', 'src/shared/tool-line.ts', "detail = s('skill');", "detail = s('name');", TL),
    # (no mutant for the `label`/`state` terms of toolRowsEqual: both are derived from message fields toolMessageEqual already compares — defense in depth, equivalent by construction)
    ('R2-memo-ignores-message', 'src/renderer/components/agent/tool-util.ts', " || !toolMessageEqual(a[i].message, b[i].message)) return false;", ") return false;", AC),
    ('F1a-oneline-unbounded', 'src/shared/tool-line.ts', "let window = Math.max(512, n * 8);", "let window = Infinity;", TL),
    ('F1b-oneline-stops-too-early', 'src/shared/tool-line.ts', "if (head === s || t.length > n) return", "if (head === s || t.length > 0) return", TL),
    ('F1c-oneline-window-capped', 'src/shared/tool-line.ts', "    window *= 4;\n", "    window *= 4;\n    if (window > 4000) return { text: clip(t, n), scanned: head.length };\n", TL),
    ('S7-ssr-card-pending-old-rule', 'src/renderer/components/agent/ToolCard.tsx', "toolState(message) === 'running'", "(!result && !message.done)", SMOKE),
    ('S1-ssr-glyph-not-from-state', 'src/renderer/components/agent/ToolGroup.tsx', "{TOOL_GLYPH[r.state]}", "{TOOL_GLYPH.ok}", SMOKE),
    ('S2-ssr-open-by-default', 'src/renderer/components/agent/ToolGroup.tsx', "useState<ReadonlySet<string>>(() => new Set(defaultOpenIds))", "useState<ReadonlySet<string>>(() => new Set(rows.map((r) => r.id)))", SMOKE),
    ('S3-ssr-state-class-dropped', 'src/renderer/components/agent/ToolGroup.tsx', "className={`av-tool-line av-tool-line-${r.state} ${isOpen", "className={`av-tool-line ${isOpen", SMOKE),
    ('S4-ssr-label-hidden', 'src/renderer/components/agent/ToolGroup.tsx', "<span className=\"av-tool-line-label\">{r.label}</span>", "<span className=\"av-tool-line-label\" />", SMOKE),
    ('S5-ssr-card-mounted-while-closed', 'src/renderer/components/agent/ToolGroup.tsx', "{isOpen && (\n              <div className=\"av-tool-line-body\">", "{(\n              <div className=\"av-tool-line-body\">", SMOKE),
    ('S6-ssr-open-card-not-startopen', 'src/renderer/components/agent/ToolGroup.tsx', "<ToolCard message={r.message} startOpen />", "<ToolCard message={r.message} />", SMOKE),
]
# Built-app mutants: (id, file, original, replacement, clause that must go red)
E2E_MUTANTS = [
    ('E1-toggle-never-closes', 'src/renderer/components/agent/ToolGroup.tsx', "if (!next.delete(id)) next.add(id);", "next.add(id);", 'L5'),
    ('E2-error-line-not-red', 'src/renderer/agent-view-theme.css', ".av-tool-line-error .av-tool-line-head,\n.av-tool-line-error .av-tool-line-glyph { color: var(--av-error); }", ".av-tool-line-error .av-tool-line-head,\n.av-tool-line-error .av-tool-line-glyph { color: var(--av-text-faint); }", 'L3'),
    ('E3-ok-glyph-not-green', 'src/renderer/agent-view-theme.css', ".av-tool-line-ok .av-tool-line-glyph { color: var(--av-add); }", ".av-tool-line-ok .av-tool-line-glyph { color: var(--av-text-faint); }", 'L3'),
    ('E4-card-not-startopen', 'src/renderer/components/agent/ToolCard.tsx', "  const defaultOpen =\n    startOpen ||\n", "  const defaultOpen =\n", 'L5'),
    ('E5-running-line-not-accent', 'src/renderer/agent-view-theme.css', ".av-tool-line-running .av-tool-line-glyph { color: var(--av-tool-active); }", ".av-tool-line-running .av-tool-line-glyph { color: var(--av-text-faint); }", 'L3'),
    ('E6-block-not-compact-one-per-block', 'src/shared/agent-render-items.ts', "if (m.role === 'tool' && !isStandaloneTool(m)) {\n      (run ??= []).push(m);", "if (m.role === 'tool' && !isStandaloneTool(m)) {\n      flush();\n      (run ??= []).push(m);", 'L1'),
    ('E7-summary-row-back', 'src/renderer/components/agent/ToolGroup.tsx', "    <div className=\"av-tool-run\">\n      {rows.map", "    <div className=\"av-tool-run\">\n      <span>Used {rows.length} tools</span>\n      {rows.map", 'L4'),
    ('E9-memo-always-equal', 'src/renderer/components/agent/ToolGroup.tsx', "(a, b) => toolRowsEqual(a.rows, b.rows)", "() => true", 'L8'),
    ('E8-todowrite-folded-into-block', 'src/shared/agent-render-items.ts', "m.toolUse?.name === 'TodoWrite'", "m.toolUse?.name === 'TodoWriteX'", 'G6'),
]

def run_suite(suite):
    cmd = ['node', suite] if suite.endswith('.mjs') else ['node', '--test', '--experimental-strip-types', suite]
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=240)

def summary(r, suite):
    if suite.endswith('.mjs'):
        fails = [l.strip() for l in r.stdout.splitlines() if l.strip().startswith('FAIL')]
        return fails[0][:100] if fails else 'no FAIL line', 0
    fl = [l for l in r.stdout.splitlines() if l.startswith('# fail ')]
    sk = [l for l in r.stdout.splitlines() if l.startswith('# skipped ')]
    return (fl[0] if fl else 'no summary'), (0 if sk == ['# skipped 0'] else 1)

def run_unit(ids):
    sel = [m for m in MUTANTS if not ids or any(m[0].startswith(i) for i in ids)]
    if not sel: print('no mutant matches', ids); sys.exit(2)
    bad = 0
    for mid, rel, old, new, suite in sel:
        path = os.path.join(ROOT, rel); backup = path + '.mutant-backup'
        src = open(path).read()
        if src.count(old) != 1: print(f'{mid}: ANCHOR NOT FOUND (count={src.count(old)}) — instrument broken'); bad += 1; continue
        shutil.copy2(path, backup)
        try:
            open(path, 'w').write(src.replace(old, new))
            try: r = run_suite(suite); red = r.returncode != 0; info, _ = summary(r, suite)
            except subprocess.TimeoutExpired: red = False; info = 'HUNG — a hang is not a kill'
            print(f'{mid}: {"RED" if red else "GREEN"} ({info}) {"OK" if red else "SURVIVED"}')
            if not red: bad += 1
        finally:
            shutil.copy2(backup, path)
            same = filecmp.cmp(backup, path, shallow=False); os.remove(backup)
            if not same: print(f'{mid}: RESTORE FAILED (cmp)'); bad += 1
    # control: each suite is GREEN and unskipped when unmutated (a red/skipped suite proves nothing)
    for suite in sorted({m[4] for m in sel}):
        r = run_suite(suite); info, skipped = summary(r, suite)
        ok = r.returncode == 0 and not skipped
        print(f'CONTROL unmutated {suite}: {"GREEN" if ok else "RED"} ({info})'); bad += 0 if ok else 1
    print('CLEAN' if bad == 0 else f'DIRTY ({bad})'); sys.exit(1 if bad else 0)

def run_e2e(ids):
    base = os.environ.get('TOOL_LINES_E2E_SCRATCH') or os.path.expanduser('~/.cache/tool-lines-e2e-mutants')
    os.makedirs(base, exist_ok=True); bad = 0
    sel = [m for m in E2E_MUTANTS if not ids or any(m[0].startswith(i) for i in ids)]
    if not sel: print('no mutant matches', ids); sys.exit(2)
    for mid, rel, old, new, clause in sel:
        work = os.path.join(base, mid)
        subprocess.run(['rsync', '-a', '--delete', '--exclude', 'node_modules', '--exclude', '.git', '--exclude', 'dist', '--exclude', 'dist-electron', '--exclude', 'release', '--exclude', 'shots', ROOT + '/', work + '/'], check=True)
        if not os.path.lexists(os.path.join(work, 'node_modules')): os.symlink(os.path.join(ROOT, 'node_modules'), os.path.join(work, 'node_modules'))
        path = os.path.join(work, rel); src = open(path).read()
        if src.count(old) != 1: print(f'{mid}: ANCHOR NOT FOUND (count={src.count(old)})'); bad += 1; continue
        open(path, 'w').write(src.replace(old, new))
        b = subprocess.run('pnpm run build:bundles', shell=True, cwd=work, capture_output=True, text=True, timeout=600)
        if b.returncode != 0: print(f'{mid}: BUILD FAILED\n{b.stdout[-600:]}{b.stderr[-600:]}'); bad += 1; continue
        r = subprocess.run(['bash', os.path.join(work, 'scripts/e2e-tool-lines.sh'), work, '--label', mid, '--out', os.path.join(work, 'shots')], cwd=work, capture_output=True, text=True, timeout=900)
        out = r.stdout
        fails = [l.split('—')[0].strip()[6:] for l in out.splitlines() if l.startswith('  FAIL')]
        passes = sum(1 for l in out.splitlines() if l.startswith('  PASS'))
        if passes + len(fails) == 0: print(f'{mid}: INSTRUMENT BROKEN — no clause ran: {out[-400:]!r}'); bad += 1; continue
        hit = any(f.split('] ', 1)[-1].startswith(clause) for f in fails)
        ctl = [f for f in fails if '] ctl/' in f or '] rig/' in f]
        ok = hit and not ctl
        print(f'{mid}: {"RED" if fails else "GREEN"} on {fails} (expected {clause}; {passes} clauses passed) {"OK" if ok else "SURVIVED/WRONG-REASON"}')
        if not ok: bad += 1
    print('E2E CLEAN' if bad == 0 else f'E2E DIRTY ({bad})'); sys.exit(1 if bad else 0)

args = sys.argv[1:]
if '--e2e' in args: run_e2e([a for a in args if a != '--e2e'])
else: run_unit(args)
