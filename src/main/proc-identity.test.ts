// #240 r3 F2 — a failed /proc read is never "gone".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readProcStat, procStartTicks, sameLiveProcess } from './proc-identity.ts';

const err = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
// a real-shaped stat line: pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime prio nice threads itreal START ...
const stat = (start: number, state = 'S') => `4242 (my (odd) cmd) ${state} 1 4242 4242 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 ${start} 1000 100 18446744073709551615`;

test('readProcStat: ENOENT / ESRCH = definitely gone (null); every other error = UNKNOWN (undefined); text passes through', () => {
  assert.equal(readProcStat(1, err('ENOENT')), null);
  assert.equal(readProcStat(1, err('ESRCH')), null);
  for (const code of ['EMFILE', 'ENFILE', 'EACCES', 'EIO', 'ENOMEM', 'EPERM', 'EINTR']) assert.equal(readProcStat(1, err(code)), undefined, code);
  assert.equal(readProcStat(1, () => 'text'), 'text');
  assert.equal(readProcStat(1, () => { throw new Error('no code at all'); }), undefined, 'an error with no code is unknown, not gone');
});

test('sameLiveProcess: same start-time = true; recycled / zombie / gone = false; a failed read = undefined (cannot tell)', () => {
  const t = procStartTicks(stat(777));
  assert.equal(t, 777, 'start-time parsed past a comm with spaces and parens');
  assert.equal(sameLiveProcess(777, stat(777)), true);
  assert.equal(sameLiveProcess(777, stat(778)), false, 'pid recycled');
  assert.equal(sameLiveProcess(777, stat(777, 'Z')), false, 'zombie cannot write');
  assert.equal(sameLiveProcess(777, null), false, 'definitely absent');
  assert.equal(sameLiveProcess(777, undefined), undefined, 'unknown ≠ gone');
});

test('procStartTicks: undefined when there is no /proc or the read failed (identity unknowable ⇒ never signalled)', () => {
  assert.equal(procStartTicks(null), undefined);
  assert.equal(procStartTicks(undefined), undefined);
  assert.equal(procStartTicks('garbage'), undefined);
});
