// Preflight: can the bus open under SYSTEM node in the tree under test? CONSTRUCT a database through the repo's own loader —
// `require()` alone passes under the wrong ABI.   node --experimental-strip-types scripts/session-identity/bus-probe.mjs <repo>
const repo = process.argv[2];
const m = await import(`${repo}/src/main/bus-binding.ts`);
const Database = m.loadDatabaseCtor();
new Database(':memory:');
console.log(`BUS_OK abi=${process.versions.modules}`);
