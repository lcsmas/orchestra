import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseElicitationSchema,
  initialElicitationValues,
  isElicitationComplete,
  buildElicitationContent,
} from './elicitation-form.ts';

// A representative MCP elicitation schema: flat object of primitives, which is
// all the MCP spec allows.
const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Your name', description: 'As it appears on the account' },
    age: { type: 'integer' },
    ratio: { type: 'number' },
    subscribe: { type: 'boolean', default: true },
    plan: { type: 'string', enum: ['free', 'pro'] },
  },
  required: ['name', 'subscribe'],
};

test('parseElicitationSchema reads title/description/required/enum/type', () => {
  const fields = parseElicitationSchema(SCHEMA);
  assert.deepEqual(
    fields.map((f) => [f.name, f.kind, f.required]),
    [
      ['name', 'string', true],
      ['age', 'integer', false],
      ['ratio', 'number', false],
      ['subscribe', 'boolean', true],
      ['plan', 'enum', false],
    ],
  );
  assert.equal(fields[0].label, 'Your name');
  assert.equal(fields[0].description, 'As it appears on the account');
  // No `title` ⇒ the property name is the label (never a blank one).
  assert.equal(fields[1].label, 'age');
  assert.deepEqual(fields[4].options, ['free', 'pro']);
  assert.equal(fields[3].defaultValue, true);
});

test('parseElicitationSchema: enum wins over type', () => {
  // `enum` is the stronger constraint and the one the server validates against,
  // so a typed enum must still render as a select, not a free-text input.
  const [f] = parseElicitationSchema({
    properties: { p: { type: 'string', enum: ['a', 'b'] } },
  });
  assert.equal(f.kind, 'enum');
});

test('parseElicitationSchema degrades on hostile input instead of throwing', () => {
  // The schema comes from an ARBITRARY MCP server — none of these may throw.
  for (const bad of [undefined, null, 42, 'nope', [], {}, { properties: 7 }]) {
    assert.deepEqual(parseElicitationSchema(bad), []);
  }
  // A property whose type is unknown degrades to a TEXT field rather than being
  // dropped: a dropped field silently builds an answer the server rejects,
  // whereas a text field the user can fill is still usable.
  const [f] = parseElicitationSchema({ properties: { p: { type: 'wat' } } });
  assert.equal(f.kind, 'string');
  // `required` of the wrong type is tolerated, not fatal.
  assert.equal(parseElicitationSchema({ properties: { p: {} }, required: 'p' })[0].required, false);
});

test('initialElicitationValues seeds defaults, and an enum picks its first option', () => {
  const values = initialElicitationValues(parseElicitationSchema(SCHEMA));
  assert.equal(values.subscribe, true); // schema default
  assert.equal(values.name, '');
  assert.equal(values.age, '');
  // A select with no valid selection would submit '' and fail the server's own
  // validation, so an enum without a default starts at its first option.
  assert.equal(values.plan, 'free');
});

test('isElicitationComplete: a required boolean FALSE is a real answer', () => {
  const fields = parseElicitationSchema(SCHEMA);
  const values = initialElicitationValues(fields);
  assert.equal(isElicitationComplete(fields, values), false); // name still blank

  // `false` is the user saying no — judging emptiness by truthiness would leave
  // Submit disabled forever on a required checkbox.
  assert.equal(
    isElicitationComplete(fields, { ...values, name: 'Ada', subscribe: false }),
    true,
  );
  // Whitespace is not an answer.
  assert.equal(isElicitationComplete(fields, { ...values, name: '   ' }), false);
  // Optional fields never gate submission.
  assert.equal(isElicitationComplete(fields, { ...values, name: 'Ada', age: '' }), true);
});

test('buildElicitationContent coerces to the declared types', () => {
  const fields = parseElicitationSchema(SCHEMA);
  const content = buildElicitationContent(fields, {
    name: 'Ada',
    age: '42',
    ratio: '1.5',
    subscribe: false,
    plan: 'pro',
  });
  assert.deepEqual(content, { name: 'Ada', age: 42, ratio: 1.5, subscribe: false, plan: 'pro' });
  // Integers truncate rather than shipping a float the schema forbids.
  assert.equal(buildElicitationContent(fields, { age: '7.9' }).age, 7);
});

test('buildElicitationContent drops non-numeric numbers rather than sending NaN', () => {
  const fields = parseElicitationSchema(SCHEMA);
  // NaN is not representable in JSON and would corrupt the wire payload, so a
  // half-typed '-' or 'abc' is omitted entirely.
  for (const junk of ['', '-', 'abc']) {
    assert.equal('age' in buildElicitationContent(fields, { age: junk }), false);
  }
});

test('buildElicitationContent omits blank OPTIONAL text but keeps blank required', () => {
  const fields = parseElicitationSchema(SCHEMA);
  // An absent optional property and an empty-string one are different to a
  // validating server.
  const content = buildElicitationContent(fields, { name: 'Ada', plan: 'free' });
  assert.equal('age' in content, false);
  assert.deepEqual(content, { name: 'Ada', plan: 'free' });
});
