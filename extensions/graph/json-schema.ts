import { isDeepStrictEqual } from "node:util";

export interface JsonSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  minLength?: number;
  items?: JsonSchema;
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
  const errors: string[] = [];

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    return [`${path} must be ${schema.type}`];
  }
  if (
    schema.enum !== undefined &&
    !schema.enum.some((candidate) => isDeepStrictEqual(candidate, value))
  ) {
    errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} must have length >= ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${path} must match ${schema.pattern}`);
    }
  }

  if (
    typeof value === "number" &&
    schema.minimum !== undefined &&
    value < schema.minimum
  ) {
    errors.push(`${path} must be >= ${schema.minimum}`);
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      errors.push(...validateJsonSchema(item, schema.items, `${path}[${index}]`));
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in record)) {
        errors.push(`${path}.${required} is required`);
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(record)) {
      const childSchema = properties[key];
      if (childSchema !== undefined) {
        errors.push(...validateJsonSchema(child, childSchema, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      }
    }
  }

  return errors;
}
