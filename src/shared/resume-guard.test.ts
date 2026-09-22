// #178/#179 — the resume-guard decision layer. These are the DEFECT-LAYER tests:
// the phantom-resume dead-end and the never-started refusal loop both live in
// pure decisions extracted here, so each arm below drives the exact logic the
// shipped seams call (agent-sdk.ts seam a + working-guard, workspaces.ts seam b),
// with a real on-disk transcript probe for the discriminator so "phantom" and
// "real" are proven by the same fs the app uses — not a stubbed boolean.
//
// The source-binding gate that the seams actually CALL these lives in
// src/main/resume-guard-binding.test.ts (the modules can't load under
// node --test — the ./platform dir-import + extensionless import traps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveResumeId,
  shouldContinuePty,
  decideRestartGuard,
  SDK_CLEARED_MARKER,
} from './resume-guard.ts';

// ─── resolveResumeId — structured resume gate (#178 seam a) ──────────────────
//
// A REAL fs probe (a temp transcript dir), so the discriminator is proven end to
// end: an id whose `<dir>/<id>.jsonl` exists resumes; a phantom id (no file)
// starts fresh. This is the must-PASS / must-FAIL pair D3 names.

test('resolveResumeId: REAL transcript on disk → resumes that id (must-PASS)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'resume-guard-'));
  try {
    const id = '11111111-real-conversation';
    writeFileSync(path.join(dir, `${id}.jsonl`), '{"type":"user"}\n');
    // mirror transcriptExistsFor: existsSync of <dir>/<id>.jsonl
    const probe = (i: string) => existsSync(path.join(dir, `${i}.jsonl`));
    assert.equal(resolveResumeId(id, probe), id, 'a real id with a transcript must resume');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveResumeId: PHANTOM id (no transcript on disk) → undefined, start FRESH (must-FAIL today)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'resume-guard-'));
  try {
    // The dir exists but the phantom id's transcript does NOT — the field 050102a6.
    const phantom = '050102a6-phantom-never-written';
    const probe = (i: string) => existsSync(path.join(dir, `${i}.jsonl`));
    assert.equal(
      resolveResumeId(phantom, probe),
      undefined,
      'a phantom id whose transcript is gone must NOT resume — it must start fresh',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveResumeId: undefined id → fresh; cleared marker "" → fresh', () => {
  const always = () => true; // even if the probe would say "exists"
  assert.equal(resolveResumeId(undefined, always), undefined, 'never-run → fresh');
  assert.equal(
    resolveResumeId(SDK_CLEARED_MARKER, always),
    undefined,
    'the "" cleared marker is an explicit fresh-start, never a resume',
  );
});

test('resolveResumeId: the probe is DECISIVE — same id, flipped probe flips the verdict', () => {
  // Proves the guard actually consults the probe (a mutant that ignored it and
  // returned the id on truthiness alone would fail the phantom arm above; this
  // pins the dependency directly).
  const id = 'abc';
  assert.equal(resolveResumeId(id, () => true), id);
  assert.equal(resolveResumeId(id, () => false), undefined);
});

test('resolveResumeId: REMOTE composition (F1) — a real remote id resumes despite NO local transcript', () => {
  // reviewer-restart F1: the seam-(a) probe is a LOCAL-disk check, invalid for a
  // sandbox session whose transcript lives in the container. The seam feeds
  // `remote ? true : transcriptExistsFor(ws, id)` — model BOTH sides here so the
  // remote data-loss regression is covered end-to-end at the decision boundary.
  const remoteProbe = (remote: boolean) => (id: string) =>
    remote ? true : /* local disk says the transcript is absent */ false;

  // REMOTE: a real id + no local transcript → still RESUMES (trust the remote id).
  // The un-fixed seam (unconditional local probe) returned undefined here and
  // silently discarded the whole remote conversation — the blocking regression.
  assert.equal(
    resolveResumeId('remote-real-id', remoteProbe(true)),
    'remote-real-id',
    'a remote session must resume its real id even though no LOCAL transcript exists',
  );
  // LOCAL: the same "no transcript on disk" is a genuine phantom → fresh.
  assert.equal(
    resolveResumeId('local-phantom-id', remoteProbe(false)),
    undefined,
    'a local id with no on-disk transcript is a phantom → fresh (unchanged)',
  );
  // Remote still drops the explicit fresh signals — undefined/'' are fresh
  // regardless of host, so a remote /clear or never-run session starts fresh.
  assert.equal(resolveResumeId(undefined, remoteProbe(true)), undefined);
  assert.equal(resolveResumeId('', remoteProbe(true)), undefined);
});

// ─── shouldContinuePty — terminal --continue gate (#178 seam b) ──────────────

test('shouldContinuePty: hasInput + transcript exists → --continue (must-PASS)', () => {
  assert.equal(
    shouldContinuePty({ hasInput: true, fresh: false, newestTranscriptExists: true }),
    true,
  );
});

test('shouldContinuePty: hasInput but NO transcript → fresh, never --continue (must-FAIL today)', () => {
  // The phantom terminal workspace: hasInput true, but --continue would find
  // nothing → "No conversation found to continue", exit 1 (field 15:35:08).
  assert.equal(
    shouldContinuePty({ hasInput: true, fresh: false, newestTranscriptExists: false }),
    false,
    'a phantom terminal workspace must start fresh, not --continue into nothing',
  );
});

test('shouldContinuePty: never-typed (hasInput false) → fresh; fresh:true → fresh', () => {
  assert.equal(
    shouldContinuePty({ hasInput: false, fresh: false, newestTranscriptExists: true }),
    false,
    'no prompt ever typed → a fresh launch regardless of stray transcripts',
  );
  assert.equal(
    shouldContinuePty({ hasInput: true, fresh: true, newestTranscriptExists: true }),
    false,
    'an explicit --fresh request never resumes',
  );
  assert.equal(
    shouldContinuePty({ hasInput: undefined, fresh: false, newestTranscriptExists: true }),
    false,
    'undefined hasInput is not "true" → fresh',
  );
});

// ─── decideRestartGuard — the working-guard (#179 defect 1) ──────────────────

test('decideRestartGuard: started session mid-turn → REFUSE (must-PASS: a real turn is protected)', () => {
  assert.equal(
    decideRestartGuard({ hasLiveSession: true, turnInFlight: true, firstMessageSeen: true }),
    'refuse',
    'a genuinely working turn (firstMessageSeen) must still be politely refused',
  );
});

test('decideRestartGuard: NEVER-STARTED session holding the gate → FRESH (must-FAIL today: the 27s loop)', () => {
  // The boot wedge: gate held (opening turn accepted + yielded) but no stream
  // message ever (firstMessageSeen false). The old guard refused this FOREVER.
  assert.equal(
    decideRestartGuard({ hasLiveSession: true, turnInFlight: true, firstMessageSeen: false }),
    'fresh',
    'a never-started opening turn is interruptible → tear down + fresh, not refuse',
  );
});

test('decideRestartGuard: no turn in flight, or no live session → RESUME (ordinary restart)', () => {
  assert.equal(
    decideRestartGuard({ hasLiveSession: true, turnInFlight: false, firstMessageSeen: true }),
    'resume',
    'idle live session → the ordinary conversation-preserving restart',
  );
  assert.equal(
    decideRestartGuard({ hasLiveSession: false, turnInFlight: false, firstMessageSeen: false }),
    'resume',
    'no live session (detached keeper / stopped) → resume path, guard stands down',
  );
  // firstMessageSeen is only consulted when a turn is actually in flight: an idle
  // never-started session (turnInFlight false) is not "fresh", it is a plain resume.
  assert.equal(
    decideRestartGuard({ hasLiveSession: true, turnInFlight: false, firstMessageSeen: false }),
    'resume',
  );
});

test('decideRestartGuard: firstMessageSeen is the ONLY thing separating refuse from fresh', () => {
  // Same in-flight state, flip only firstMessageSeen — the verdict must flip.
  // A mutant that dropped the firstMessageSeen check (always 'refuse' while
  // in-flight) reddens on the fresh arm; one that always 'fresh' reddens here.
  const base = { hasLiveSession: true, turnInFlight: true };
  assert.equal(decideRestartGuard({ ...base, firstMessageSeen: true }), 'refuse');
  assert.equal(decideRestartGuard({ ...base, firstMessageSeen: false }), 'fresh');
});
