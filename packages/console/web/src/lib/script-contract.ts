import { UNCHECKED_PREFIX, validateRecordData } from '@bcp/shared';
import type { ParamSchemaFragment, ParamSpec } from '@bcp/shared';
import type { SchemaCitationInput } from '@bcp/shared';

const VISUAL_KEYS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'default',
  'description',
  'title',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'format',
  'x-bcp-schema-ref',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateScriptContractDefinition(
  schema: Record<string, unknown>,
): { ok: boolean; errors: string[] } {
  const result = validateRecordData(schema, undefined);
  const errors = (result.errors ?? [])
    .filter((message) => message.startsWith(UNCHECKED_PREFIX) && message.includes('schema 编译不了'))
    .map((message) => message.slice(UNCHECKED_PREFIX.length).trim());
  return { ok: errors.length === 0, errors };
}

export function parseScriptContract(raw?: string | ParamSchemaFragment | null): ParamSchemaFragment | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObject(value) || Object.keys(value).length === 0) return null;
  return value as ParamSchemaFragment;
}

export function schemaOfParams(params: ParamSpec[]): ParamSchemaFragment {
  const properties: Record<string, ParamSchemaFragment> = {};
  for (const param of params) {
    properties[param.name] = param.schemaRef
      ? { 'x-bcp-schema-ref': param.schemaRef }
      : { ...(param.schema ?? {}) };
    if (param.description !== undefined) properties[param.name].description = param.description;
  }
  const required = params.filter((param) => param.required).map((param) => param.name);
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

export function replaceObjectFields(schema: ParamSchemaFragment, params: ParamSpec[]): ParamSchemaFragment {
  const { properties: _properties, required: _required, ...metadata } = schema;
  return { ...metadata, ...schemaOfParams(params) };
}

export function schemaRefContract(ref: SchemaCitationInput): ParamSchemaFragment {
  return { 'x-bcp-schema-ref': ref };
}

export function scriptContractRef(schema: ParamSchemaFragment | null): SchemaCitationInput | undefined {
  const ref = schema?.['x-bcp-schema-ref'];
  if (!isObject(ref) || typeof ref.name !== 'string') return undefined;
  return typeof ref.version === 'number' ? { name: ref.name, version: ref.version } : { name: ref.name };
}

export function resolveScriptContract(
  schema: ParamSchemaFragment | null,
  resolve: (ref: SchemaCitationInput) => ParamSchemaFragment | null | undefined,
): ParamSchemaFragment | null {
  const ref = scriptContractRef(schema);
  return ref ? resolve(ref) ?? schema : schema;
}

export function visualContractProblems(schema: ParamSchemaFragment | null): string[] {
  const problems = new Set<string>();
  const visit = (value: unknown): void => {
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (!VISUAL_KEYS.has(key)) problems.add(key);
      if (key === 'properties' && isObject(child)) {
        for (const nested of Object.values(child)) visit(nested);
      } else if (key === 'items') {
        visit(child);
      }
    }
  };
  if (schema) visit(schema);
  return [...problems].sort();
}

export function inferSchema(value: unknown): ParamSchemaFragment {
  if (value === null || value === undefined) return {};
  if (typeof value === 'string') return { type: 'string' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: 'array', items: {} };
    const inferredItems = value.map((item) => inferSchema(item));
    const first = JSON.stringify(inferredItems[0]);
    return {
      type: 'array',
      items: inferredItems.every((item) => JSON.stringify(item) === first) ? inferredItems[0] : {},
    };
  }
  if (!isObject(value)) return {};
  const properties = Object.fromEntries(
    Object.entries(value).map(([name, child]) => [name, inferSchema(child)]),
  );
  const required = Object.keys(properties);
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

export function inferenceUncertainPaths(schema: ParamSchemaFragment, path = '$'): string[] {
  if (Object.keys(schema).length === 0) return [path];
  const paths: string[] = [];
  if (schema.type === 'object' && isObject(schema.properties)) {
    for (const [name, child] of Object.entries(schema.properties)) {
      if (isObject(child)) paths.push(...inferenceUncertainPaths(child as ParamSchemaFragment, `${path}.${name}`));
    }
  }
  if (schema.type === 'array' && isObject(schema.items)) {
    paths.push(...inferenceUncertainPaths(schema.items as ParamSchemaFragment, `${path}[]`));
  }
  return paths;
}

export function mergeInferredFields(
  current: ParamSchemaFragment | null | undefined,
  inferred: ParamSchemaFragment,
  selectedFields: string[],
): ParamSchemaFragment {
  if (inferred.type !== 'object' || !isObject(inferred.properties)) return inferred;
  const currentObject = current?.type === 'object' && isObject(current.properties) ? current : null;
  const selected = new Set(selectedFields);
  const properties: Record<string, unknown> = {
    ...(currentObject?.properties as Record<string, unknown> | undefined),
  };
  for (const [name, schema] of Object.entries(inferred.properties)) {
    if (selected.has(name)) properties[name] = schema;
  }
  const inferredRequired = new Set(Array.isArray(inferred.required) ? inferred.required.filter((name): name is string => typeof name === 'string') : []);
  const required = new Set(
    Array.isArray(currentObject?.required)
      ? currentObject.required.filter((name): name is string => typeof name === 'string' && !selected.has(name))
      : [],
  );
  for (const name of selected) {
    if (inferredRequired.has(name)) required.add(name);
  }
  const { properties: _properties, required: _required, ...metadata } = currentObject ?? {};
  return {
    ...metadata,
    type: 'object',
    properties,
    ...(required.size > 0 ? { required: [...required] } : {}),
  };
}

export function parseContractDefault(raw: string, schema: ParamSchemaFragment): unknown {
  if (schema.type === 'string' || schema.type === undefined) return raw;
  if (schema.type === 'number' || schema.type === 'integer') {
    const value = Number(raw);
    if (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) {
      throw new Error(schema.type === 'integer' ? '请输入有效的整数' : '请输入有效的数字');
    }
    return value;
  }
  if (schema.type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error('请输入 true 或 false');
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (schema.type === 'array' && !Array.isArray(value)) throw new Error('请输入 JSON 数组');
    if (schema.type === 'object' && (!isObject(value))) throw new Error('请输入 JSON 对象');
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('请输入')) throw error;
    throw new Error('请输入有效的 JSON');
  }
}
