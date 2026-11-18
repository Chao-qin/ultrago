export function parseJsonInput(raw: string): unknown {
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function jsonInputText(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function enumOptionIndex(options: unknown[], value: unknown): string | undefined {
  const index = options.findIndex((option) => JSON.stringify(option) === JSON.stringify(value));
  return index < 0 ? undefined : String(index);
}
