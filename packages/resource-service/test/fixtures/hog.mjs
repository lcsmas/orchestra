// Memory hog for the A4 tests: touch <MB> in 10 MB steps (5 ms apart), print progress, hold briefly, print `survived`. Usage: hog.mjs <MB> [extra]
//  extra = `trap-sibling`: first start a TERM-ignoring `sleep` sibling (so a scope that is only SIGTERMed would linger)
import { spawn } from 'node:child_process';

const [mb, extra] = [Number(process.argv[2]), process.argv[3]];
if (extra === 'trap-sibling') spawn('sh', ['-c', 'trap "" TERM; exec sleep 300'], { stdio: 'ignore' }).unref();
const keep = [];
for (let i = 0; i < mb / 10; i++) {
  keep.push(Buffer.alloc(10 * 1024 * 1024, 0xa5));
  await new Promise((r) => setTimeout(r, 5));
}
console.log(`hog: touched ${keep.length * 10} MB`);
await new Promise((r) => setTimeout(r, 200));
console.log('hog: survived');
