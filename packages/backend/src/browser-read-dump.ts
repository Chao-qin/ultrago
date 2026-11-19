import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { READ_DUMP_TTL_MS } from "@bcp/shared";

export interface ReadPageOverview {
  headings: string[];
  headingsTruncated?: boolean;
  excerpt: string;
}

export interface ReadDumpInput {
  url: string;
  title: string;
  text: string;
  totalChars: number;
  overview?: ReadPageOverview;
  maxChars?: number;
}

export interface ReadDumpChunk {
  index: number;
  path: string;
  offset: number;
  endOffset: number;
  chars: number;
}

export interface ReadDump {
  dumpId: string;
  directory: string;
  manifestPath: string;
  title: string;
  url: string;
  totalChars: number;
  chunkChars: number;
  chunkCount: number;
  overview: ReadPageOverview;
  chunks: ReadDumpChunk[];
}

const DEFAULT_CHUNK_CHARS = 12_000;
const SHORT_PAGE_CHARS = 16_000;
const MEDIUM_PAGE_CHARS = 64_000;
const MEDIUM_CHUNK_CHARS = 16_000;
const MAX_OVERVIEW_HEADINGS = 40;
const MAX_OVERVIEW_EXCERPT = 800;
const DUMP_TTL_MS = READ_DUMP_TTL_MS;

function defaultChunkChars(totalChars: number): number {
  if (totalChars <= SHORT_PAGE_CHARS) return Math.max(1, totalChars || DEFAULT_CHUNK_CHARS);
  if (totalChars <= MEDIUM_PAGE_CHARS) return MEDIUM_CHUNK_CHARS;
  return DEFAULT_CHUNK_CHARS;
}

function normalizeOverview(input: ReadPageOverview | undefined, text: string): ReadPageOverview {
  const headings = (input?.headings ?? [])
    .map((heading) => heading.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_OVERVIEW_HEADINGS);
  const sourceExcerpt = input?.excerpt || text.slice(0, MAX_OVERVIEW_EXCERPT);
  return {
    headings,
    ...(input?.headingsTruncated || (input?.headings?.length ?? 0) > headings.length ? { headingsTruncated: true } : {}),
    excerpt: sourceExcerpt.replace(/\s+/g, " ").trim().slice(0, MAX_OVERVIEW_EXCERPT),
  };
}

function overviewText(overview: ReadPageOverview): string {
  const headings = overview.headings.length
    ? overview.headings.map((heading) => `- ${heading}`).join("\n") + (overview.headingsTruncated ? "\n- … more headings in the page" : "")
    : "(no visible h1–h6 headings detected)";
  return `## Page overview\nHeadings:\n${headings}\nOpening excerpt: ${overview.excerpt || "(empty)"}`;
}

/**
 * Backend-owned, session-scoped page text dump. The MCP reply points at the
 * manifest instead of carrying the page body into the model transcript.
 * `cleanup()` is called before every subsequent browser RPC, so a dump lives
 * only for the current perceive/act round.
 */
export class PageReadDumpStore {
  private currentDir: string | null = null;
  private expiry: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();

  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async cleanup(): Promise<void> {
    await this.serialized(async () => {
      if (this.expiry) {
        clearTimeout(this.expiry);
        this.expiry = undefined;
      }
      const dir = this.currentDir;
      this.currentDir = null;
      if (dir) await rm(dir, { recursive: true, force: true });
    });
  }

  async dispose(): Promise<void> {
    await this.cleanup();
  }

  /** Read only a file from the currently-live dump. This is the MCP-facing
   * escape hatch for clients that do not expose a host filesystem reader. */
  async read(path: string, maxChars?: number): Promise<string> {
    return this.serialized(async () => {
      if (!this.currentDir) throw new Error("page text dump expired — call read_content or analyze_page again");
      const absolute = resolve(path);
      const rel = relative(this.currentDir, absolute);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error("path is outside the current page text dump");
      const raw = await readFile(absolute, "utf8");
      if (maxChars === undefined || raw.length <= maxChars) return raw;
      return `${raw.slice(0, maxChars)}\n\n[read_content_dump truncated this file at maxChars=${maxChars}]`;
    });
  }

  async create(input: ReadDumpInput): Promise<ReadDump> {
    return this.serialized(async () => {
      const old = this.currentDir;
      this.currentDir = null;
      if (this.expiry) {
        clearTimeout(this.expiry);
        this.expiry = undefined;
      }
      if (old) await rm(old, { recursive: true, force: true });

      const directory = await mkdtemp(join(tmpdir(), "bcp-page-read-"));
      this.currentDir = directory;
      const dumpId = directory.split(/[\\/]/).at(-1) ?? "bcp-page-read";
      const overview = normalizeOverview(input.overview, input.text);
      const chunkChars = Number.isInteger(input.maxChars) && (input.maxChars ?? 0) > 0
        ? input.maxChars!
        : defaultChunkChars(input.totalChars);
      const chunks: ReadDumpChunk[] = [];

      try {
        for (let offset = 0, index = 0; offset < input.text.length || (offset === 0 && input.text.length === 0); offset += chunkChars, index++) {
          const chunk = input.text.slice(offset, offset + chunkChars);
          const endOffset = offset + chunk.length;
          const filename = `chunk-${String(index).padStart(4, "0")}.txt`;
          const path = join(directory, filename);
          const body = [
            `# Page text dump — ${input.title || "(untitled)"}`,
            `URL: ${input.url}`,
            `Range: ${offset}-${endOffset} of ${input.totalChars} characters`,
            `Chunk: ${index + 1}`,
            "",
            overviewText(overview),
            "",
            "## Text",
            chunk,
            "",
          ].join("\n");
          await writeFile(path, body, "utf8");
          chunks.push({ index, path, offset, endOffset, chars: chunk.length });
          if (input.text.length === 0) break;
        }

        const manifestPath = join(directory, "manifest.json");
        const dump: ReadDump = {
          dumpId,
          directory,
          manifestPath,
          title: input.title,
          url: input.url,
          totalChars: input.totalChars,
          chunkChars,
          chunkCount: chunks.length,
          overview,
          chunks,
        };
        await writeFile(manifestPath, JSON.stringify({
          version: 1,
          ...dump,
          instructions: `Read this manifest, then open only the chunk files needed for the current question. The dump is deleted before the next browser operation, and after ${DUMP_TTL_MS / 60_000} minutes at most.`,
        }, null, 2) + "\n", "utf8");
        this.expiry = setTimeout(() => { void this.cleanup(); }, DUMP_TTL_MS);
        this.expiry.unref();
        return dump;
      } catch (error) {
        this.currentDir = null;
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    });
  }
}
