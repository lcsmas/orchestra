#!/usr/bin/env node
// #476: per-workspace / per-role / per-model split of the vf2 trial's token usage.
// Usage: node scripts/vf2-trial/cache-split.mjs [projectsDir] [--json]
// Reads (never writes) ~/.claude-vf2/projects/<WORKSPACE-DIR>/**/*.jsonl, subagent sidechains included.
// Dedupe: one row per assistant message.id (a streamed message repeats once per content block;
// keep the copy with the largest output_tokens). Skips <synthetic> models.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const root = args.find((a) => !a.startsWith('--')) ?? join(homedir(), '.claude-vf2', 'projects')
const ROLES = ['ops', 'impl', 'verif', 'review', 'scribe', 'explo']

export function wsOfDir(dir) {
  const m = /(?:^|-)vf2-trial-(.+)-([0-9a-f]{8})$/.exec(dir) ?? /^(?:.*?)-([a-z]+-[\w-]*?)-([0-9a-f]{8})$/.exec(dir)
  const name = m ? m[1] : dir
  const id = m ? m[2] : dir.slice(-8)
  const prefix = name.split('-')[0]
  return { name, id, role: ROLES.includes(prefix) ? prefix : 'other' }
}

function* walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (p.endsWith('.jsonl')) yield p
  }
}

export function collect(projects, raw = { lines: 0, cacheRead: 0 }) {
  const best = new Map() // message.id -> {ws, model, u, sidechain}
  for (const dir of readdirSync(projects)) {
    const full = join(projects, dir)
    if (!statSync(full).isDirectory()) continue
    const ws = wsOfDir(dir)
    for (const f of walk(full)) {
      const sub = f.includes('/subagents/')
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.includes('"usage"')) continue
        let o
        try { o = JSON.parse(line) } catch { continue }
        const m = o.message
        if (o.type !== 'assistant' || !m?.usage || !m.id || !m.model || m.model === '<synthetic>') continue
        raw.lines++
        raw.cacheRead += m.usage.cache_read_input_tokens ?? 0
        const prev = best.get(m.id)
        if (!prev || (m.usage.output_tokens ?? 0) > (prev.u.output_tokens ?? 0)) {
          best.set(m.id, { ws, model: m.model, u: m.usage, sub })
        }
      }
    }
  }
  return [...best.values()]
}

export function summarize(rows) {
  const zero = () => ({ turns: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 })
  const add = (a, r) => {
    a.turns++
    a.input += r.u.input_tokens ?? 0
    a.output += r.u.output_tokens ?? 0
    a.cacheCreate += r.u.cache_creation_input_tokens ?? 0
    a.cacheRead += r.u.cache_read_input_tokens ?? 0
  }
  const total = zero(), byWs = new Map(), byRole = new Map(), byModel = new Map(), byRoleModel = new Map()
  const bump = (map, k, r) => { if (!map.has(k)) map.set(k, zero()); add(map.get(k), r) }
  for (const r of rows) {
    add(total, r)
    bump(byWs, `${r.ws.role}\t${r.ws.name}\t${r.ws.id}`, r)
    bump(byRole, r.ws.role, r)
    bump(byModel, r.model, r)
    bump(byRoleModel, `${r.ws.role}\t${r.model}`, r)
    if (r.sub) bump(byRole, `of which ${r.ws.role} subagent sidechains`, r)
  }
  return { total, byWs, byRole, byModel, byRoleModel }
}

/** Kind of one tool call; the first four are what a scribe-able loop is made of. */
export function kindOf(name, cmd = '') {
  if (name !== 'Bash') return name
  return /orchestra (send|check|ack|spawn|token|ask)\b/.test(cmd) ? 'fleet-mail'
    : /\bgh (issue|pr) (comment|edit)\b|ledger-set/.test(cmd) ? 'ledger-write'
    : /fanout state set/.test(cmd) ? 'state-set'
    : /\bgh (pr (checks|view|list)|run)\b/.test(cmd) ? 'ci-poll'
    : /orchestra (verify-landed|peers)|git (-C \S+ )?(log|status|ls-remote|rev-list)\b/.test(cmd) ? 'sweep'
    : 'other-bash'
}
const MECHANICAL = new Set(['ledger-write', 'state-set', 'ci-poll', 'sweep'])

/** Per-message view (deduped by message.id, tool kinds accumulated over the streamed lines), in file order. */
function messages(projects) {
  const out = []
  for (const dir of readdirSync(projects)) {
    const ws = wsOfDir(dir)
    for (const f of walk(join(projects, dir))) {
      if (f.includes('/subagents/')) continue
      const byId = new Map()
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.includes('"usage"')) continue
        let o
        try { o = JSON.parse(line) } catch { continue }
        const m = o.message
        if (o.type !== 'assistant' || !m?.usage || !m.id || m.model === '<synthetic>') continue
        let e = byId.get(m.id)
        if (!e) { e = { ws, file: f, read: m.usage.cache_read_input_tokens ?? 0, create: m.usage.cache_creation_input_tokens ?? 0, kinds: [] }; byId.set(m.id, e); out.push(e) }
        for (const b of m.content ?? []) if (b.type === 'tool_use' && !e.kinds.some((k) => k.id === b.id)) e.kinds.push({ id: b.id, kind: kindOf(b.name, b.input?.command ?? '') })
      }
    }
  }
  return out
}

/** OPS tool calls by kind; `scribeable` = ledger-write + state-set + ci-poll + sweep. */
export function opsCalls(projects) {
  const c = {}
  for (const e of messages(projects)) if (e.ws.role === 'ops') for (const k of e.kinds) c[k.kind] = (c[k.kind] ?? 0) + 1
  const total = Object.values(c).reduce((a, b) => a + b, 0)
  const scribeable = [...MECHANICAL].reduce((a, k) => a + (c[k] ?? 0), 0)
  return { total, scribeable, byKind: c }
}

/** The two figures the skill quotes, each a BOUND with its derivation (#476 review MINOR 4):
 *  - ceiling: OPS turns whose tool calls are ALL mechanical × the OPS mean cache-read per turn ÷ fleet cache-read (assumes every such turn vanishes, ignores the scribe seats' own cost);
 *  - lower bound of the static prefix: (turns − sessions) × the smallest first-turn read+create of any session ÷ fleet cache-read. */
export function bounds(projects) {
  const msgs = messages(projects)
  const total = msgs.reduce((a, e) => a + e.read, 0)
  const ops = msgs.filter((e) => e.ws.role === 'ops')
  const opsMean = ops.reduce((a, e) => a + e.read, 0) / (ops.length || 1)
  const mech = ops.filter((e) => e.kinds.length > 0 && e.kinds.every((k) => MECHANICAL.has(k.kind)))
  let runs = 0, prev = null
  for (const e of ops) { const isM = mech.includes(e); if (isM && prev !== true) runs++; prev = isM }
  const firsts = new Map()
  for (const e of msgs) if (!firsts.has(e.file)) firsts.set(e.file, e.read + e.create)
  const minPrefix = Math.min(...firsts.values())
  return {
    total,
    ceiling: { mechTurns: mech.length, runs, opsMeanRead: Math.round(opsMean), pct: (100 * mech.length * opsMean) / total },
    staticPrefix: { sessions: firsts.size, turns: msgs.length, minPrefix, pct: (100 * (msgs.length - firsts.size) * minPrefix) / total },
  }
}

const M = (n) => (n / 1e6).toFixed(2) + 'M'
function table(title, head, map, total) {
  const out = [`**${title}**`, '', `| ${head} | turns | input | output | cache-create | cache-read | share of cache-read |`, '|---|--:|--:|--:|--:|--:|--:|']
  for (const [k, v] of [...map].sort((a, b) => b[1].cacheRead - a[1].cacheRead)) {
    out.push(`| ${k.replace(/\t/g, ' / ')} | ${v.turns} | ${v.input} | ${v.output} | ${M(v.cacheCreate)} | ${M(v.cacheRead)} | ${((100 * v.cacheRead) / total.cacheRead).toFixed(1)}% |`)
  }
  return out.join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = { lines: 0, cacheRead: 0 }
  const rows = collect(root, raw)
  const s = summarize(rows)
  if (asJson) {
    const o = (m) => Object.fromEntries(m)
    console.log(JSON.stringify({ total: s.total, byWs: o(s.byWs), byRole: o(s.byRole), byModel: o(s.byModel), byRoleModel: o(s.byRoleModel) }, null, 1))
  } else {
    console.log(`positive control: RAW assistant lines ${raw.lines}, raw cache-read ${M(raw.cacheRead)} (the trial's ~623 / ~37M counted every streamed content-block line; each repeated line shares its requestId + usage, so the bill is the deduped figure)`)
    console.log(`messages (deduped by message.id): ${s.total.turns} · cache-read ${M(s.total.cacheRead)} · cache-create ${M(s.total.cacheCreate)} · output ${s.total.output} · input ${s.total.input}\n`)
    console.log(table('Per role', 'role', s.byRole, s.total), '\n')
    console.log(table('Per role × model', 'role / model', s.byRoleModel, s.total), '\n')
    console.log(table('Per workspace', 'role / name / ws id', s.byWs, s.total), '\n')
    console.log(table('Per model', 'model', s.byModel, s.total), '\n')
    const oc = opsCalls(root)
    console.log(`OPS tool calls: ${oc.total}, scribe-able (ledger-write + state-set + ci-poll + sweep): ${oc.scribeable} — ${JSON.stringify(oc.byKind)}`)
    const bd = bounds(root)
    console.log(`CEILING  (mechanical-only OPS turns): ${bd.ceiling.mechTurns} turns in ${bd.ceiling.runs} runs × ${bd.ceiling.opsMeanRead} mean OPS cache-read/turn ÷ ${M(bd.total)} (main sessions; sidechains excluded) = ${bd.ceiling.pct.toFixed(1)}% (upper bound: every such turn vanishes, scribe seats' own cost ignored)`)
    console.log(`LOWER BOUND (static prefix): (${bd.staticPrefix.turns} turns − ${bd.staticPrefix.sessions} sessions) × ${bd.staticPrefix.minPrefix} smallest first-turn read+create ÷ ${M(bd.total)} = ${bd.staticPrefix.pct.toFixed(1)}%`)
  }
}
