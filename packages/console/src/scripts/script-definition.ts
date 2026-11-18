import { BadRequestException } from '@nestjs/common';
import { UNCHECKED_PREFIX, validateRecordData } from '@bcp/shared';

export function normalizeScriptLanguage(value?: string): 'ts' {
  if (value === undefined || ['javascript', 'typescript', 'js', 'ts'].includes(value)) return 'ts';
  throw new BadRequestException(`不支持的脚本语言：${value}`);
}

export function normalizeScriptSchema(value?: string): string {
  if (value === undefined || value.trim() === 'null') return '{}';
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Schema 必须是 JSON 对象');
    const validation = validateRecordData(parsed as Record<string, unknown>, undefined);
    const schemaErrors = (validation.errors ?? [])
      .filter((message) => message.startsWith(UNCHECKED_PREFIX) && message.includes('schema 编译不了'))
      .map((message) => message.slice(UNCHECKED_PREFIX.length).trim());
    if (schemaErrors.length > 0) throw new Error(`Schema 结构无效：${schemaErrors.join('；')}`);
    return JSON.stringify(parsed);
  } catch (error) {
    throw new BadRequestException(`Schema 无效：${error instanceof Error ? error.message : String(error)}`);
  }
}
