const PREFIX = 'bcp-step-preview:v1:';
const RESULT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StepResultMetadata {
  resultId: string;
  chars: number;
  truncated: boolean;
  upstreamTruncated: boolean;
}

export function encodeStepPreview(preview: string, metadata: StepResultMetadata): string {
  return PREFIX + JSON.stringify({ preview, metadata });
}

export function decodeStepPreview(value: string | null): { preview: string; metadata?: StepResultMetadata } {
  if (value?.startsWith(PREFIX)) {
    try {
      const parsed = JSON.parse(value.slice(PREFIX.length));
      const meta = parsed.metadata;
      if (typeof parsed.preview === 'string' && meta && typeof meta.resultId === 'string' && RESULT_ID.test(meta.resultId)
        && Number.isSafeInteger(meta.chars) && meta.chars >= 0 && typeof meta.truncated === 'boolean' && typeof meta.upstreamTruncated === 'boolean') {
        return { preview: parsed.preview, metadata: meta };
      }
    } catch {
      return { preview: value };
    }
  }
  return { preview: value ?? '' };
}

export function stepResultSource(runId: string, resultId: string): string {
  return `step-result:${runId}:${resultId}`;
}
