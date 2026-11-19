#!/usr/bin/env node
// resctl entry: Node >= 22.18 runs the TypeScript sources by type stripping (erasable syntax only).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(`resctl: needs Node >= 22.18 (found ${process.versions.node})\n`);
  process.exit(1);
}
const { run } = await import('../src/cli.ts');
process.exitCode = await run(process.argv.slice(2));
