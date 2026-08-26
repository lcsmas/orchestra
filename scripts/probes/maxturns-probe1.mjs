// T85 probe 1 — is the cap per-TURN or per-QUERY, on SDK 0.3.241?
// Replicates Orchestra's real shape: for(;;) generator, turn-gated.
import { query } from '@anthropic-ai/claude-agent-sdk';

const MAXTURNS = Number(process.env.MT ?? 2);
const N = Number(process.env.N ?? 4);
let openGate = null;
const prompts = [];
for (let i = 0; i < N; i++) {
  // Each prompt REQUIRES >=3 agentic round-trips (3 separate Bash calls,
  // each depending on the previous) so a small cap actually BINDS.
  prompts.push(`Run these as THREE SEPARATE Bash calls, one at a time, each after seeing the previous output: (1) echo A${i}; (2) echo B${i}; (3) echo C${i}. Then reply DONE${i}.`);
}
let idx = 0;

async function* promptStream() {
  for (;;) {                                   // <- Orchestra's real shape
    if (idx >= prompts.length) { await new Promise(r => setTimeout(r, 250)); continue; }
    const text = prompts[idx++];
    yield { type: 'user', session_id: '', parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'text', text }] } };
    await new Promise(r => { openGate = r; });  // turn gate
  }
}

const q = query({ prompt: promptStream(), options: {
  model: 'claude-haiku-4-5-20251001',
  allowedTools: ['Bash'], permissionMode: 'bypassPermissions',
  maxTurns: MAXTURNS,
}});

let results = 0, threw = null;
const t0 = Date.now();
const timer = setTimeout(() => { console.log('TIMEBOX hit'); process.exit(0); }, 300000);
try {
  for await (const m of q) {
    if (m.type === 'result') {
      results++;
      console.log(`result#${results} subtype=${m.subtype} num_turns=${m.num_turns} is_error=${m.is_error} dur=${Date.now()-t0}ms`);
      openGate?.(); openGate = null;
      if (results >= N) break;
    }
  }
} catch (e) { threw = e; console.log('THREW:', e?.message); }
clearTimeout(timer);
console.log(`SUMMARY maxTurns=${MAXTURNS} results=${results}/${N} threw=${threw ? 'YES' : 'null'}`);
process.exit(0);
