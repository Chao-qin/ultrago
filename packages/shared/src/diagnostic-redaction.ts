export const DIAGNOSTIC_REDACTED = '[REDACTED]';
const MAX_DEPTH = 16;
const MAX_STRING_LENGTH = 1_000_000;

function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return /token|authorization|cookie|session|password|passwd|apikey|secret|credential|privatekey/.test(normalized);
}

function credentialText(value: string): boolean {
  if (/\bbearer\s+\S+/i.test(value)) return true;
  const keys = /"((?:\\.|[^"\\])*)"\s*[:=]|'([^']*)'\s*[:=]|([A-Za-z][A-Za-z0-9_. -]{0,199})\s*[:=]/g;
  for (const match of value.matchAll(keys)) {
    let key = match[1] ?? match[2] ?? match[3];
    if (match[1] !== undefined) {
      try { key = JSON.parse(`"${key}"`) as string; }
      catch { return true; }
    }
    if (sensitiveKey(key)) return true;
  }
  return false;
}

export function redactDiagnostic(value: unknown): unknown {
  const ancestors = new WeakSet<object>();
  function text(current: string, depth: number): string {
    // Undecodable escape layers can hide both credential keys and URL boundaries.
    if (/\\(?:["\\]|u)/i.test(current)) return DIAGNOSTIC_REDACTED;
    if (credentialText(current)) return DIAGNOSTIC_REDACTED;
    const unescaped = current.replace(/\\\//g, '/');
    const safe = unescaped.replace(/https?:\/\/(?:[^\s<>"']+)/gi, (url) => String(visit(url, depth + 1)));
    if (safe === unescaped) return current;
    return unescaped === current ? safe : DIAGNOSTIC_REDACTED;
  }
  function visit(current: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) return DIAGNOSTIC_REDACTED;
    if (typeof current === 'string') {
      if (current.length > MAX_STRING_LENGTH) return DIAGNOSTIC_REDACTED;
      const trimmed = current.trim();
      if (/^[\[{"']/.test(trimmed)) {
        try { return JSON.stringify(visit(JSON.parse(trimmed), depth + 1)); }
        catch { return text(current, depth); }
      }
      if (/^(?:[a-z][a-z\d+.-]*:\/\/|(?:javascript|data|vbscript|file|blob|about|mailto|tel):)/i.test(trimmed)) {
        if (!/^https?:\/\//i.test(trimmed)) return DIAGNOSTIC_REDACTED;
        try {
          const url = new URL(trimmed);
          let changed = !!(url.username || url.password || url.hash);
          url.username = '';
          url.password = '';
          url.hash = '';
          const parameters = new URLSearchParams();
          for (const [key, item] of url.searchParams) {
            const safe = sensitiveKey(key) ? DIAGNOSTIC_REDACTED : String(visit(item, depth + 1));
            if (safe !== item) changed = true;
            parameters.append(key, safe);
          }
          if (!changed) return current;
          // Removed URL components must remain distinguishable from original evidence.
          if (!parameters.getAll('__diagnostic_redacted').includes(DIAGNOSTIC_REDACTED)) parameters.append('__diagnostic_redacted', DIAGNOSTIC_REDACTED);
          url.search = parameters.toString();
          return url.href;
        } catch { return DIAGNOSTIC_REDACTED; }
      }
      return text(current, depth);
    }
    if (current == null || typeof current === 'boolean') return current;
    if (typeof current === 'number') return Number.isFinite(current) ? current : null;
    if (current instanceof Date) return Number.isFinite(current.getTime()) ? current.toISOString() : null;
    if (typeof current !== 'object') return DIAGNOSTIC_REDACTED;
    if (ancestors.has(current)) return DIAGNOSTIC_REDACTED;
    ancestors.add(current);
    try {
      if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1));
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(current)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) {
          Object.defineProperty(result, key, { value: DIAGNOSTIC_REDACTED, enumerable: true, configurable: true, writable: true });
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        result[key] = sensitiveKey(key) || !descriptor || !('value' in descriptor)
          ? DIAGNOSTIC_REDACTED : visit(descriptor.value, depth + 1);
      }
      return result;
    } finally { ancestors.delete(current); }
  }
  return visit(value, 0);
}
