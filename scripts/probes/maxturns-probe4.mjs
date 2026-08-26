// T85 probe 4 — G4 EVIDENCE BAR, both arms, same rig.
// ARM A: "a coordinator-shaped session exceeding 200 consumed turns without dying"
// ARM B: "a runaway loop still stopped"
// Both under the SHIPPED cap (200), Orchestra's for(;;) turn-gated generator.
import { query } from '@anthropic-ai/claude-agent-sdk';

const ARM = process.env.ARM;
let openGate = null, idx = 0, prompts = [];

if (ARM === 'A') {
  // Coordinator shape: MANY user turns, each cheap. 70 turns x ~3 round-trips
  // = >200 CONSUMED turns in aggregate, under a cap of 200.
  // Each turn must cost >=3 round-trips so 70 turns clears 200 CONSUMED turns.
  prompts = Array.from({length: 70}, (_, i) =>
    `Run these as THREE SEPARATE Bash calls, one at a time, each only after seeing the previous output: (1) echo a${i}; (2) echo b${i}; (3) echo c${i}. Then reply exactly D${i}.`);
} else {
  // Runaway shape: a SINGLE turn instructed to loop far past the cap.
  prompts = [`Run Bash 'echo n' over and over, one call at a time, 400 times. Never stop early. Do not summarize; just keep calling Bash.`];
}

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
  maxTurns: 200,          // <- the SHIPPED value, unchanged
}});

let results = 0, consumed = 0, threw = null, exhausted = 0;
const t0 = Date.now();
try {
  for await (const m of q) {
    if (m.type === 'result') {
      results++; consumed += m.num_turns;
      if (m.subtype === 'error_max_turns') exhausted++;
      if (ARM !== 'A' || results % 10 === 0 || results <= 2)
        console.log(`result#${results} subtype=${m.subtype} num_turns=${m.num_turns} CONSUMED_TOTAL=${consumed}`);
      openGate?.(); openGate = null;
      if (results >= prompts.length) break;
    }
  }
} catch (e) { threw = e; console.log('THREW:', e?.message); }
console.log(`\nARM ${ARM} SUMMARY: user_turns=${results} CONSUMED_TURNS=${consumed} exhausted=${exhausted} threw=${threw?'YES':'null'} dur=${Math.round((Date.now()-t0)/1000)}s`);
if (ARM === 'A') console.log(consumed > 200 && !threw ? 'ARM A PASS: >200 consumed turns, session ALIVE, never died' : 'ARM A INCONCLUSIVE');
else console.log(exhausted >= 1 ? `ARM B PASS: runaway STOPPED by the cap at num_turns=${consumed}` : 'ARM B INCONCLUSIVE: runaway was not stopped');
process.exit(0);
