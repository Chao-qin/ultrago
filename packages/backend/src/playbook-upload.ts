import { isAbsolute, relative, resolve } from "node:path";

type AttachmentSource = {
  url?: unknown;
  imageUrl?: unknown;
  sourceUrl?: unknown;
  localPath?: unknown;
  filename?: unknown;
};

/** Materialize a book's canonical image list into upload_file attachments.
 *
 * Books keep product JSON portable by carrying relative localPath values. The
 * runner is the only layer that knows the machine-local product directory, so
 * it resolves that pair immediately before upload instead of forcing callers
 * to persist a duplicate detailAttachments field.
 */
export function materializePlaybookUpload(params: Record<string, unknown>): Record<string, unknown> {
  const attachmentsFrom = params.attachmentsFrom;
  const attachmentFrom = params.attachmentFrom;
  if (attachmentsFrom === undefined && attachmentFrom === undefined) return params;
  if (attachmentsFrom !== undefined && attachmentFrom !== undefined) {
    throw new Error("give attachmentFrom or attachmentsFrom, not both");
  }
  if (attachmentsFrom !== undefined && !Array.isArray(attachmentsFrom)) throw new Error("attachmentsFrom must be an array");
  const base = typeof params.attachmentBaseDir === "string" && isAbsolute(params.attachmentBaseDir)
    ? resolve(params.attachmentBaseDir)
    : null;
  const entries: unknown[] = attachmentsFrom === undefined ? [attachmentFrom] : attachmentsFrom;
  const normalizedEntries = entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [entry];
    const value = entry as { values?: unknown };
    return Array.isArray(value.values) ? value.values : [entry];
  });
  const attachments: Record<string, unknown>[] = [];
  normalizedEntries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`attachmentsFrom[${index}] must be an object`);
    const source = entry as AttachmentSource;
    const url = typeof source.url === "string" ? source.url : source.imageUrl;
    if (typeof url === "string" && url && url !== source.sourceUrl) {
      attachments.push({
        url,
        ...(typeof source.filename === "string" && source.filename ? { filename: source.filename } : {}),
      });
      return;
    }
    if (source.imageUrl === undefined && source.url === undefined && source.localPath === undefined) return [];
    if (typeof source.localPath !== "string" || !source.localPath || isAbsolute(source.localPath)) {
      throw new Error(`attachmentsFrom[${index}] needs a URL or non-empty relative localPath`);
    }
    if (!base) throw new Error(`attachmentsFrom[${index}] uses localPath but attachmentBaseDir is missing`);
    const localPath = resolve(base, source.localPath);
    const rel = relative(base, localPath);
    if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error(`attachmentsFrom[${index}].localPath escapes attachmentBaseDir`);
    }
    attachments.push({
      localPath,
      ...(typeof source.filename === "string" && source.filename ? { filename: source.filename } : {}),
    });
  });

  const { attachmentsFrom: _from, attachmentFrom: _one, attachmentBaseDir: _base, ...rest } = params;
  return { ...rest, attachments };
}
