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

/** OPS tool calls by kind (deduped by message.id); `scribeable` = what the skill hands to a scribe-: ledger writes, `fanout state set`, CI polling, sweeps. */
export function opsCalls(projects) {
  const seen = new Set(), c = {}
  for (const dir of readdirSync(projects)) {
    if (wsOfDir(dir).role !== 'ops') continue
    for (const f of walk(join(projects, dir))) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.includes('"tool_use"')) continue
        let o
        try { o = JSON.parse(line) } catch { continue }
        if (o.type !== 'assistant' || !o.message?.id) continue
        for (const b of o.message.content ?? []) {
          if (b.type !== 'tool_use') continue
          const key = `${o.message.id}/${b.id}`
          if (seen.has(key)) continue
          seen.add(key)
          const cmd = b.input?.command ?? ''
          const k = b.name !== 'Bash' ? b.name
            : /orchestra (send|check|ack|spawn|token|ask)\b/.test(cmd) ? 'fleet-mail'
            : /\bgh (issue|pr) (comment|edit)\b|ledger-set/.test(cmd) ? 'ledger-write'
            : /fanout state set/.test(cmd) ? 'state-set'
            : /\bgh (pr (checks|view|list)|run)\b/.test(cmd) ? 'ci-poll'
            : /orchestra (verify-landed|peers)|git (-C \S+ )?(log|status|ls-remote|rev-list)\b/.test(cmd) ? 'sweep'
            : 'other-bash'
          c[k] = (c[k] ?? 0) + 1
        }
      }
    }
  }
  const total = Object.values(c).reduce((a, b) => a + b, 0)
  const scribeable = (c['ledger-write'] ?? 0) + (c['state-set'] ?? 0) + (c['ci-poll'] ?? 0) + (c['sweep'] ?? 0)
  return { total, scribeable, byKind: c }
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
  }
}
