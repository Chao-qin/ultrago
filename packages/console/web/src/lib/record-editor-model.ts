import { validateRecordData } from '@bcp/shared';
import type { JsonValue } from './types';

export type EditorPath = (string | number)[];
export type EditorSchema = Record<string, unknown>;
export type EditorResolver = (ref?: { name: string; version?: number }) => EditorSchema | null;
export type EditorIssue = { path: EditorPath; message: string };
export type EditorChange = { path: EditorPath; before: unknown; after: unknown };

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function pointer(path: EditorPath): string {
  return path.length ? `/${path.map((key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}` : '/';
}
export function getValue(value: unknown, path: EditorPath): unknown {
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
export function setValue(value: unknown, path: EditorPath, next: unknown): unknown {
  if (!path.length) return next;
  const [key, ...rest] = path;
  if (Array.isArray(value)) {
    const copy = [...value];
    if (!rest.length && next === undefined) copy.splice(Number(key), 1);
    else copy[Number(key)] = setValue(copy[Number(key)], rest, next);
    return copy;
  }
  const copy = isObject(value) ? { ...value } : {};
  if (!rest.length && next === undefined) delete copy[key];
  else Object.defineProperty(copy, key, { value: setValue(getValue(copy, [key]), rest, next), enumerable: true, configurable: true, writable: true });
  return copy;
}
export function equalValues(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => equalValues(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equalValues(a[key], b[key]));
  }
  return false;
}
export function diffValues(before: unknown, after: unknown, path: EditorPath = []): EditorChange[] {
  if (equalValues(before, after)) return [];
  if (isObject(before) && isObject(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) => diffValues(getValue(before, [key]), getValue(after, [key]), [...path, key]));
  return [{ path, before, after }];
}
export function parseDraft(raw: string): { ok: true; value: JsonValue } | { ok: false; error: string } {
  try { return { ok: true, value: JSON.parse(raw) as JsonValue }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'JSON 格式无效' }; }
}
export function submissionData(value: JsonValue): JsonValue {
  // The API treats string payloads as serialized JSON, including JSON string roots.
  return typeof value === 'string' ? JSON.stringify(value) : value;
}
export function resolveEditorSchema(input: unknown, root: EditorSchema, resolver?: EditorResolver): EditorSchema {
  let schema = isObject(input) ? input : {};
  const seen = new Set<string>();
  for (let depth = 0; depth < 20; depth++) {
    const ref = schema.$ref;
    const citation = schema['x-bcp-schema-ref'];
    let target: unknown;
    let identity: string;
    if (typeof ref === 'string' && ref.startsWith('#/')) {
      identity = ref;
      target = getValue(root, ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')));
    } else if (isObject(citation) && typeof citation.name === 'string') {
      identity = JSON.stringify(citation);
      target = resolver?.({ name: citation.name, version: typeof citation.version === 'number' ? citation.version : undefined });
    } else return schema;
    if (seen.has(identity) || !isObject(target)) return { ...schema, type: undefined };
    seen.add(identity);
    const { $ref: _ref, 'x-bcp-schema-ref': _citation, ...local } = schema;
    schema = { ...target, ...local };
  }
  return { ...schema, type: undefined };
}
export function schemaFields(schema: EditorSchema, root: EditorSchema, resolver?: EditorResolver) {
  const properties = isObject(schema.properties) ? schema.properties : {};
  return Object.entries(properties).map(([key, child]) => {
    const resolved = resolveEditorSchema(child, root, resolver);
    return { key, schema: resolved, label: typeof resolved.title === 'string' ? resolved.title : key };
  });
}
export function fieldIndex(schema: EditorSchema, root: EditorSchema, value: unknown, resolver?: EditorResolver, path: EditorPath = [], depth = 0): { path: EditorPath; label: string; description: string }[] {
  if (depth > 12) return [];
  const resolved = resolveEditorSchema(schema, root, resolver);
  return schemaFields(resolved, root, resolver).flatMap((field) => {
    const next = [...path, field.key];
    const item = { path: next, label: field.label, description: typeof field.schema.description === 'string' ? field.schema.description : '' };
    const children = fieldIndex(field.schema, root, getValue(value, [field.key]), resolver, next, depth + 1);
    const array = getValue(value, [field.key]);
    if (Array.isArray(array) && isObject(field.schema.items)) {
      array.forEach((entry, i) => children.push(...fieldIndex(field.schema.items as EditorSchema, root, entry, resolver, [...next, i], depth + 1)));
    }
    return [item, ...children];
  });
}
export function validateEditorData(schema: EditorSchema | null, value: unknown, resolver?: EditorResolver): EditorIssue[] {
  if (!schema) return [];
  const issues = validationIssues(schema, value);
  const visit = (input: EditorSchema, current: unknown, root: EditorSchema, path: EditorPath, depth: number) => {
    if (current === undefined) return;
    if (depth > 20) { issues.push({ path, message: '引用层级过深，无法完成本地校验' }); return; }
    const citation = input['x-bcp-schema-ref'];
    if (isObject(citation) && typeof citation.name === 'string') {
      const target = resolver?.({ name: citation.name, version: typeof citation.version === 'number' ? citation.version : undefined });
      if (!target) { issues.push({ path, message: `引用的 Schema「${citation.name}」未加载` }); return; }
      issues.push(...validationIssues(target, current).map((issue) => ({ ...issue, path: [...path, ...issue.path] })));
      visit(target, current, target, path, depth + 1);
      return;
    }
    const resolved = resolveEditorSchema(input, root, resolver);
    if (isObject(current)) {
      const properties = isObject(resolved.properties) ? resolved.properties : {};
      for (const [key, child] of Object.entries(properties)) {
        if (isObject(child)) visit(child, getValue(current, [key]), root, [...path, key], depth + 1);
      }
    }
    if (Array.isArray(current) && isObject(resolved.items)) {
      current.forEach((item, index) => visit(resolved.items as EditorSchema, item, root, [...path, index], depth + 1));
    }
  };
  visit(schema, value, schema, [], 0);
  return issues;
}
function validationIssues(schema: EditorSchema, value: unknown): EditorIssue[] {
  const result = validateRecordData(schema, value);
  return (result.errors ?? []).map((message) => {
    const match = message.match(/^(\/\S*)\s/);
    const path: EditorPath = match && match[1] !== '/' ? match[1].slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
    const required = message.match(/must have required property '(.+)'/);
    if (required) path.push(required[1]);
    return { path, message: required ? `请填写必填字段「${required[1]}」` : message.replace(/^\/\S*\s/, '') };
  });
}
export function valueSummary(value: unknown): string {
  if (value === undefined) return '未设置';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `${value.length} 项`;
  if (isObject(value)) {
    const named = ['name', 'title', 'label', 'shopName', 'id'].map((key) => value[key]).find((item) => typeof item === 'string' && item);
    return named ? String(named) : `${Object.keys(value).length} 个字段`;
  }
  return String(value) || '空文本';
}
export function editorDefault(input: EditorSchema, root = input, resolver?: EditorResolver, depth = 0): unknown {
  if (depth > 12) return undefined;
  const schema = resolveEditorSchema(input, root, resolver);
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.type === 'object') return Object.fromEntries(schemaFields(schema, root, resolver).map((field) => [field.key, editorDefault(field.schema, root, resolver, depth + 1)]).filter(([, value]) => value !== undefined));
  if (schema.type === 'array') return [];
  return undefined;
}
