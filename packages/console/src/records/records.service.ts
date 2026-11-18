import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Monorepo root = 4 levels up from packages/console/src/records/, same depth as
// uploads.service.ts's packages/console/src/uploads/ (../../../../ from a
// packages/console/src/<folder>/ file lands on the repo root either way).
const RECORDS_DIR = process.env.BCP_DATA_ROOT ? path.join(process.env.BCP_DATA_ROOT, 'resource/records') : path.resolve(__dirname, "../../../../resource/records");

const SAFE_MIME = /^[\w.+-]+\/[\w.+-]+$/;
/** Allowlist for a stored file name: letters (any script), digits, and the few
 * punctuation marks that carry meaning. Everything else — separators, control
 * characters, quotes, colons — is dropped rather than escaped. */
const UNSAFE_NAME_CHARS = /[^\p{L}\p{N}._ -]/gu;
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain",
  ".json": "application/json", ".csv": "text/csv",
};

/** What a stored record looks like once written to disk. */
export interface StoredRecord {
  /** File name inside resource/records/ (content hash + safe name) — this is
   * the only thing a DB row keeps besides `url`. */
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
}

/** Stores a run's non-JSON payload — markdown / images / any file a schema
 * couldn't define a column for. Payload convergence rule: schema-able output
 * goes to a DB column, everything else lands here and the DB row keeps only
 * `fileName` + `url`. This is the write side of that split; RunsService (a
 * later task) is the caller. */
@Injectable()
export class RecordsService {
  save(bytes: Buffer, filename: string, mimeType: string): StoredRecord {
    if (!bytes?.length) throw new BadRequestException("record body is empty");
    // Deliberately NO size cap here, unlike uploads.service.ts's UPLOAD_MAX_BYTES
    // (25MB). That cap guards an *upload* entry point — a browser tab handing the
    // server bytes, where an unbounded body is an attacker's or a mistake's lever
    // on server memory. records/ is the opposite direction: it's where a run's
    // OWN already-computed output lands after schema convergence decided it
    // doesn't fit a DB column. Capping it doesn't protect against anything — it
    // just makes the system refuse to store its own results. This isn't
    // hypothetical: reports/doudian-category-properties.json is already
    // 28,652,646 bytes on disk, over the uploads cap.
    const safeName = sanitizeFilename(filename);
    const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}-${safeName}`;
    const localPath = path.join(RECORDS_DIR, name);
    mkdirSync(RECORDS_DIR, { recursive: true });
    writeFileSync(localPath, bytes);
    return {
      fileName: name,
      mimeType: SAFE_MIME.test(mimeType) ? mimeType : guessMime(safeName),
      size: bytes.length,
      url: `/api/records/${encodeURIComponent(name)}`,
    };
  }

  /** Absolute path of a stored record, for serving it back. Anything that isn't
   * a direct child of resource/records/ is a 404 — this endpoint is not a file browser. */
  resolveStored(name: string): string {
    const abs = path.resolve(RECORDS_DIR, name);
    if (path.dirname(abs) !== RECORDS_DIR || !existsSync(abs)) {
      throw new NotFoundException(`no stored record named ${name}`);
    }
    return abs;
  }
}

/** Keep the picked name recognizable while stripping everything that could
 * steer the write out of resource/records/ (separators, control chars, leading dots). */
export function sanitizeFilename(raw: string): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(UNSAFE_NAME_CHARS, "").replace(/^\.+/, "").trim();
  return cleaned ? cleaned.slice(-120) : "record";
}

function guessMime(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] || "application/octet-stream";
}
