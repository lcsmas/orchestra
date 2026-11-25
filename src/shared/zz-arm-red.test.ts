import { test } from 'node:test';
import assert from 'node:assert/strict';
test('arm red: this test fails on purpose (#594 throwaway)', () => { assert.equal(1, 2); });
