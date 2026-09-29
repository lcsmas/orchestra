const { openBus } = await import(process.env.RV_W + '/src/main/bus.ts');
const [file, t0] = [process.argv[2], Number(process.argv[3])];
while (Date.now() < t0) {}
try { const db = openBus(file); console.log('OK v' + db.pragma('user_version', { simple: true })); db.close(); }
catch (e) { console.log('ERR ' + (e as Error).message); }
