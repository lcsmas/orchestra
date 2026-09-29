import { openBus } from '/home/lmas/.orchestra/worktrees/orchestra-happy-river-03b66340/src/main/bus.ts';
const [file, t0] = [process.argv[2], Number(process.argv[3])];
while (Date.now() < t0) {}
try { const db = openBus(file); console.log('OK v' + db.pragma('user_version', { simple: true })); db.close(); }
catch (e) { console.log('ERR ' + (e as Error).message); }
