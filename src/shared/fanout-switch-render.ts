// #554 (ledger D2) — the installed skill text is RENDERED from the run's switches: a block `<!--sw <name>=<v1>|<v2>-->` … `<!--/sw-->` is kept (its two directive lines dropped)
// only when the switch holds one of the listed values (#563: several `name=v1|v2` terms, space-separated, must ALL hold), else removed whole. One block per feature variant, no nesting; any malformed directive THROWS (never a silently kept block).
import { SWITCH_VALUES, switchesOf, type SwitchName, type Switches } from './fanout-state.ts';

const TERM = '[A-Za-z]+=[A-Za-z|]+';
const OPEN = new RegExp(`^<!--sw (${TERM}(?: ${TERM})*)-->$`);
const CLOSE = '<!--/sw-->';

export function renderSwitchBlocks(text: string, switches: Partial<Switches> | Switches): string {
  const sw = switchesOf({ switches });
  const out: string[] = [];
  let keep: boolean | null = null; // null = outside a block
  for (const [n, line] of text.split('\n').entries()) {
    if (line.startsWith('<!--sw ')) {
      const m = OPEN.exec(line);
      if (!m) throw new Error(`line ${n + 1}: malformed switch directive ${JSON.stringify(line)}`);
      if (keep !== null) throw new Error(`line ${n + 1}: switch blocks do not nest`);
      keep = true;
      for (const term of m[1].split(' ')) {
        const [name, list] = term.split('=') as [SwitchName, string];
        if (!(name in SWITCH_VALUES)) throw new Error(`line ${n + 1}: unknown switch ${name}`);
        const values = list.split('|');
        for (const v of values) if (!(SWITCH_VALUES[name] as readonly string[]).includes(v)) throw new Error(`line ${n + 1}: ${name} has no value ${v}`);
        if (!values.includes(sw[name])) keep = false;
      }
      continue;
    }
    if (line === CLOSE) {
      if (keep === null) throw new Error(`line ${n + 1}: ${CLOSE} with no open block`);
      keep = null;
      continue;
    }
    if (keep !== false) out.push(line);
  }
  if (keep !== null) throw new Error('unterminated switch block');
  return out.join('\n');
}
