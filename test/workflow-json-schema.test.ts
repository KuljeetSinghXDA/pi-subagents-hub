/**
 * workflow-json-schema.test.ts — the validator behind `agent({ schema })`.
 *
 * Pure, no stubs: this is the one place that decides whether a script-supplied
 * JSON Schema is usable and whether a child's payload matches it. The most
 * important thing it pins is *which* typebox — the repo has both packages
 * installed and only one of them can do this.
 */

import { describe, expect, it } from "vitest";
import { compileJsonSchema } from "../src/workflow/json-schema.js";

/** A schema shaped like the one Claude Code's own example passes. */
const FINDINGS = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { file: { type: "string" }, line: { type: "integer", minimum: 1 } },
        required: ["file"],
      },
    },
  },
  required: ["findings"],
} as const;

const compile = (schema: unknown) => {
  const result = compileJsonSchema(schema);
  if (!result.ok) throw new Error(`expected a compiled schema, got: ${result.message}`);
  return result.compiled;
};

describe("compiling a script-supplied schema", () => {
  it("accepts a plain JSON Schema, with no TypeBox ceremony", () => {
    // The whole feature rests on this: `@sinclair/typebox` throws `Unknown
    // type` on a schema with no Kind symbol, so if this ever regresses to that
    // package every schema call dies at the first validation.
    expect(compileJsonSchema(FINDINGS).ok).toBe(true);
  });

  it("keeps the schema object as given, for the tool and the journal key", () => {
    expect(compile(FINDINGS).schema).toBe(FINDINGS);
  });

  it("refuses anything that cannot be a tool's input schema", () => {
    for (const bad of [5, "x", null, undefined, [], { type: "array" }, { type: "string" }]) {
      const result = compileJsonSchema(bad);
      expect(result.ok, `${JSON.stringify(bad)} should not compile`).toBe(false);
    }
  });

  it("says why a non-object root is refused", () => {
    const result = compileJsonSchema({ type: "array" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/type: "object"/);
  });

  it("refuses a schema too large to be worth sending", () => {
    const huge = { type: "object", properties: { a: { type: "string", description: "x".repeat(70_000) } } };
    const result = compileJsonSchema(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/too large/);
  });

  it("refuses a schema it cannot walk, rather than failing at the first call", () => {
    const result = compileJsonSchema({ type: "object", properties: { a: { type: "nonsense" } } });
    // Either rejected here or provably checkable — what must not happen is a
    // compile that succeeds and then throws inside a child's tool handler.
    if (result.ok) expect(() => result.compiled.check({ a: 1 })).not.toThrow();
    else expect(result.message).toMatch(/agent\(\) opts\.schema/);
  });
});

describe("refusing a schema no value could satisfy", () => {
  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "an unknown keyword",
      { type: "object", properties: { a: { type: "string", prefixItems: [] } } },
      /unknown keyword/,
    ],
    [
      "a non-draft-07 $schema",
      { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {} },
      /no schema with key|unknown keyword|draft-07/,
    ],
    ["$async", { $async: true, type: "object", properties: {} }, /\$async/],
    [
      "crossed bounds",
      { type: "object", properties: { n: { type: "number", minimum: 10, maximum: 1 } } },
      /minimum 10 above maximum 1/,
    ],
    [
      "an enum no value of its type can match",
      { type: "object", properties: { a: { type: "string", enum: [1, 2] } } },
      /none of which its type "string" can match/,
    ],
    [
      "an empty enum",
      { type: "object", properties: { a: { enum: [] } } },
      /is empty/,
    ],
    [
      "required without a properties entry",
      { type: "object", properties: { b: { type: "string" } }, required: ["a"] },
      /has no properties entry/,
    ],
    [
      "required that additionalProperties forbids",
      { type: "object", properties: {}, required: ["a"], additionalProperties: false },
      /additionalProperties is false/,
    ],
    [
      "a malformed pattern",
      { type: "object", properties: { a: { type: "string", pattern: "(" } } },
      /regular expression/i,
    ],
  ];

  for (const [name, schema, expected] of refused) {
    it(`refuses ${name}`, () => {
      const result = compileJsonSchema(schema);
      expect(result.ok, `${name} should not compile`).toBe(false);
      if (!result.ok) expect(result.message).toMatch(expected);
    });
  }

  it("refuses a schema nested past the traversal cap without overflowing the stack", () => {
    // 12k levels: `JSON.stringify` would recurse that deep too, so the guard has
    // to run before it.
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 12_000; i++) deep = { type: "object", properties: { a: deep } };
    const result = compileJsonSchema(deep);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/too large or too deeply nested/);
  });

  it("does not mistake a property named after a keyword for the keyword", () => {
    // `properties.required` is data, not a `required` clause.
    const schema = {
      type: "object",
      properties: { required: { type: "string" }, enum: { type: "string" } },
      required: ["required"],
    };
    expect(compileJsonSchema(schema).ok).toBe(true);
  });

  it("still accepts a schema that is merely unusual", () => {
    // Formats are not validated, unions are legal, and `$defs` is walked as
    // schemas while its keys stay names.
    const schema = {
      type: "object",
      properties: {
        when: { type: "string", format: "date-time" },
        either: { oneOf: [{ type: "string" }, { type: "number", minimum: 0, maximum: 10 }] },
        ref: { $ref: "#/$defs/thing" },
      },
      required: ["when"],
      $defs: { thing: { type: "object", properties: { n: { type: "integer" } } } },
    };
    expect(compileJsonSchema(schema).ok).toBe(true);
  });
});

describe("checking a payload", () => {
  it("passes a conforming value", () => {
    expect(compile(FINDINGS).check({ findings: [{ file: "a.ts", line: 3 }] })).toBe(true);
  });

  it("passes when an optional field is absent", () => {
    expect(compile(FINDINGS).check({ findings: [{ file: "a.ts" }] })).toBe(true);
  });

  it("names the missing property at the root", () => {
    const message = compile(FINDINGS).check({});
    expect(message).not.toBe(true);
    expect(message).toMatch(/findings/);
    expect(message).toContain("$:");
  });

  it("names the offending path in JavaScript notation, not JSON Pointer", () => {
    // The model wrote the schema in JavaScript; `$.findings.0.line` is legible
    // to it in a way `/findings/0/line` is not.
    const message = compile(FINDINGS).check({ findings: [{ file: "a.ts", line: 0 }] });
    expect(message).not.toBe(true);
    expect(message).toContain("$.findings.0.line");
    expect(message).not.toContain("/findings/");
  });

  it("names every missing property, so one retry can fix them all", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
      required: ["a", "b", "c"],
    };
    const message = String(compile(schema).check({}));
    for (const missing of ["a", "b", "c"]) expect(message).toContain(missing);
  });

  it("reports distinct problems separately, each with its own path", () => {
    const schema = {
      type: "object",
      properties: { n: { type: "integer", minimum: 1 }, s: { type: "string" } },
      required: ["s"],
    };
    const message = String(compile(schema).check({ n: 0 }));
    // A missing property at the root and a bad value below it are two different
    // things to fix; collapsing them would hide one behind the other.
    expect(message).toContain("$: ");
    expect(message).toContain("$.n: ");
    expect(message.split("; ")).toHaveLength(2);
  });

  it("rejects a value of the wrong type entirely", () => {
    expect(compile(FINDINGS).check("not an object")).not.toBe(true);
    expect(compile(FINDINGS).check(null)).not.toBe(true);
  });

  it("never throws, whatever it is handed", () => {
    const compiled = compile(FINDINGS);
    const cyclic: Record<string, unknown> = { findings: [] };
    cyclic.self = cyclic;
    for (const value of [undefined, Number.NaN, cyclic, new Map(), Symbol("s")]) {
      expect(() => compiled.check(value)).not.toThrow();
    }
  });
});
