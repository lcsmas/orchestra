// Parsing an MCP elicitation's `requestedSchema` into the flat field list the
// renderer's form card builds inputs from (#21).
//
// WHY IT LIVES IN src/shared/ — this is the only genuinely tricky logic in the
// elicitation path (a JSON Schema arriving from an arbitrary MCP server, i.e.
// UNTRUSTED and possibly malformed), and putting it here makes it testable by
// `node --test` without rendering React. The card stays a dumb renderer over
// this output.
//
// SCOPE — MCP elicitation schemas are specified as FLAT objects of primitives:
// no nesting, no $ref, no combinators. So this deliberately does not implement
// JSON Schema; it reads the handful of keywords the spec allows and IGNORES the
// rest. Anything it cannot understand degrades to a text field rather than
// being dropped, because a dropped field silently produces an answer the server
// will reject — a field the user can still type into is strictly better.

import type { AgentElicitationValue } from './types';

/** One input the elicitation form card renders. */
export interface ElicitationField {
  /** Property name — the key in the answer's `content`. */
  name: string;
  /** Human label (`title` when the schema gives one, else the property name). */
  label: string;
  /** `description` from the schema, when present. */
  description?: string;
  /** Which control to render. `enum` becomes a select, `boolean` a checkbox,
   *  `number`/`integer` a numeric input, everything else a text input. */
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum';
  /** Allowed values for `kind: 'enum'`. */
  options?: string[];
  /** Whether the schema's `required` array names this property. */
  required: boolean;
  /** The schema's `default`, when it is a usable primitive. */
  defaultValue?: AgentElicitationValue;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Parse an elicitation `requestedSchema` into an ordered field list.
 *
 *  Never throws and never returns a partial-garbage field: a schema that is
 *  missing, malformed, or has no `properties` yields `[]`, which the card
 *  renders as a message-only confirmation rather than an empty broken form. */
export function parseElicitationSchema(schema: unknown): ElicitationField[] {
  const root = asRecord(schema);
  if (!root) return [];
  const props = asRecord(root.properties);
  if (!props) return [];
  // `required` is a string array per JSON Schema; tolerate it being absent or
  // the wrong type rather than throwing on a hostile schema.
  const required = new Set(
    Array.isArray(root.required) ? root.required.filter((r): r is string => typeof r === 'string') : [],
  );

  const fields: ElicitationField[] = [];
  for (const [name, raw] of Object.entries(props)) {
    const prop = asRecord(raw) ?? {};
    const enumValues = Array.isArray(prop.enum)
      ? prop.enum.filter((v): v is string => typeof v === 'string' || typeof v === 'number').map(String)
      : null;
    const type = typeof prop.type === 'string' ? prop.type : 'string';

    // An `enum` wins over `type`: it is the stronger constraint and the one the
    // server will validate against.
    let kind: ElicitationField['kind'];
    if (enumValues && enumValues.length > 0) kind = 'enum';
    else if (type === 'boolean') kind = 'boolean';
    else if (type === 'number') kind = 'number';
    else if (type === 'integer') kind = 'integer';
    else kind = 'string';

    const def = prop.default;
    const defaultValue: AgentElicitationValue | undefined =
      typeof def === 'string' || typeof def === 'number' || typeof def === 'boolean'
        ? def
        : Array.isArray(def) && def.every((d) => typeof d === 'string')
          ? (def as string[])
          : undefined;

    fields.push({
      name,
      label: typeof prop.title === 'string' && prop.title ? prop.title : name,
      ...(typeof prop.description === 'string' && prop.description
        ? { description: prop.description }
        : {}),
      kind,
      ...(kind === 'enum' && enumValues ? { options: enumValues } : {}),
      required: required.has(name),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    });
  }
  return fields;
}

/** The initial form state for a field list — each field's `default` when the
 *  schema gave one, else the empty value for its kind. */
export function initialElicitationValues(
  fields: ElicitationField[],
): Record<string, AgentElicitationValue> {
  const out: Record<string, AgentElicitationValue> = {};
  for (const f of fields) {
    if (f.defaultValue !== undefined) {
      out[f.name] = f.defaultValue;
      continue;
    }
    // An enum with no default pre-selects nothing meaningful, so it starts at
    // its first option — a select with no valid selection would otherwise
    // submit '' and fail the server's own validation.
    if (f.kind === 'enum') out[f.name] = f.options?.[0] ?? '';
    else if (f.kind === 'boolean') out[f.name] = false;
    else out[f.name] = '';
  }
  return out;
}

/** Whether every REQUIRED field has a usable value — the submit gate.
 *
 *  `false` is a legitimate answer for a required boolean (the user said no), so
 *  emptiness is judged per kind rather than by truthiness. Getting this wrong
 *  would leave Submit disabled forever on a required checkbox. */
export function isElicitationComplete(
  fields: ElicitationField[],
  values: Record<string, AgentElicitationValue>,
): boolean {
  return fields.every((f) => {
    if (!f.required) return true;
    const v = values[f.name];
    if (v === undefined) return false;
    if (typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (Array.isArray(v)) return v.length > 0;
    return v.trim().length > 0;
  });
}

/** Build the `content` payload for an `accept`, coercing each field to the type
 *  its schema declared.
 *
 *  Numeric coercion happens HERE rather than in the input's onChange so the
 *  user can type freely (an intermediate '' or '-' must not become NaN); a
 *  value that still isn't a finite number is DROPPED rather than sent as NaN,
 *  which is not representable in JSON and would corrupt the wire payload. */
export function buildElicitationContent(
  fields: ElicitationField[],
  values: Record<string, AgentElicitationValue>,
): Record<string, AgentElicitationValue> {
  const out: Record<string, AgentElicitationValue> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (v === undefined) continue;
    if (f.kind === 'number' || f.kind === 'integer') {
      // BLANK IS NOT ZERO. `Number('')` is 0, so a straight coercion would turn
      // an untouched optional numeric field into a deliberate-looking `0` the
      // server then acts on. An empty field is an ABSENT answer.
      const text = typeof v === 'number' ? String(v) : String(v).trim();
      if (text === '') continue;
      const n = Number(text);
      if (!Number.isFinite(n)) continue;
      out[f.name] = f.kind === 'integer' ? Math.trunc(n) : n;
      continue;
    }
    if (f.kind === 'boolean') {
      out[f.name] = typeof v === 'boolean' ? v : v === 'true';
      continue;
    }
    // Optional text left blank is omitted, not sent as '': an absent optional
    // property and an empty-string one are different to a validating server.
    if (typeof v === 'string' && v === '' && !f.required) continue;
    out[f.name] = v;
  }
  return out;
}
