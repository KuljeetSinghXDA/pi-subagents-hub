/**
 * json-schema.ts — validating a script-supplied JSON Schema.
 *
 * `agent(prompt, { schema })` hands us a raw JSON Schema written by a model, to
 * be used two ways: as a tool's `parameters` (so the provider fills the fields)
 * and as the check that decides whether what came back is usable.
 *
 * ## Which typebox
 *
 * **`typebox`, not `@sinclair/typebox`.** They are different packages.
 * `@sinclair/typebox` (0.34) dispatches on a `Kind` symbol that a schema
 * arriving over the wire does not carry, so `Value.Check` throws `Unknown type`
 * on a plain JSON Schema — and `Type.Unsafe` does not help, it stamps a `Kind`
 * that is not registered. `typebox` v1 is a standards JSON Schema validator and
 * takes the schema as-is. It is also the package pi itself types
 * `ToolDefinition.parameters` against and supplies to extensions at runtime
 * (a peer dependency here), so the same schema object serves both roles with no
 * conversion.
 *
 * ## Two validators, two jobs
 *
 * **Ajv validates the schema; typebox validates the payload.** Ajv is the only
 * one of the two that can say whether a schema is legal draft-07 — it has the
 * meta-schemas, and its strict mode rejects a keyword it does not know
 * (`prefixItems`, a stray `x-…`) that typebox would silently ignore. Typebox is
 * the one that can check a payload in this process without a compile step, and
 * it is already the package pi hands tool parameters to. So Ajv runs once, when
 * `agent({ schema })` is called, and typebox runs on every payload.
 *
 * Neither can say whether any value could satisfy the schema. That is the lint
 * below: a crossed bound or an `enum` of the wrong type matches nothing, and the
 * script would see only `null` after the child burned a turn and a retry.
 *
 * ## Why we validate at all
 *
 * Nothing in pi checks a tool call's arguments against the tool's `parameters`.
 * `validateToolCall`/`validateToolArguments` exist in `pi-ai` but are never
 * called from either shipped package, so a schema on a tool is a *prompt to the
 * provider*, not an enforcement point. Every guarantee the script gets about
 * the shape of its result is made here.
 *
 * Pure and pi-free on purpose, so `runtime.ts` can import it without dragging
 * sessions and models into the runtime's tests.
 */

import Ajv from "ajv";
import { Check, Errors } from "typebox/value";

/** Largest schema we will accept, serialized. */
const MAX_SCHEMA_BYTES = 64 * 1024;

/**
 * Traversal bounds, checked before anything walks the schema.
 *
 * `JSON.stringify` above already visits every node, so a pathologically nested
 * schema would blow the stack in the size check itself; this runs first and
 * fails with a message instead.
 */
const MAX_SCHEMA_NODES = 100_000;
const MAX_SCHEMA_DEPTH = 1_000;

/** Prefix for the schema-side refusals, so one grep finds them all. */
const INVALID_PREFIX = "agent() opts.schema is not a valid draft-07 JSON Schema: ";

/** How many validation errors are quoted back to the model. */
const MAX_REPORTED_ERRORS = 5;

export interface CompiledSchema {
  /** The schema as given, for the tool's `parameters` and the journal key. */
  readonly schema: Record<string, unknown>;
  /** `true`, or a human-readable account of what is wrong. */
  check(value: unknown): true | string;
}

export type SchemaCompilation =
  | { ok: true; compiled: CompiledSchema }
  | { ok: false; message: string };

/**
 * Turn a script-supplied schema into something we can check against.
 *
 * Rejects up front rather than at the first tool call. A schema whose root is
 * not an object cannot be a tool's input schema at all, so it would break every
 * request the child makes rather than just the last one — and the author should
 * hear about that before a model is paid to discover it.
 */
export function compileJsonSchema(schema: unknown): SchemaCompilation {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { ok: false, message: "agent() opts.schema must be a JSON Schema object." };
  }
  const root = schema as Record<string, unknown>;
  if (root.type !== "object") {
    return {
      ok: false,
      message:
        'agent() opts.schema must have `type: "object"` at its root — it becomes the tool\'s input schema, '
        + "and a non-object root is not something a model can be asked to fill.",
    };
  }

  if (exceedsSizeGuard(root)) {
    return {
      ok: false,
      message: `${INVALID_PREFIX}it is too large or too deeply nested (over ${MAX_SCHEMA_NODES} nodes or ${MAX_SCHEMA_DEPTH} levels).`,
    };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(root);
  } catch {
    return { ok: false, message: "agent() opts.schema must be JSON-serializable." };
  }
  if (serialized.length > MAX_SCHEMA_BYTES) {
    return {
      ok: false,
      message: `agent() opts.schema is too large (${serialized.length} bytes; the limit is ${MAX_SCHEMA_BYTES}).`,
    };
  }

  // Ajv knows nothing about async schemas: it compiles one and then hands back
  // a promise the runtime would treat as a value.
  if (root.$async !== undefined) {
    return { ok: false, message: `${INVALID_PREFIX}$async schemas are not supported.` };
  }

  // What no meta-schema can say: whether any value could satisfy the schema.
  // A schema that matches nothing burns the child's turn and its retry, and the
  // script only sees `null` — so it is refused before an agent starts.
  const lint = lintJsonSchema(root);
  if (lint !== undefined) return { ok: false, message: `${INVALID_PREFIX}${lint}.` };

  // Draft-07 legality, then a real compile: strict mode is what rejects an
  // unknown keyword (`prefixItems`, a stray `x-…`), and compiling is what
  // rejects a malformed `pattern` — `validateSchema` accepts both.
  const ajv = new Ajv({ allErrors: true, validateFormats: false, multipleOfPrecision: 6, logger: false });
  try {
    if (!ajv.validateSchema(root)) {
      return { ok: false, message: `${INVALID_PREFIX}${ajv.errorsText(ajv.errors)}.` };
    }
    ajv.compile(root);
  } catch (error) {
    return { ok: false, message: `${INVALID_PREFIX}${error instanceof Error ? error.message : String(error)}` };
  }

  // Smoke-tested here so a schema the validator cannot walk fails at the call
  // that wrote it, with the schema in hand, rather than inside a child's tool
  // handler where the only symptom is an agent that never returns.
  try {
    Check(root, {});
  } catch (error) {
    return {
      ok: false,
      message: `agent() opts.schema is not a schema this runtime can validate: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return { ok: true, compiled: { schema: root, check: value => checkAgainst(root, value) } };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * True once more than MAX_SCHEMA_NODES nodes were visited or nesting passes
 * MAX_SCHEMA_DEPTH.
 *
 * Iterative on purpose: a recursive walk would overflow the stack on exactly the
 * schemas this exists to refuse.
 */
function exceedsSizeGuard(root: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let remaining = MAX_SCHEMA_NODES;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (--remaining < 0 || depth > MAX_SCHEMA_DEPTH) return true;
    for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
  }
  return false;
}

/**
 * Schema-side checks a meta-schema cannot make: the schema is legal, but no
 * value could ever satisfy it.
 *
 * Returns the first finding as a `$`-path sentence, or undefined. Walks
 * subschemas only — `properties`/`patternProperties`/`$defs` map keys and
 * `enum`/`const`/`default` values are data, not schemas.
 */
function lintJsonSchema(root: Record<string, unknown>): string | undefined {
  return lintSchema(root, "$");
}

function lintSchema(node: unknown, path: string): string | undefined {
  if (!isRecord(node)) return undefined;
  const declared = typeof node.type === "string" ? node.type : undefined;

  for (const key of ["enum", "const"] as const) {
    const values = key === "enum"
      ? (Array.isArray(node.enum) ? node.enum : undefined)
      : (node.const === undefined ? undefined : [node.const]);
    if (values === undefined) continue;
    if (values.length === 0) return `${path}.${key} is empty, so no value can match it`;
    if (declared !== undefined && values.every(value => !matchesType(value, declared))) {
      return `${path}.${key} offers ${values.map(value => JSON.stringify(value)).join(", ")}, none of which its type "${declared}" can match`;
    }
  }

  const bounds: Array<[string, string]> = [
    ["minimum", "maximum"],
    ["exclusiveMinimum", "exclusiveMaximum"],
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
    ["minProperties", "maxProperties"],
  ];
  for (const [low, high] of bounds) {
    const a = node[low];
    const b = node[high];
    if (typeof a === "number" && typeof b === "number" && a > b) {
      return `${path} declares ${low} ${a} above ${high} ${b}, which no value can satisfy`;
    }
  }

  if (Array.isArray(node.required)) {
    const properties = isRecord(node.properties) ? node.properties : {};
    for (const name of node.required) {
      if (typeof name !== "string" || Object.hasOwn(properties, name)) continue;
      return node.additionalProperties === false
        ? `${path}.required names "${name}", which neither properties nor patternProperties define, and additionalProperties is false`
        : `${path}.required names "${name}", which has no properties entry — give it a schema or drop it from required`;
    }
  }

  for (const key of ["properties", "patternProperties", "$defs", "definitions"] as const) {
    const map = node[key];
    if (!isRecord(map)) continue;
    for (const [name, child] of Object.entries(map)) {
      const found = lintSchema(child, `${path}.${key}.${name}`);
      if (found !== undefined) return found;
    }
  }
  for (const key of ["additionalProperties", "not", "if", "then", "else", "contains", "propertyNames"] as const) {
    const found = lintSchema(node[key], `${path}.${key}`);
    if (found !== undefined) return found;
  }
  for (const key of ["items", "prefixItems", "allOf", "anyOf", "oneOf"] as const) {
    const list = node[key];
    const children = Array.isArray(list) ? list : [list];
    for (let i = 0; i < children.length; i++) {
      const found = lintSchema(children[i], Array.isArray(list) ? `${path}.${key}[${i}]` : `${path}.${key}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Whether a JSON value is of a draft-07 `type`. Unknown types pass. */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "string": return typeof value === "string";
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
    default: return true;
  }
}

function checkAgainst(schema: Record<string, unknown>, value: unknown): true | string {
  let valid: boolean;
  try {
    valid = Check(schema, value);
  } catch (error) {
    // Reported rather than thrown: a schema that compiled but trips on a
    // particular value must fail that call, not the run.
    return `the value could not be validated: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (valid) return true;

  const reported: string[] = [];
  try {
    for (const error of Errors(schema, value)) {
      // `instancePath` is JSON Pointer (`/a/b`); the model wrote the schema in
      // JavaScript, so it reads `$.a.b` far more easily.
      const path = String(error.instancePath ?? "");
      const where = path === "" ? "$" : `$${path.replace(/\//g, ".")}`;
      reported.push(`${where}: ${error.message}`);
      if (reported.length >= MAX_REPORTED_ERRORS) break;
    }
  } catch {
    // Errors() can trip where Check() merely returned false. A vaguer message
    // still names the right problem.
  }
  return reported.length > 0 ? reported.join("; ") : "the value does not match the required schema";
}
