import { BRANCH_OTHERWISE_PORT } from './flow-types.js';
import type { BranchCase, BranchNodeConfig } from './flow-types.js';
import { DIAGNOSTIC_REDACTED } from './diagnostic-redaction.js';

export function readPath(value: unknown, path: string): unknown {
  const steps = path.replace(/^\$/, '').match(/\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]/g);
  if (!steps) return value;
  let current: unknown = value;
  for (const step of steps) {
    if (current == null) return undefined;
    if (step.startsWith('[')) {
      const index = Number(step.slice(1, -1));
      current = Array.isArray(current) ? current[index] : undefined;
      continue;
    }
    const key = step.slice(1);
    current = typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined;
  }
  return current;
}

export const BRANCH_CHOSE_NOTHING = '';

function operandOf(text: unknown, input: unknown): unknown {
  if (text === undefined || text === null) return undefined;
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  return trimmed.startsWith('$') ? readPath(input, trimmed) : trimmed;
}

function isEmptyValue(value: unknown): boolean {
  if (value == null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function compare(a: unknown, b: unknown): number {
  const na = typeof a === 'number' ? a : Number(a);
  const nb = typeof b === 'number' ? b : Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb ? 0 : na < nb ? -1 : 1;
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

export function matchesCase(branchCase: BranchCase, input: unknown): boolean {
  const left = operandOf(branchCase.left, input);
  switch (branchCase.op) {
    case 'isEmpty': return isEmptyValue(left);
    case 'isNotEmpty': return !isEmptyValue(left);
    case 'isTrue': return left === true || left === 'true';
    case 'isFalse': return left === false || left === 'false';
    default: break;
  }
  const right = operandOf(branchCase.right, input);
  switch (branchCase.op) {
    case 'eq': return looseEq(left, right);
    case 'ne': return !looseEq(left, right);
    case 'gt': return compare(left, right) > 0;
    case 'gte': return compare(left, right) >= 0;
    case 'lt': return compare(left, right) < 0;
    case 'lte': return compare(left, right) <= 0;
    case 'contains': return Array.isArray(left) ? left.some((item) => looseEq(item, right)) : String(left ?? '').includes(String(right ?? ''));
    case 'notContains': return !(Array.isArray(left) ? left.some((item) => looseEq(item, right)) : String(left ?? '').includes(String(right ?? '')));
    case 'startsWith': return String(left ?? '').startsWith(String(right ?? ''));
    case 'endsWith': return String(left ?? '').endsWith(String(right ?? ''));
    default: return false;
  }
}

export function selectBranch(config: BranchNodeConfig, input: unknown): string {
  for (const branchCase of config.cases ?? []) {
    if (matchesCase(branchCase, input)) return branchCase.id;
  }
  return config.otherwise ? BRANCH_OTHERWISE_PORT : BRANCH_CHOSE_NOTHING;
}

export interface BranchCaseExplanation {
  id: string;
  path: string;
  op: BranchCase['op'];
  value: unknown;
  right: unknown;
  presence: 'present' | 'missing' | 'redacted';
  matched: boolean | null;
}

function containsRedaction(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return !!serialized && (serialized.includes(DIAGNOSTIC_REDACTED) || /%(?:25)*5bREDACTED%(?:25)*5d/i.test(serialized));
  }
  catch { return true; }
}

function operandRedacted(text: unknown, input: unknown): boolean {
  if (containsRedaction(operandOf(text, input))) return true;
  if (typeof text !== 'string' || !text.trim().startsWith('$')) return false;
  if (input === DIAGNOSTIC_REDACTED) return true;
  const path = text.trim();
  for (const match of path.matchAll(/\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]/g)) {
    if (readPath(input, path.slice(0, match.index + match[0].length)) === DIAGNOSTIC_REDACTED) return true;
  }
  return false;
}

export function explainBranch(config: BranchNodeConfig, input: unknown): { selectedPort: string | null; cases: BranchCaseExplanation[] } {
  const cases = (config.cases ?? []).map((branchCase): BranchCaseExplanation => {
    const value = operandOf(branchCase.left, input);
    const unary = ['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'].includes(branchCase.op);
    const right = unary ? undefined : operandOf(branchCase.right, input);
    const redacted = operandRedacted(branchCase.left, input) || (!unary && operandRedacted(branchCase.right, input));
    return { id: branchCase.id, path: branchCase.left, op: branchCase.op, value, right, presence: redacted ? 'redacted' : value === undefined ? 'missing' : 'present', matched: redacted ? null : matchesCase(branchCase, input) };
  });
  // An unavailable earlier case may have won before a later visible match.
  for (const branchCase of cases) {
    if (branchCase.matched === null) return { selectedPort: null, cases };
    if (branchCase.matched) return { selectedPort: branchCase.id, cases };
  }
  return { selectedPort: config.otherwise ? BRANCH_OTHERWISE_PORT : BRANCH_CHOSE_NOTHING, cases };
}
