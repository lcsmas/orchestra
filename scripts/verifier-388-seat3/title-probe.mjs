import { popupWindowTitle, popupOrigin } from '/var/tmp/orch-1000-b17728/d83d09da2fea/p396/src/shared/browser-popup-window.ts';
const ORIGIN = 'https://evil.example';
const cases = {
  'plain': 'Sign in',
  'fake origin in title': 'https://accounts.google.com — Sign in',
  'RLO override': '‮elgoog.moc‬',
  'RLI/PDI isolates': '⁧x⁩',
  'LRM/RLM marks': 'a‎b‏c',
  'Arabic letter mark U+061C': 'a؜b',
  'zero-width space/joiner': 'a​b‌c‍d',
  'BOM U+FEFF': '﻿Title',
  'line/paragraph sep': 'a b c',
  'NUL + C1 controls': 'a\u0000b\u0085c\u009fd',
  'newline + tabs': 'a\n\tb\r\nc',
  '10k chars': 'x'.repeat(10000),
  'combining flood': 'e' + '́'.repeat(500),
  'emoji ZWJ sequence': '👨‍👩‍👧',
};
let bad = 0;
for (const [name, t] of Object.entries(cases)) {
  const out = popupWindowTitle(ORIGIN + '/path?token=SECRET', t);
  const startsWithOrigin = out.startsWith(ORIGIN);
  const leaksQuery = out.includes('SECRET');
  const stripped = !/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/.test(out);
  const residual = [...out].filter((c) => /[؜​-‍⁠﻿]/.test(c)).map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
  const ok = startsWithOrigin && !leaksQuery && stripped && out.length <= 200;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} len=${out.length} origin-first=${startsWithOrigin} no-token=${!leaksQuery} controls/bidi-stripped=${stripped}${residual.length ? ' RESIDUAL-INVISIBLE=' + [...new Set(residual)].join(',') : ''}`);
}
for (const u of ['', 'about:blank', 'javascript:alert(1)', 'data:text/html,x', 'blob:https://x/1', 'https://用户@evil.example:99999', 'http://[::1', 'file:///etc/passwd', 'https://xn--e1afmkfd.xn--p1ai/']) console.log('origin of', JSON.stringify(u).slice(0, 40).padEnd(42), '→', popupOrigin(u));
console.log(`TITLE-PROBE red=${bad}/${Object.keys(cases).length}`);
