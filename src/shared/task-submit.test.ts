import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitPlan, canRecoverFromLostText, type SubmitStep } from './task-submit.ts';

const PROD = { maxSubmitAttempts: 4, typeRounds: 2 };

test('the shipped policy can recover from the task text never landing', () => {
  // THE REGRESSION THIS PINS. A spawn left an agent at a pristine prompt with
  // no task: the text never reached the input box, and the old policy answered
  // by resending '\r' at an empty box until its budget ran out. Typing more
  // than once is the ONLY step that can fix that, so it is asserted directly
  // rather than inferred from the step count.
  assert.ok(canRecoverFromLostText(submitPlan(PROD)));
});

test('the OLD single-type policy is caught as unrecoverable', () => {
  // Mutation test: reconstruct the exact policy that shipped the bug and prove
  // this suite rejects it. Without this, `canRecoverFromLostText` is a guard
  // nobody has watched fail — indistinguishable from one that cannot fail.
  const old = submitPlan({ maxSubmitAttempts: 4, typeRounds: 1 });
  assert.equal(canRecoverFromLostText(old), false);
  assert.equal(old.filter((s) => s.kind === 'type').length, 1);
});

test('escalates: submits are exhausted before the text is re-typed', () => {
  // Ordering is the policy. Re-typing eagerly would duplicate the task in the
  // common case (a merely-dropped '\r'), so the cheap remedy must come first.
  const kinds = submitPlan(PROD).map((s) => s.kind);
  const firstType = kinds.indexOf('type');
  const secondType = kinds.indexOf('type', firstType + 1);
  const submitsBetween = kinds.slice(firstType, secondType).filter((k) => k === 'submit').length;

  assert.equal(submitsBetween, PROD.maxSubmitAttempts);
  assert.ok(secondType > firstType);
});

test('every re-type is preceded by a clear, and the first is not', () => {
  // A retype that concatenates onto a half-delivered prompt would submit
  // garbage — worse than the empty box, because it looks like a real task.
  const plan = submitPlan(PROD);
  assert.equal(plan[0]?.kind, 'type', 'first step must not clear an empty box');

  plan.forEach((step, i) => {
    if (step.kind === 'type' && i > 0) {
      assert.equal(plan[i - 1]?.kind, 'clear', `re-type at step ${i} must follow a clear`);
    }
  });
});

test('plan is bounded — a wedged TUI cannot be retyped forever', () => {
  const plan = submitPlan(PROD);
  const types = plan.filter((s) => s.kind === 'type').length;
  assert.equal(types, PROD.typeRounds);
  assert.equal(plan.filter((s) => s.kind === 'submit').length, PROD.typeRounds * PROD.maxSubmitAttempts);
});

test('degenerate options produce an empty plan rather than throwing', () => {
  const empty: SubmitStep[] = submitPlan({ maxSubmitAttempts: 0, typeRounds: 0 });
  assert.deepEqual(empty, []);
  assert.equal(canRecoverFromLostText(empty), false);
});
