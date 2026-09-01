import { isDeepStrictEqual } from "node:util";

export interface JsonSchema {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  enum?: unknown[];
  const?: unknown;
  oneOf?: JsonSchema[];
  pattern?: string;
  format?: string;
  minimum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  items?: JsonSchema;
}

/**
 * RFC 3339 date-time. `Date.parse` then rejects in-shape-but-impossible
 * instants such as `2026-13-45T99:99:99Z`.
 */
const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u;

function resolvePointer(ref: string, root: JsonSchema): JsonSchema | undefined {
  if (ref === "#") {
    return root;
  }
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let current: unknown = root;
  for (const token of ref.slice(2).split("/")) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    const segment = token.replaceAll("~1", "/").replaceAll("~0", "~");
    current = (current as Record<string, unknown>)[segment];
  }
  return current as JsonSchema | undefined;
}

/**
 * `$ref` replaces the schema wholesale; the shipped schemas never pair a local
 * `$ref` with sibling keywords. Returns a message instead when the chain is
 * cyclic or dangling.
 */
function resolveSchema(schema: JsonSchema, root: JsonSchema): JsonSchema | string {
  let current = schema;
  const seen = new Set<string>();
  while (current.$ref !== undefined) {
    if (seen.has(current.$ref)) {
      return `has a cyclic $ref ${current.$ref}`;
    }
    seen.add(current.$ref);
    const target = resolvePointer(current.$ref, root);
    if (target === undefined) {
      return `references unknown schema ${current.$ref}`;
    }
    current = target;
  }
  return current;
}

function valueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (expected === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (expected === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return valueType(value) === expected;
}

export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  path = "$",
): string[] {
  return validate(value, schema, path, schema);
}

function validate(
  value: unknown,
  schema: JsonSchema,
  path: string,
  root: JsonSchema,
): string[] {
  const resolved = resolveSchema(schema, root);
  if (typeof resolved === "string") {
    return [`${path} ${resolved}`];
  }

  const errors: string[] = [];

  if (resolved.type !== undefined && !matchesType(value, resolved.type)) {
    return [`${path} must be ${resolved.type}`];
  }
  if (
    resolved.enum !== undefined &&
    !resolved.enum.some((candidate) => isDeepStrictEqual(candidate, value))
  ) {
    errors.push(`${path} must be one of ${resolved.enum.join(", ")}`);
  }
  if ("const" in resolved && !isDeepStrictEqual(resolved.const, value)) {
    errors.push(`${path} must equal ${JSON.stringify(resolved.const)}`);
  }

  if (resolved.oneOf !== undefined) {
    const branches = resolved.oneOf.map((branch) =>
      validate(value, branch, path, root),
    );
    const matched = branches.filter((branch) => branch.length === 0).length;
    if (matched === 0) {
      // Report the near-miss so a discriminated union names its own failure.
      const closest = branches.reduce(
        (best, branch) => (branch.length < best.length ? branch : best),
        branches[0] ?? [],
      );
      errors.push(
        `${path} must match one of ${branches.length} variants`,
        ...closest,
      );
    } else if (matched > 1) {
      errors.push(`${path} must match exactly one variant, matched ${matched}`);
    }
  }

  if (typeof value === "string") {
    if (resolved.minLength !== undefined && value.length < resolved.minLength) {
      errors.push(`${path} must have length >= ${resolved.minLength}`);
    }
    if (resolved.maxLength !== undefined && value.length > resolved.maxLength) {
      errors.push(`${path} must have length <= ${resolved.maxLength}`);
    }
    if (resolved.pattern !== undefined && !new RegExp(resolved.pattern, "u").test(value)) {
      errors.push(`${path} must match ${resolved.pattern}`);
    }
    if (
      resolved.format === "date-time" &&
      !(DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value)))
    ) {
      errors.push(`${path} must be a date-time`);
    }
  }

  if (
    typeof value === "number" &&
    resolved.minimum !== undefined &&
    value < resolved.minimum
  ) {
    errors.push(`${path} must be >= ${resolved.minimum}`);
  }

  if (Array.isArray(value)) {
    if (resolved.minItems !== undefined && value.length < resolved.minItems) {
      errors.push(`${path} must have at least ${resolved.minItems} items`);
    }
    if (resolved.items !== undefined) {
      for (const [index, item] of value.entries()) {
        errors.push(...validate(item, resolved.items, `${path}[${index}]`, root));
      }
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const required of resolved.required ?? []) {
      if (!(required in record)) {
        errors.push(`${path}.${required} is required`);
      }
    }
    const properties = resolved.properties ?? {};
    for (const [key, child] of Object.entries(record)) {
      const childSchema = properties[key];
      if (childSchema !== undefined) {
        errors.push(...validate(child, childSchema, `${path}.${key}`, root));
      } else if (resolved.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      }
    }
  }

  return errors;
}
