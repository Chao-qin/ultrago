import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INLINE_OUTPUT_LIMIT } from '../runs/output-type.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const OUTPUT_DIR = 'resource/flow-runs';

export interface NodeOutputIdentity {
  flowRunId?: string;
  nodeId?: string;
  iteration?: number | null;
}

export function storeNodeOutput(output: unknown, identity: NodeOutputIdentity, warn: (message: string) => void): string | null {
  if (output === undefined) return null;
  const json = JSON.stringify(output);
  const { flowRunId, nodeId, iteration } = identity;
  if (json.length <= INLINE_OUTPUT_LIMIT || !flowRunId || !nodeId) return json;
  try {
    const suffix = iteration === null || iteration === undefined ? '' : `__${iteration}`;
    // 下划线也需转义，节点 x__1 与节点 x 的第 1 次迭代不能共用文件。
    const name = encodeURIComponent(nodeId).replace(/_/g, '%5F');
    // 晚到的落地请求不能覆盖终态节点仍在引用的文件。
    const digest = createHash('sha256').update(json).digest('hex');
    const relative = path.join(OUTPUT_DIR, encodeURIComponent(flowRunId), `${name}${suffix}-${digest}.json`);
    const absolute = path.join(ROOT, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, json, 'utf8');
    return JSON.stringify({ $ref: relative, bytes: json.length });
  } catch (error) {
    warn(`flow node ${nodeId}: output offload failed; keeping inline — ${error instanceof Error ? error.message : String(error)}`);
    return json;
  }
}

export function readNodeOutput(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  const value: unknown = JSON.parse(json);
  const parsed = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value };
  if (typeof parsed.$ref !== 'string') return parsed;
  const relative = parsed.$ref;
  try {
    const absolute = path.resolve(ROOT, relative);
    if (path.isAbsolute(relative) || !absolute.startsWith(`${ROOT}${path.sep}`)) throw new Error('path escapes repository');
    const stored: unknown = JSON.parse(readFileSync(absolute, 'utf8'));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || '$ref' in stored) throw new Error('invalid output checkpoint');
    return stored as Record<string, unknown>;
  } catch (error) {
    throw new Error(`节点产出文件读不出来：${relative}`, { cause: error });
  }
}
