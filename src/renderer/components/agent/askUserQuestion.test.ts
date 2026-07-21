import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_USER_QUESTION,
  buildAskUserQuestionReply,
  parseAskUserQuestion,
} from './askUserQuestion.ts';

const sampleInput = {
  questions: [
    {
      question: 'Which database?',
      header: 'DB',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: 'Relational' },
        { label: 'SQLite', description: 'Embedded' },
      ],
    },
    {
      question: 'Which features?',
      header: 'Features',
      multiSelect: true,
      options: [
        { label: 'Auth', description: 'Login' },
        { label: 'Billing', description: 'Payments' },
      ],
    },
  ],
};

test('parseAskUserQuestion accepts a well-formed AskUserQuestion input', () => {
  const parsed = parseAskUserQuestion(ASK_USER_QUESTION, sampleInput);
  assert.ok(parsed);
  assert.equal(parsed.questions.length, 2);
  assert.equal(parsed.questions[0].question, 'Which database?');
  assert.equal(parsed.questions[0].options.length, 2);
  assert.equal(parsed.questions[1].multiSelect, true);
});

test('parseAskUserQuestion rejects non-AskUserQuestion tools', () => {
  assert.equal(parseAskUserQuestion('Bash', { command: 'ls' }), null);
});

test('parseAskUserQuestion rejects malformed inputs', () => {
  assert.equal(parseAskUserQuestion(ASK_USER_QUESTION, {}), null);
  assert.equal(parseAskUserQuestion(ASK_USER_QUESTION, { questions: 'nope' }), null);
  assert.equal(
    parseAskUserQuestion(ASK_USER_QUESTION, { questions: [{ question: 'q', options: [] }] }),
    null,
  );
});

test('buildAskUserQuestionReply passes through the original input and adds answers keyed by question text', () => {
  const parsed = parseAskUserQuestion(ASK_USER_QUESTION, sampleInput)!;
  const reply = buildAskUserQuestionReply(sampleInput, parsed.questions, {
    'Which database?': ['Postgres'],
    'Which features?': ['Auth', 'Billing'],
  });
  // Original questions preserved.
  assert.deepEqual((reply as typeof sampleInput).questions, sampleInput.questions);
  // Answers keyed by question text; multiSelect joined.
  assert.deepEqual(reply.answers, {
    'Which database?': 'Postgres',
    'Which features?': 'Auth, Billing',
  });
});

test('buildAskUserQuestionReply omits questions with no selection', () => {
  const parsed = parseAskUserQuestion(ASK_USER_QUESTION, sampleInput)!;
  const reply = buildAskUserQuestionReply(sampleInput, parsed.questions, {
    'Which database?': ['SQLite'],
  });
  assert.deepEqual(reply.answers, { 'Which database?': 'SQLite' });
});
