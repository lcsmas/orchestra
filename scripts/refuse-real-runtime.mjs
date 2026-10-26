#!/usr/bin/env node
// Refusal shim (incident Q2, ledger #405): `pnpm run <name>` for a script that launches Electron under the human's REAL
// /run/user/<uid> (its own sway + real XDG_RUNTIME_DIR). Stays refused until the script is migrated to scripts/e2e-contained-rig.sh.
const name = process.argv[2] ?? '(unnamed)';
console.error(`REFUSED: \`pnpm run ${name}\` starts Electron against the human's REAL /run/user/<uid> (gnome-keyring bus/keyring sockets) — the crash class of incident Q2 (ledger #405).
It stays off until the script is migrated to scripts/e2e-contained-rig.sh (private runtime world; docs/codebase-map/hooks-cli-socket.md). Nothing was run.`);
process.exit(3);
