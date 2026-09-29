const fs = require('node:fs');
const src = fs.readFileSync('/home/lmas/rva8/tip-src.bak', 'utf8');
let s = src;
const rep = (a, b) => { const c = s.split(a).length - 1; if (c !== 1) throw new Error('count ' + c + ' for ' + a.slice(0, 50)); s = s.replace(a, () => b); };
// 1. builtFromElsewhere: also judge the symlinks ON DISK at every path this sync will manage (wanted ∪ manifest), whatever the manifest says.
rep("function builtFromElsewhere(loginDir: string, globalDir: string, prev: InheritManifest): string | null {\n  if (prev.source !== undefined) return sameDir(prev.source, globalDir) ? null : prev.source;\n  for (const rel of prev.symlinks) {",
    "function builtFromElsewhere(loginDir: string, globalDir: string, prev: InheritManifest, managed: string[]): string | null {\n  if (prev.source !== undefined) return sameDir(prev.source, globalDir) ? null : prev.source;\n  for (const rel of new Set([...prev.symlinks, ...managed])) {");
// 2. hoist wantLinks construction above the guard (pure reads)
const start = s.indexOf("  // Build the desired symlink set");
const end = s.indexOf("  // Apply desired links;");
const block = s.slice(start, end); s = s.slice(0, start) + s.slice(end);
rep("  const prev = readManifest(loginDir);\n  const from = builtFromElsewhere(loginDir, globalDir, prev);", block + "  const prev = readManifest(loginDir);\n  const from = builtFromElsewhere(loginDir, globalDir, prev, [...wantLinks.keys()]);");
fs.writeFileSync('/home/lmas/rva8/proto-src.ts', s);
