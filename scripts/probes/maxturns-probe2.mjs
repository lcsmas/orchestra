// T85 probe 2 — THE UNASKED QUESTION.
// All prior probes used maxTurns:1. Nobody tested whether the counter is
// per-USER-TURN or per-QUERY-LIFETIME at a LARGER cap. Discriminator:
// if num_turns RESTARTS from ~0 each prompt, it is per-turn.
// If it ACCUMULATES across prompts, 200 is a session-lifetime budget
// and the ticket's premise is LIVE.
import { query } from '@anthropic-ai/claude-agent-sdk';

const N = 6;
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

// Large cap so NO turn exhausts. If num_turns keeps climbing across prompts,
// the budget is cumulative. If it resets, it is per-turn.
const q = query({ prompt: promptStream(), options: {
  model: 'claude-haiku-4-5-20251001',
  allowedTools: ['Bash'], permissionMode: 'bypassPermissions',
  maxTurns: 200,
}});

let results = 0;
const timer = setTimeout(() => { console.log('TIMEBOX'); process.exit(0); }, 300000);
for await (const m of q) {
  if (m.type === 'result') {
    results++;
    console.log(`result#${results} subtype=${m.subtype} num_turns=${m.num_turns}`);
    openGate?.(); openGate = null;
    if (results >= N) break;
  }
}
clearTimeout(timer);
console.log('SUMMARY: if num_turns resets per prompt => PER-TURN. If it climbs => CUMULATIVE.');
process.exit(0);
