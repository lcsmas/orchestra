// T85 probe 3 — POSITIVE CONTROL for probe 2.
// Probe 2 showed num_turns=3 six times at maxTurns:200. That is consistent
// with "resets per turn" but ALSO with "the cap simply never bound".
// Discriminator: a cap that would ONLY bind if the counter were CUMULATIVE.
// 4 prompts x 3 round-trips each = 12 cumulative, but only 3 per-turn.
// maxTurns:5  =>  per-turn: ALL 4 succeed.  cumulative: prompt #2 exhausts.
import { query } from '@anthropic-ai/claude-agent-sdk';
const N = 4;
let openGate = null, idx = 0;
const prompts = Array.from({length: N}, (_, i) =>
  `Run TWO separate Bash calls one at a time: echo X${i}, then echo Y${i}. Then reply DONE${i}.`);
async function* promptStream() {
  for (;;) {
    if (idx >= prompts.length) { await new Promise(r => setTimeout(r, 250)); continue; }
    const text = prompts[idx++];
    yield { type: 'user', session_id: '', parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'text', text }] } };
    await new Promise(r => { openGate = r; });
  }
}
const q = query({ prompt: promptStream(), options: {
  model: 'claude-haiku-4-5-20251001',
  allowedTools: ['Bash'], permissionMode: 'bypassPermissions',
  maxTurns: 5,   // > per-turn need (3), < cumulative need (12)
}});
let results = 0, cumulative = 0;
const timer = setTimeout(() => { console.log('TIMEBOX'); process.exit(0); }, 300000);
for await (const m of q) {
  if (m.type === 'result') {
    results++; cumulative += m.num_turns;
    console.log(`result#${results} subtype=${m.subtype} num_turns=${m.num_turns} cumulative_so_far=${cumulative} (cap=5)`);
    openGate?.(); openGate = null;
    if (results >= N) break;
  }
}
clearTimeout(timer);
console.log(`VERDICT: cumulative total=${cumulative} vs cap=5. All success => counter RESETS PER TURN.`);
process.exit(0);
