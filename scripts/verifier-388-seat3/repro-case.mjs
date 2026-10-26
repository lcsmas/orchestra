import { decideCloseThroughCli, resolveAbTab } from '/var/tmp/orch-1000-b17728/d83d09da2fea/wt-cand2/src/shared/browser-agent-tabs.ts';
const ab = [
  { tabId: 't1', label: null, targetId: 'AAA', active: false, title: 'user B' },
  { tabId: 't2', label: null, targetId: 'BBB', active: true, title: 'agent A' },
];
const host = [
  { targetId: 'AAA', openedBy: 'human', active: false, closable: false, reason: 'user tab' },
  { targetId: 'BBB', openedBy: 'agent', active: true, closable: true },
];
for (const ref of ['t1', 'T1', ' t1 ', 't1\t', 'AAA', 'aaa', 'user B', '1']) {
  const res = resolveAbTab(ab, ref); const v = decideCloseThroughCli(ab, [ref], host);
  console.log(JSON.stringify(ref).padEnd(10), 'resolves to', (res?.tabId ?? 'NOTHING').padEnd(8), '→ CLI verdict:', v.run ? 'RUN (passes to agent-browser)' : 'REFUSE');
}
