import { Injectable, Logger, Inject } from "@nestjs/common";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PrismaService } from "../prisma/prisma.service.js";
import { SchemasService } from "../schemas/schemas.service.js";
import { jsonSchemaToParamSpecs, parseCitation, type JsonSchemaDoc } from "@bcp/shared";
import type { BookParamSchema } from "@bcp/shared";
import type { Delivery } from "@bcp/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Monorepo root = 4 levels up from packages/console/src/filesync/
const MONOREPO_ROOT = path.resolve(__dirname, "../../../../");

/** Scans `resource/playbooks/*.json` and upserts a `Book` row
 *  per file. The console NEVER writes to the JSON — it stores management
 *  metadata only. A `description` / `enabled` / `tags` change in the UI writes
 *  the DB row but leaves the JSON file alone. This is intentional: the JSON
 *  remains the portable artifact (can be committed, shared, replayed by an MCP
 *  agent without the console).
 *
 *  (This list used to say `cronExpr`, which stopped being a `Book` column when
 *  schedules moved to their own table — `cronExpr` lives on `Schedule` now.
 *  The three named above are exactly what `BooksService.update` accepts.) */
@Injectable()
export class FilesyncService {
  private readonly logger = new Logger(FilesyncService.name);
  private readonly playbooksDir = process.env.BCP_PLAYBOOKS_DIR || path.resolve(MONOREPO_ROOT, "resource/playbooks");

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SchemasService) private readonly schemas: SchemasService,
  ) {}

  /** Rescan resource/playbooks/. New files → INSERT, modified files → UPDATE
   *  params schema / goal / mtime / hash, and rows whose file is gone → left in
   *  place but REPORTED, in the log and in the returned `missing` list.
   *
   *  Leaving the row is deliberate: the file might have been renamed rather
   *  than retired, and the run history hanging off it is not the user's to lose
   *  by accident. Reporting it is the half that was missing. Until 2026-08-28
   *  this comment claimed the warning already existed and that "the UI can flag
   *  these as stale"; neither was ever written, so a book whose file had been
   *  deleted stayed listed, enabled and triggerable, and a run would happily
   *  execute the last-indexed copy out of `Book.playbookJson`. The scan walked
   *  only the directory and never asked the other question — which rows have no
   *  file? — so nothing could have noticed.
   *
   *  Deliberately NOT done here: no soft-delete (that column means "the user
   *  withdrew this", a different fact, and there is no restore route to undo a
   *  wrong guess), and no persisted "stale" flag (it would be a cache of a
   *  filesystem fact refreshed only by a manual rescan, hence wrong in both
   *  directions between scans). Triggering is not blocked either — that is a
   *  policy change, separable from making the drift visible.
   *
   *  A file whose derived values all match the row is skipped, not rewritten.
   *  Prisma's `@updatedAt` fires on any `update`, identical data included, so
   *  an unconditional upsert made every scan a write of all six rows — which
   *  is how the tracked `resource/db/console.db` kept going dirty.
   *
   *  The comparison is over the whole derived payload, NOT `fileHash` alone.
   *  `paramSchema` / `outputSchema` can come from the Schema registry via
   *  `paramSchemaRef` / `outputSchemaRef` (see `resolveRef`), and an unpinned
   *  ref resolves to whatever version is active — so the registry moving under
   *  an unchanged file must still land. Hashing the file answers "did the file
   *  change", which is a different question from "is the row still right".
   *
   *  `fileMtime` is deliberately NOT part of that comparison: git rewrites
   *  mtimes on checkout, and a byte-identical file arriving with a new mtime is
   *  exactly the no-op write this exists to stop. The column therefore means
   *  "the mtime this content was seen with", which is what `BookDetail.tsx`
   *  shows next to the sha1 — the pair stays self-consistent. */
  async rescan(): Promise<RescanResult> {
    if (!existsSync(this.playbooksDir)) {
      this.logger.warn(`playbooks dir not found: ${this.playbooksDir}`);
      // Emphatically NOT `missing: every book`. An unreadable directory says
      // nothing about any individual file, and answering "they are all gone"
      // to a question we could not ask is the worst available answer.
      return { indexed: 0, written: 0, missing: [] };
    }
    const files = readdirSync(this.playbooksDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    // `deletedAt` rides along only to scope the orphan report to books the user
    // can still see. It stays out of DERIVED_SELECT / DERIVED_KEYS, which are
    // about what a file decides — a soft-deleted row is still upserted by name,
    // exactly as before.
    const existing = new Map(
      (await this.prisma.book.findMany({ select: { ...DERIVED_SELECT, deletedAt: true } })).map(
        (b) => [b.name, b],
      ),
    );
    const missing = orphanBookNames(
      files,
      [...existing.values()].filter((b) => b.deletedAt === null).map((b) => b.name),
    );
    let indexed = 0;
    let written = 0;
    for (const f of files) {
      const abs = path.join(this.playbooksDir, f);
      const stat = statSync(abs);
      const raw = readFileSync(abs, "utf8");
      const hash = createHash("sha1").update(raw).digest("hex");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        this.logger.warn(`playbook ${f} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — skipping`);
        continue;
      }
      const pb = parsed as {
        name?: string;
        goal?: string;
        goalDetail?: string;
        paramNames?: string[];
        params?: BookParamSchema[];
        outputSchema?: Record<string, unknown>;
        paramSchemaRef?: string;
        outputSchemaRef?: string;
        deliveries?: Delivery[];
        steps?: unknown[];
      };
      if (!pb.name || !Array.isArray(pb.steps)) {
        this.logger.warn(`playbook ${f} is missing required fields (name / steps) — skipping`);
        continue;
      }
      const name = f.replace(/\.json$/, "");
      const ctx: ResolveCtx = { schemas: this.schemas, warn: (m) => this.logger.warn(m), book: name };
      const paramSchema = JSON.stringify(await resolveParamSchema(pb, ctx));
      const deliveriesJson = JSON.stringify(Array.isArray(pb.deliveries) ? pb.deliveries : []);
      const outputSchema = await resolveOutputSchema(pb, ctx);
      const paramSchemaRef = pb.paramSchemaRef ?? null;
      const outputSchemaRef = pb.outputSchemaRef ?? null;
      const goal = pb.goal ?? "";
      const goalDetail = pb.goalDetail ?? null;
      // Normalize legacy fields (paramNames→params) so the stored JSON is
      // consistent for downstream consumers (backend internal-runner).
      const normalizedPb = normalizePlaybookJson(parsed as Record<string, unknown>);
      const playbookJson = JSON.stringify(normalizedPb);

      indexed++;
      // Everything the file (or a ref it cites) decides. Excludes `fileMtime`,
      // which is written alongside these but never compared, and the columns
      // the UI owns (cronExpr / enabled / tags / description) — clobbering
      // those is what the `update` branch has always been careful not to do.
      const derived: Derived = {
        goal,
        goalDetail,
        filePath: `resource/playbooks/${f}`,
        fileHash: hash,
        playbookJson,
        paramSchema,
        outputSchema,
        paramSchemaRef,
        outputSchemaRef,
        deliveriesJson,
        stepsCount: pb.steps.length,
      };
      const prev = existing.get(name);
      if (prev && DERIVED_KEYS.every((k) => prev[k] === derived[k])) continue;

      await this.prisma.book.upsert({
        where: { name },
        create: { name, description: goal || null, fileMtime: stat.mtime, ...derived },
        update: { fileMtime: stat.mtime, ...derived },
      });
      written++;
    }
    this.logger.log(
      `filesync: ${indexed} playbook(s) indexed, ${written} written, ${indexed - written} already current`,
    );
    if (missing.length > 0) {
      // warn, not log: this is the one outcome of a scan that needs a decision
      // from a person. Nothing here acts on it — see the note on `rescan`.
      this.logger.warn(
        `filesync: ${missing.length} book(s) have no file in ${this.playbooksDir}: ${missing.join(", ")} — ` +
          `each row, its schedules and its stored playbookJson are all still live, so it can still be triggered ` +
          `and would run the last-indexed copy. Delete the book in the UI if that is what you meant.`,
      );
    }
    return { indexed, written, missing };
  }
}

/** What a rescan observed. `missing` is a report, never an action. */
export interface RescanResult {
  indexed: number;
  written: number;
  /** Live book names with no JSON file backing them, sorted. */
  missing: string[];
}

/** The book names that have no file backing them — the DB side of the
 *  reconciliation, which `rescan` never used to walk.
 *
 *  The seen-set is built from the FILENAME list rather than from the books the
 *  scan managed to parse, and that distinction is the whole correctness of this
 *  function. A file that is present but momentarily unparseable — a half-written
 *  save, a bad merge, an editor's atomic-rename window — is skipped by the loop
 *  in `rescan`, and folding that skip into this set would report the book as
 *  gone every time someone saves a broken edit. Present-but-broken and absent
 *  are different facts and get different answers.
 *
 *  Pure and exported so it can be tested directly, the way `resolveParamSchema`
 *  here and `buildLeaseAcquire` in the scheduler already are. */
export function orphanBookNames(files: string[], liveBookNames: Iterable<string>): string[] {
  const onDisk = new Set(files.map((f) => f.replace(/\.json$/, "")));
  return [...liveBookNames].filter((name) => !onDisk.has(name)).sort();
}

/** The file-derived half of a `Book`: the columns a rescan is allowed to
 *  overwrite, and therefore exactly the columns worth comparing before it
 *  bothers. `fileMtime` is written but not listed — see `rescan`. */
type Derived = {
  goal: string;
  goalDetail: string | null;
  filePath: string;
  fileHash: string;
  playbookJson: string;
  paramSchema: string;
  outputSchema: string | null;
  paramSchemaRef: string | null;
  outputSchemaRef: string | null;
  deliveriesJson: string;
  stepsCount: number;
};

const DERIVED_KEYS = [
  "goal",
  "goalDetail",
  "filePath",
  "fileHash",
  "playbookJson",
  "paramSchema",
  "outputSchema",
  "paramSchemaRef",
  "outputSchemaRef",
  "deliveriesJson",
  "stepsCount",
] as const satisfies ReadonlyArray<keyof Derived>;

// `satisfies` above only proves every entry IS a key of `Derived`; it says
// nothing about entries being MISSING, and a missing one silently drops a
// column from the comparison — a rescan would then skip a file whose contract
// really did change. This is the half that catches that: if any key of
// `Derived` is absent from DERIVED_KEYS, `Exclude` is non-never, the alias
// resolves to `never`, and the assignment below fails to compile.
// (Verified 2026-08-28 by deleting "paramSchema" from DERIVED_KEYS:
//  `error TS2322: Type 'true' is not assignable to type 'never'.`)
type MissingFromDerivedKeys = Exclude<keyof Derived, (typeof DERIVED_KEYS)[number]>;
const DERIVED_KEYS_ARE_EXHAUSTIVE: [MissingFromDerivedKeys] extends [never] ? true : never = true;
void DERIVED_KEYS_ARE_EXHAUSTIVE;

/** `name` rides along to key the map; the rest is exactly `DERIVED_KEYS`. */
const DERIVED_SELECT = {
  name: true,
  ...Object.fromEntries(DERIVED_KEYS.map((k) => [k, true])),
} as { name: true } & { [K in keyof Derived]: true };

/** What the ref-aware resolvers need from the outside world: the registry to
 *  look a citation up in, somewhere to report a disagreement, and the book name
 *  to name in that report. */
export interface ResolveCtx {
  schemas: Pick<SchemasService, "resolve">;
  warn: (msg: string) => void;
  book: string;
}

/** Resolve one `"name@version"` citation to its parsed JSON Schema document.
 *  Returns null — never throws — when the citation does not resolve, so a
 *  registry that is empty, lagging, or unreachable degrades the book to its
 *  inline contract instead of taking it out of service. Whether a book can run
 *  must not be hostage to the availability of the registry. */
async function resolveRef(ref: string, ctx: ResolveCtx): Promise<Record<string, unknown> | null> {
  try {
    const cited = parseCitation(ref);
    const row = await ctx.schemas.resolve(cited.name, cited.version);
    const parsed = JSON.parse(row.jsonSchema) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      ctx.warn(`book ${ctx.book}: schema "${ref}" is not a JSON object — falling back to the inline contract`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    ctx.warn(
      `book ${ctx.book}: cannot resolve schema "${ref}" (${e instanceof Error ? e.message : String(e)}) — falling back to the inline contract`,
    );
    return null;
  }
}

/** Resolve the params schema for one playbook.
 *
 * `paramSchemaRef` is the source of truth when present: the contract is read
 * from the `Schema` registry and `Book.paramSchema` becomes a CACHE of it. With
 * no ref, the inline `params` stay the source of truth (unchanged path below).
 *
 * When BOTH exist they are compared and any disagreement is only WARNED about,
 * with the registry's answer still returned. The registry is the declared truth
 * once a book cites it, but a mismatch is a drift report, not a reason to fail
 * the sync — the inline copy is kept for exactly one release cycle as the
 * rollback path, and a book must stay runnable while the two converge.
 *
 * Deep equality, not string equality: the round trip through
 * `paramSpecsToJsonSchema` reorders sibling keys (`description` before
 * `default`), so comparing serializations would report drift on books whose
 * contracts are in fact identical. */
export async function resolveParamSchema(
  pb: { params?: BookParamSchema[]; paramNames?: string[]; paramSchemaRef?: string },
  ctx: ResolveCtx,
): Promise<BookParamSchema[]> {
  const inline = deriveParamSchema(pb);
  if (!pb.paramSchemaRef) return inline;

  const doc = await resolveRef(pb.paramSchemaRef, ctx);
  if (!doc) return inline;

  const fromRegistry = jsonSchemaToParamSpecs(doc as unknown as JsonSchemaDoc) as BookParamSchema[];
  if (Array.isArray(pb.params) && !isDeepStrictEqual(fromRegistry, inline)) {
    ctx.warn(
      `book ${ctx.book}: inline params disagree with "${pb.paramSchemaRef}" — using the registry. ` +
        `registry=${JSON.stringify(fromRegistry)} inline=${JSON.stringify(inline)}`,
    );
  }
  return fromRegistry;
}

/** Resolve the output contract, mirroring resolveParamSchema.
 *
 * Returns the serialized schema for `Book.outputSchema`, or null — not "{}" —
 * when the book declares no output contract, so "promises nothing" stays
 * distinguishable from "promises any object".
 *
 * Re-serializes the registry document rather than storing its stored text: the
 * registry keeps a 2-space-indented canonical form for hashing, and letting
 * that formatting reach this column would make the ref path and the inline path
 * write byte-different values for identical contracts. */
export async function resolveOutputSchema(
  pb: { outputSchema?: Record<string, unknown>; outputSchemaRef?: string },
  ctx: ResolveCtx,
): Promise<string | null> {
  const hasInline =
    pb.outputSchema !== undefined &&
    pb.outputSchema !== null &&
    typeof pb.outputSchema === "object" &&
    !Array.isArray(pb.outputSchema);
  const inline = hasInline ? JSON.stringify(pb.outputSchema) : null;
  if (!pb.outputSchemaRef) return inline;

  const doc = await resolveRef(pb.outputSchemaRef, ctx);
  if (!doc) return inline;

  if (hasInline && !isDeepStrictEqual(doc, pb.outputSchema)) {
    ctx.warn(
      `book ${ctx.book}: inline outputSchema disagrees with "${pb.outputSchemaRef}" — using the registry. ` +
        `registry=${JSON.stringify(doc)} inline=${inline}`,
    );
  }
  return JSON.stringify(doc);
}

/** The inline branch: the contract as the playbook file itself states it.
 *
 * `params` (typed JSON Schema array) is preferred. Legacy `paramNames:
 * string[]` is supported as a fallback so older playbooks still sync — each
 * slot becomes a required string. */
function deriveParamSchema(pb: {
  params?: BookParamSchema[];
  paramNames?: string[];
}): BookParamSchema[] {
  if (Array.isArray(pb.params)) return pb.params;
  return (pb.paramNames ?? []).map((n) => ({
    name: n,
    required: true,
    schema: { type: "string" },
  }));
}

/** Normalize a legacy playbook JSON in-place so downstream consumers (backend
 *  internal-runner) receive a consistent shape. Converts `paramNames: string[]`
 *  → `params: ParamSpec[]` when the rich form is absent. Returns the mutated
 *  object for convenience (also mutated as a side-effect). */
function normalizePlaybookJson<T extends Record<string, unknown>>(pb: T): T {
  if (!Array.isArray((pb as Record<string, unknown>).params) && Array.isArray((pb as Record<string, unknown>).paramNames)) {
    (pb as Record<string, unknown>).params = ((pb as Record<string, unknown>).paramNames as string[]).map((n) => ({
      name: n,
      required: true,
      schema: { type: "string" },
    }));
  }
  return pb;
}
