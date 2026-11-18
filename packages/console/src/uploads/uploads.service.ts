import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UPLOAD_MAX_BYTES, type UploadedAttachment } from "@bcp/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Monorepo root = 4 levels up from packages/console/src/uploads/. Staged files
// live under resource/ with the other on-disk inputs, on the SAME machine that
// runs the books, which is why a staged file can be handed to a book as a
// plain localPath.
const UPLOADS_DIR = process.env.BCP_DATA_ROOT ? path.join(process.env.BCP_DATA_ROOT, 'resource/uploads') : path.resolve(__dirname, "../../../../resource/uploads");

const SAFE_MIME = /^[\w.+-]+\/[\w.+-]+$/;
/** Allowlist for a staged file name: letters (any script), digits, and the few
 * punctuation marks that carry meaning. Everything else — separators, control
 * characters, quotes, colons — is dropped rather than escaped. */
const UNSAFE_NAME_CHARS = /[^\p{L}\p{N}._ -]/gu;
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".pdf": "application/pdf",
};

/** Stages a file the user picked in the console so a book can attach it.
 *
 * Files are kept indefinitely: a schedule stores the produced `localPath` in
 * its params and re-runs it on every tick, so deleting the bytes would break
 * the schedule silently. The name is content-hashed, so re-picking the same
 * file reuses one copy instead of growing the directory. */
@Injectable()
export class UploadsService {
  save(bytes: Buffer, filename: string, mimeType: string): UploadedAttachment {
    if (!bytes?.length) throw new BadRequestException("upload body is empty");
    if (bytes.length > UPLOAD_MAX_BYTES) {
      throw new PayloadTooLargeException(`file too large (${bytes.length}B > ${UPLOAD_MAX_BYTES}B cap)`);
    }
    const safeName = sanitizeFilename(filename);
    const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}-${safeName}`;
    const localPath = path.join(UPLOADS_DIR, name);
    mkdirSync(UPLOADS_DIR, { recursive: true });
    writeFileSync(localPath, bytes);
    return {
      name,
      filename: safeName,
      mimeType: SAFE_MIME.test(mimeType) ? mimeType : guessMime(safeName),
      size: bytes.length,
      localPath,
      url: `/api/uploads/${encodeURIComponent(name)}`,
    };
  }

  /** Absolute path of a staged file, for serving it back. Anything that isn't
   * a direct child of resource/uploads/ is a 404 — this endpoint is not a file browser. */
  resolveStored(name: string): string {
    const abs = path.resolve(UPLOADS_DIR, name);
    if (path.dirname(abs) !== UPLOADS_DIR || !existsSync(abs)) {
      throw new NotFoundException(`no staged upload named ${name}`);
    }
    return abs;
  }
}

/** Keep the picked name recognizable while stripping everything that could
 * steer the write out of resource/uploads/ (separators, control chars, leading dots). */
export function sanitizeFilename(raw: string): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(UNSAFE_NAME_CHARS, "").replace(/^\.+/, "").trim();
  return cleaned ? cleaned.slice(-120) : "upload";
}

function guessMime(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] || "application/octet-stream";
}
