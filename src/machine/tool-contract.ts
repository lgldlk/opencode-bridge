"use strict";

import type { JsonObject } from "../shared/types.ts";

interface ToolSchema {
  type?: string;
  required?: unknown;
  properties?: unknown;
  [key: string]: unknown;
}
interface ToolDefinition {
  parameters?: unknown;
  description?: unknown;
}
interface ValidationOptions { strict?: boolean; [key: string]: unknown; }

function schemaFor(definition: ToolDefinition | undefined): ToolSchema {
  const schema = definition?.parameters;
  return schema && typeof schema === "object" && !Array.isArray(schema) ? schema as ToolSchema : {};
}

function requiredFields(_name: string, definition: ToolDefinition | undefined): string[] {
  const schema = schemaFor(definition);
  if (Array.isArray(schema.required)) {
    return schema.required.filter((field) => typeof field === "string" && field.length > 0);
  }
  return [];
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && (!(typeof value === "string") || value.trim().length > 0);
}

function matchesType(value: unknown, type: string | undefined): boolean {
  if (!type) return true;
  if (type === "string") return typeof value === "string";
  if (type === "number" || type === "integer") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return true;
}

function validateClientToolArguments(name: string, args: unknown, definition: ToolDefinition | undefined, _options: ValidationOptions = {}) {
  const value = args && typeof args === "object" && !Array.isArray(args) ? args as JsonObject : null;
  if (!value) return { ok: false, message: `${name} arguments must be a JSON object` };

  const schema = schemaFor(definition);
  for (const field of requiredFields(name, definition)) {
    if (!hasValue(value[field])) return { ok: false, message: `${name} requires argument "${field}"` };
  }

  const properties: Record<string, ToolSchema> = schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, ToolSchema>
    : {};
  for (const [field, fieldSchema] of Object.entries(properties)) {
    if (!hasValue(value[field]) || !fieldSchema || typeof fieldSchema !== "object") continue;
    if (!matchesType(value[field], fieldSchema.type)) {
      return { ok: false, message: `${name}.${field} must be a ${fieldSchema.type}` };
    }
  }

  return { ok: true, value };
}

function sanitizeClientToolArguments(name: string, args: unknown, definition: ToolDefinition | undefined, options: ValidationOptions = {}) {
  const result = validateClientToolArguments(name, args, definition, options);
  return result.ok
    ? result
    : {
      ok: false,
      error: Object.assign(new Error(result.message), {
        status: 422,
        data: { type: "invalid_tool_arguments", tool: name, message: result.message },
      }),
    };
}

function clientToolContract(definitions: Map<string, ToolDefinition>, toolMap: Map<string, string>) {
  return [...toolMap.entries()].map(([openCodeName, clientName]) => {
    const definition = definitions.get(clientName);
    const schema = schemaFor(definition);
    return {
      name: clientName,
      openCodeTool: openCodeName,
      description: typeof definition?.description === "string" ? definition.description : undefined,
      parameters: schema,
    };
  });
}

module.exports = {
  clientToolContract,
  sanitizeClientToolArguments,
  validateClientToolArguments,
};
