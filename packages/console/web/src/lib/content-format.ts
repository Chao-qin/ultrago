export interface DetectedContent {
  kind: 'json' | 'markdown' | 'text';
  raw: string;
  value: unknown;
  warning?: string;
}

export const CONTENT_PREVIEW_LIMIT = 200_000;
export const CONTENT_PARSE_LIMIT = 2_000_000;

export function detectContent(value: unknown, contentType?: string): DetectedContent {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
  const mime = contentType?.split(';')[0].trim().toLowerCase();
  const text = { kind: 'text' as const, raw, value: raw };
  if (raw.length > CONTENT_PARSE_LIMIT) return { ...text, warning: '内容过大，已停止结构解析；仅显示部分原文，复制可获取收到的全部内容。' };
  if (mime === 'text/plain') return text;
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return { kind: 'markdown', raw, value: raw };
  const declaredJson = mime === 'application/json' || mime?.endsWith('+json');
  if (typeof value !== 'string') return { kind: 'json', raw, value };
  if (declaredJson || !mime || mime === 'application/octet-stream') {
    try {
      return { kind: 'json', raw, value: JSON.parse(raw) as unknown };
    } catch {
      if (declaredJson) return { ...text, warning: '内容声明为 JSON，但解析失败；已保留原文。' };
    }
  }
  if (!mime && /(^|\n)(#{1,6} |```|> |[-*+] \S|\d+\. \S)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\//.test(raw)) {
    return { kind: 'markdown', raw, value: raw };
  }
  return text;
}

export function safeContentHref(href: string): string | undefined {
  if (/[\u0000-\u0020]/.test(href)) return undefined;
  try {
    const url = new URL(href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}
