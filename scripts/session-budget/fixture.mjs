// Generated HEAVY fixture repo for the session-budget suite (#208). Never hand-maintained: every
// byte comes from `generateHeavyFixture(dir, profile)` and a seeded PRNG, so two calls with the same
// profile produce identical trees. Heavy on the axes that multiplied #176's boot-time context read
// (one count_tokens per skill / tool / memory file): many skills, a large CLAUDE.md, several stdio MCP
// servers with many tools each.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_MCP_SERVER = path.join(HERE, 'fake-mcp-server.mjs');
const SENTINEL_CLAUDE_MD = 'SB-SENTINEL-CLAUDE-MD-7f3a';
const SENTINEL_RULE_LAST = 'SB-SENTINEL-LAST-RULE-51c9';

/** The default heavy profile. Numbers chosen so a boot-time context read yields a large, countable
 *  burst on the fake API (well above the ~58 seen on a real metarepo session), not to mimic metarepo. */
export const HEAVY_PROFILE = Object.freeze({
  skills: 60,
  claudeMdKB: 48,
  memoryFiles: 50,
  mcpServers: 4,
  toolsPerServer: 15,
  /** Experiments only: the FIRST MCP server answers `initialize` this late (0 = off). */
  mcpInitDelayMs: 0,
});

function prng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu ledger invoice cohort router session budget worker shard parser cache lease token quota'.split(' ');
function paragraph(rand, sentences) {
  const s = [];
  for (let i = 0; i < sentences; i++) {
    const n = 8 + Math.floor(rand() * 10);
    const w = Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]);
    s.push(`${w[0][0].toUpperCase()}${w[0].slice(1)} ${w.slice(1).join(' ')}.`);
  }
  return s.join(' ');
}
function bytes(rand, kb) {
  const out = [];
  let n = 0, i = 0;
  while (n < kb * 1024) { const p = `## Section ${++i}\n\n${paragraph(rand, 4)}\n\n- ${paragraph(rand, 1)}\n- ${paragraph(rand, 1)}\n\n`; out.push(p); n += p.length; }
  return out.join('');
}

/**
 * Write the fixture repo into `dir` (created; must be empty or absent), `git init` + one commit.
 * @returns {{dir: string, profile: object, mcpServerNames: string[], markers: Record<string,string>}}
 *   `markers` maps the names in SUBJECT_MARKERS (src/shared/session-budget.ts) to substrings that must
 *   appear in the first model request if the subject really carried that part of the fixture.
 */
export function generateHeavyFixture(dir, overrides = {}) {
  const profile = { ...HEAVY_PROFILE, ...overrides };
  const rand = prng(20260930);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length) throw new Error(`fixture dir not empty: ${dir}`);

  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Heavy fixture\n\n${SENTINEL_CLAUDE_MD}\n\n${bytes(rand, profile.claudeMdKB)}`);
  fs.writeFileSync(path.join(dir, 'README.md'), '# session-budget heavy fixture (generated)\n');
  for (let i = 0; i < profile.memoryFiles; i++) {
    fs.mkdirSync(path.join(dir, '.claude', 'rules'), { recursive: true });
    const tag = i === profile.memoryFiles - 1 ? `${SENTINEL_RULE_LAST}\n\n` : '';
    fs.writeFileSync(path.join(dir, '.claude', 'rules', `rule-${String(i).padStart(2, '0')}.md`), `# Rule ${i}\n\n${tag}${bytes(rand, 4)}`);
  }
  for (let i = 0; i < profile.skills; i++) {
    const name = `fixture-skill-${String(i).padStart(3, '0')}`;
    const d = path.join(dir, '.claude', 'skills', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${paragraph(rand, 2)} Use when the task mentions ${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]}.\n---\n\n# ${name}\n\n${bytes(rand, 2)}`,
    );
  }
  const mcpServerNames = Array.from({ length: profile.mcpServers }, (_, i) => `fixsrv${i + 1}`);
  const mcpServers = {};
  // profile.stubbornMcp = how many of the LAST servers ignore stdin EOF/SIGTERM (#210: outlive a dead CLI);
  // profile.mcpInitDelayMs delays server 0's `initialize` (#208 startup-stall arm).
  for (const [i, n] of mcpServerNames.entries()) {
    const stubborn = i >= mcpServerNames.length - (profile.stubbornMcp ?? 0);
    mcpServers[n] = { command: process.execPath, args: [FAKE_MCP_SERVER, '--name', n, '--tools', String(profile.toolsPerServer), ...(i === 0 && profile.mcpInitDelayMs > 0 ? ['--init-delay-ms', String(profile.mcpInitDelayMs)] : []), ...(stubborn ? ['--stubborn'] : [])] };
  }
  fs.writeFileSync(path.join(dir, '.mcp.json'), `${JSON.stringify({ mcpServers }, null, 2)}\n`);
  // Project-scoped .mcp.json servers only start once approved; approve them in the project settings.
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), `${JSON.stringify({ enableAllProjectMcpServers: true }, null, 2)}\n`);

  const git = (...a) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'heavy fixture');
  const markers = {
    claude_md: SENTINEL_CLAUDE_MD,
    rule_last: SENTINEL_RULE_LAST,
    skill_last: `fixture-skill-${String(profile.skills - 1).padStart(3, '0')}`,
    mcp_tool_last: `${mcpServerNames[mcpServerNames.length - 1]}_tool_${String(profile.toolsPerServer - 1).padStart(2, '0')}`,
  };
  return { dir, profile, mcpServerNames, markers };
}
