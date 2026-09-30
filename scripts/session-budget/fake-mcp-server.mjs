#!/usr/bin/env node
// Minimal stdio MCP server for the session-budget fixture (#208): answers initialize / tools/list /
// tools/call / ping and empty resources+prompts lists over newline-delimited JSON-RPC. It exists to
// make the CLI (a) spawn a real child per server and (b) count N tools per server in its context
// breakdown — nothing else. Usage: fake-mcp-server.mjs --name <n> --tools <count>
import readline from 'node:readline';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const NAME = arg('name', 'fake');
const TOOLS = Number(arg('tools', '10'));
const INIT_DELAY_MS = Number(arg('init-delay-ms', '0')); // slow-but-healthy server: answers `initialize` late (startup-stall experiments)
// #210: `--stubborn` = a server that outlives its parent (ignores stdin EOF and SIGTERM/SIGHUP, like an
// `npx`-wrapped server whose grandchild is orphaned when the CLI dies). Only SIGKILL ends it — the delete
// arms use one to prove the descendant sweep (killKeeperTree), which the CLI's own exit does not do.
const STUBBORN = process.argv.includes('--stubborn');
if (STUBBORN) {
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => {});
  setInterval(() => {}, 1 << 30);
}

const tools = Array.from({ length: TOOLS }, (_, i) => ({
  name: `${NAME}_tool_${String(i).padStart(2, '0')}`,
  description:
    `Fixture tool ${i} of server ${NAME}. Looks up the fictional record set number ${i} in the ${NAME} catalogue, ` +
    `applies the optional filter, and returns at most \`limit\` rows as JSON. Exists only to give the context ` +
    `breakdown a realistic amount of tool-schema text to count; it never does anything.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: `Free-text query against the ${NAME} catalogue.` },
      filter: { type: 'object', description: 'Optional key/value filter.', additionalProperties: { type: 'string' } },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum rows to return.' },
    },
    required: ['query'],
  },
}));

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return; // notification
  switch (m.method) {
    case 'initialize':
      if (INIT_DELAY_MS > 0) return void setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: NAME, version: '0.0.1' } } }), INIT_DELAY_MS);
      return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: NAME, version: '0.0.1' } } });
    case 'tools/list': return send({ jsonrpc: '2.0', id: m.id, result: { tools } });
    case 'tools/call': return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } });
    case 'ping': return send({ jsonrpc: '2.0', id: m.id, result: {} });
    case 'resources/list': return send({ jsonrpc: '2.0', id: m.id, result: { resources: [] } });
    case 'resources/templates/list': return send({ jsonrpc: '2.0', id: m.id, result: { resourceTemplates: [] } });
    case 'prompts/list': return send({ jsonrpc: '2.0', id: m.id, result: { prompts: [] } });
    default: return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no such method: ${m.method}` } });
  }
});
rl.on('close', () => { if (!STUBBORN) process.exit(0); });
