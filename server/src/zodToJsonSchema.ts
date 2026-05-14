import { z, ZodTypeAny } from "zod";

// Minimal Zod -> JSON Schema converter covering what we use in tools.ts.
// Avoids pulling in a 200KB dependency for a handful of shapes.

export function zodToJsonSchema(schema: ZodTypeAny): any {
  return convert(schema);
}

function convert(s: ZodTypeAny): any {
  const def: any = (s as any)._def;
  const typeName: string = def.typeName;
  switch (typeName) {
    case "ZodString":
      return { type: "string" };
    case "ZodNumber": {
      const out: any = { type: "number" };
      for (const c of def.checks ?? []) {
        if (c.kind === "int") out.type = "integer";
        if (c.kind === "min") out.minimum = c.value;
        if (c.kind === "max") out.maximum = c.value;
      }
      return out;
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: def.values };
    case "ZodLiteral":
      return { const: def.value };
    case "ZodArray": {
      const out: any = { type: "array", items: convert(def.type) };
      if (def.minLength) out.minItems = def.minLength.value;
      if (def.maxLength) out.maxItems = def.maxLength.value;
      return out;
    }
    case "ZodObject": {
      const shape = def.shape();
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape) as [string, ZodTypeAny][]) {
        properties[key] = convert(value);
        if (!isOptional(value)) required.push(key);
      }
      const out: any = { type: "object", properties };
      if (required.length) out.required = required;
      return out;
    }
    case "ZodOptional":
    case "ZodDefault":
      return convert(def.innerType);
    case "ZodEffects":
      return convert(def.schema);
    case "ZodUnion":
      return { anyOf: def.options.map((o: ZodTypeAny) => convert(o)) };
    default:
      return {};
  }
}

function isOptional(s: ZodTypeAny): boolean {
  const t = (s as any)._def.typeName;
  return t === "ZodOptional" || t === "ZodDefault";
}

// Pull z import in so unused-import lint doesn't strip it (defensive).
export const _z = z;
