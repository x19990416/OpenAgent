const MAX_DESCRIPTION_LENGTH = 1600;
const SUPPORTED_SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'description',
  'additionalProperties',
  'oneOf',
  'anyOf',
  'allOf',
  '$defs',
  'definitions'
]);

export interface PiToolSchemaNormalizationResult {
  parameters: unknown;
  changed: boolean;
  beforeLength: number;
  afterLength: number;
}

export function normalizePiToolParameters(parameters: unknown): unknown {
  return normalizeSchemaValue(parameters, true);
}

export function normalizePiToolParametersWithReport(parameters: unknown): PiToolSchemaNormalizationResult {
  const before = safeStringify(parameters);
  const normalized = normalizePiToolParameters(parameters);
  const after = safeStringify(normalized);
  return {
    parameters: normalized,
    changed: before !== after,
    beforeLength: before.length,
    afterLength: after.length
  };
}

function normalizeSchemaValue(value: unknown, isRoot = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSchemaValue(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const type = normalizeSchemaType(input.type);

  for (const [key, rawValue] of Object.entries(input)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) continue;

    if (key === 'type') {
      if (type) output.type = type;
      continue;
    }

    if (key === 'description') {
      if (typeof rawValue === 'string') output.description = truncateDescription(rawValue);
      continue;
    }

    if (key === 'required') {
      if (Array.isArray(rawValue)) {
        output.required = [...new Set(rawValue.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))];
      }
      continue;
    }

    if (key === 'properties') {
      output.properties = normalizeProperties(rawValue);
      continue;
    }

    if (key === 'items') {
      output.items = normalizeSchemaValue(rawValue);
      continue;
    }

    if (key === 'enum') {
      if (Array.isArray(rawValue)) output.enum = rawValue.filter((item) => item !== undefined);
      continue;
    }

    if (key === 'additionalProperties') {
      if (typeof rawValue === 'boolean') {
        output.additionalProperties = rawValue;
      } else if (rawValue && typeof rawValue === 'object') {
        output.additionalProperties = normalizeSchemaValue(rawValue);
      }
      continue;
    }

    if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
      if (Array.isArray(rawValue)) output[key] = rawValue.map((item) => normalizeSchemaValue(item));
      continue;
    }

    if (key === '$defs' || key === 'definitions') {
      output[key] = normalizeProperties(rawValue);
    }
  }

  if (isRoot && !output.type) {
    output.type = 'object';
  }

  if ((output.type === 'object' || isRoot) && !output.properties && input.properties) {
    output.properties = normalizeProperties(input.properties);
  }

  return output;
}

function normalizeProperties(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, schema]) => [key, normalizeSchemaValue(schema)])
  );
}

function normalizeSchemaType(value: unknown) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const nonNullTypes = value.filter((item): item is string => typeof item === 'string' && item !== 'null');
    return nonNullTypes[0];
  }
  return undefined;
}

function truncateDescription(value: string) {
  return value.length > MAX_DESCRIPTION_LENGTH ? `${value.slice(0, MAX_DESCRIPTION_LENGTH)}…` : value;
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
