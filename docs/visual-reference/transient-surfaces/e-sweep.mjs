// Capture the Electron half of my region.
// NEVER mutate React-managed DOM to close a modal — .remove()ing a backdrop
// broke reconciliation and emptied the root. Close via Escape / the modal's
// own button, exactly as a user would.
import { evalJs, shot, close } from './cdp.mjs';
import { createHash } from 'node:crypto';

const hashes = {};
const jobs = [
  ['accounts-settings', '.accounts-settings', 'Claude accounts'],
  ['sound-settings', '.sound-settings', 'Notification sound'],
  ['repo-scripts', '.repo-scripts-modal', 'setup / run / archive'],
  ['linear', '.linear-settings', 'Linear API key'],
];

const dismiss = async () => {
  await evalJs(`(()=>{const m=document.querySelector('.modal,.dialog');
    if(!m) return; const b=[...m.querySelectorAll('button')]
      .find(x=>/cancel|close|done|×/i.test(x.textContent||x.getAttribute('aria-label')||''));
    if(b) b.click();})()`);
  await new Promise((r) => setTimeout(r, 500));
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await new Promise((r) => setTimeout(r, 500));
};

for (const [tag, sel, frag] of jobs) {
  await dismiss();
  const clicked = await evalJs(`(()=>{const b=[...document.querySelectorAll('button,a')]
    .find(x=>((x.title||'')+' '+(x.textContent||'')).includes(${JSON.stringify(frag)}));
    if(!b) return 'NOT FOUND'; b.click(); return b.title||b.textContent.slice(0,40);})()`);
  await new Promise((r) => setTimeout(r, 1100));
  const info = await evalJs(`(()=>{const m=document.querySelector('${sel}');
    if(!m) return null; const r=m.getBoundingClientRect(); const bd=m.parentElement;
    return JSON.stringify({size:[Math.round(r.width),Math.round(r.height)],
      cls:m.className, declW:getComputedStyle(m).width,
      backdrop:bd?.className, backdropW:Math.round(bd.getBoundingClientRect().width)});})()`);
  console.log(`${tag.padEnd(18)} click=${String(clicked).slice(0, 30).padEnd(32)} ${info || 'NOT PRESENT'}`);
  if (info) {
    const s = await shot(`caps/e-${tag}.png`, sel);
    console.log(`  captured bytes=${s.bytes} md5=${s.md5.slice(0, 10)}`);
    hashes[tag] = s.md5;
  }
}
await dismiss();

const seen = {};
for (const [k, v] of Object.entries(hashes)) (seen[v] ||= []).push(k);
const dupes = Object.entries(seen).filter(([, ks]) => ks.length > 1);
console.log('\nduplicate guard:', dupes.length ? dupes : `none (${Object.keys(hashes).length} captures)`);
close();
