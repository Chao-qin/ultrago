import { BadRequestException, Injectable, NotFoundException, Inject } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  SCHEMA_KINDS,
  checkSchemaContract,
  isSchemaSlug,
  parseCitation,
  parseFlowGraph,
  type RegisterSchemaInput,
  type SchemaKind,
  type UpdateSchemaInput,
} from "@bcp/shared";
import { PrismaService } from "../prisma/prisma.service.js";

// The kinds, the input shapes and the pure contract rules all live in
// @bcp/shared/console-types: the registration form in the console web app has
// to reach the same verdict this service enforces, and a second copy of these
// rules in the UI would be a second thing to drift.

@Injectable()
export class SchemasService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** List registered schemas, newest first.
   *
   *  TWO independent hides, with TWO independent switches — see the Schema
   *  model's note. They are not the same question and must not collapse into
   *  one flag:
   *
   *    active: false     → retired. The document is still correct; it just is
   *                        not the current version. Historic records need it.
   *    deletedAt != null → deleted. The row should never have existed (typo,
   *                        wrong registry). Nothing should interpret it.
   *
   *  So `includeInactive` un-hides retired versions and `includeDeleted`
   *  un-hides mistakes; asking for one must not hand back the other. */
  list(filter: { kind?: string; entity?: string; includeInactive?: boolean; includeDeleted?: boolean; q?: string } = {}) {
    const q = filter.q?.trim();
    return this.prisma.schema.findMany({
      where: {
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.entity ? { entity: filter.entity } : {}),
        ...(filter.includeInactive ? {} : { active: true }),
        ...(filter.includeDeleted ? {} : { deletedAt: null }),
        ...(q ? { OR: [{ name: { contains: q } }, { title: { contains: q } }, { description: { contains: q } }, { kind: { contains: q } }, { entity: { contains: q } }] } : {}),
      },
      orderBy: [{ name: "asc" }, { version: "desc" }],
    });
  }

  async findById(id: string) {
    const schema = await this.prisma.schema.findFirst({ where: { id, deletedAt: null } });
    if (!schema) throw new NotFoundException(`schema ${id} not found`);
    return schema;
  }

  /** Resolve a `name` + optional `version` citation — this is how consumers
   *  reference a schema (see the Schema model's note on loose coupling).
   *  Omitting the version yields the highest ACTIVE one, so a caller that
   *  doesn't pin gets the current contract rather than whatever sorted last. */
  async resolve(name: string, version?: number) {
    const schema = await this.prisma.schema.findFirst({
      // `deletedAt: null` unconditionally, `active: true` only when no version
      // was pinned. Pinning name+version is how historic data is interpreted,
      // and a retired version must still resolve there or every record written
      // against it becomes unreadable the moment a newer version lands. A
      // DELETED version is different: it never legitimately described anything.
      where: { name, deletedAt: null, ...(version === undefined ? { active: true } : { version }) },
      orderBy: { version: "desc" },
    });
    if (!schema) {
      throw new NotFoundException(
        version === undefined ? `no active schema named "${name}"` : `schema "${name}" v${version} not found`,
      );
    }
    return schema;
  }

  /** Register a schema, or return the existing row when an identical document
   *  is already registered under the same name+version.
   *
   *  Re-registering the SAME name+version with DIFFERENT content is refused
   *  rather than silently overwritten: something already cites that pair, and
   *  changing what it resolves to would rewrite history. Bump `version`. */
  async register(input: RegisterSchemaInput) {
    const name = input.name?.trim();
    if (!name || !isSchemaSlug(name)) {
      throw new BadRequestException(`schema name must be kebab-case, got ${JSON.stringify(input.name)}`);
    }
    if (!SCHEMA_KINDS.includes(input.kind as SchemaKind)) {
      throw new BadRequestException(`unknown schema kind "${input.kind}" (expected one of ${SCHEMA_KINDS.join(", ")})`);
    }
    await this.assertContract({
      name,
      kind: input.kind,
      entity: input.entity,
      upstreamRef: input.upstreamRef,
      derivesFrom: input.derivesFrom,
    });

    const { text, parsed } = normalizeDocument(input.jsonSchema);
    const version = input.version ?? 1;
    const contentHash = sha256(text);

    // NOT filtered on `deletedAt`. This lookup exists to predict what the
    // `@@unique([name, version])` index will do, and that index does not know
    // about soft deletes: skipping a deleted row here would send us into
    // `create()` and straight into a P2002 the caller cannot act on.
    //
    // Consequence, stated rather than hidden: re-registering a name+version
    // that was soft-deleted returns that row still bearing its `deletedAt`
    // (identical content) or reports a content conflict (different content).
    // Whether re-registration should instead REVIVE the row is a product call
    // nobody has made; it is not decided here by accident.
    const existing = await this.prisma.schema.findUnique({
      where: { name_version: { name, version } },
    });
    if (existing) {
      if (existing.contentHash !== contentHash) {
        throw new BadRequestException(
          `schema "${name}" v${version} is already registered with different content — bump the version instead of redefining it`,
        );
      }
      return existing;
    }

    return this.prisma.schema.create({
      data: {
        name,
        version,
        kind: input.kind,
        entity: input.entity ?? null,
        title: typeof parsed.title === "string" ? parsed.title : null,
        description: input.description ?? (typeof parsed.description === "string" ? parsed.description : null),
        jsonSchema: text,
        contentHash,
        source: input.source ?? "api",
        upstreamRef: input.upstreamRef ?? null,
        derivesFrom: input.derivesFrom ?? null,
      },
    });
  }

  /** Update the mutable metadata. `jsonSchema` is deliberately NOT updatable —
   *  a schema document is immutable once cited; changing it means a new
   *  version. */
  async update(id: string, patch: UpdateSchemaInput) {
    const current = await this.findById(id);
    // Copy the five updatable fields out by hand, and write THIS object rather
    // than the caller's. `patch` is the request body: `UpdateSchemaInput` is a
    // TypeScript interface, erased at runtime, and main.ts installs no global
    // ValidationPipe, so every key a client sends survives to here. Passing it
    // straight to Prisma — which this method did until 2026-08-28 — made all
    // sixteen Schema columns writable over PATCH, eleven more than intended.
    //
    // That was not merely an undefended invariant, it was a contradicted one.
    // `register()` refuses to redefine a name+version with different content
    // and `remove()` refuses to delete a schema anything still cites; PATCH
    // reached both states with no check at all, and could additionally desync
    // `contentHash` from `jsonSchema` or clear `deletedAt` to resurrect a row
    // behind `remove()`'s dependent guards.
    //
    // The shape is `books.service.ts` update()'s, which has always done this.
    // `!== undefined` rather than a truthiness test or `??`: `undefined` means
    // "leave alone" while `null` is an explicit clear, and the two must stay
    // distinguishable — `entity: null` is how a projection drops its entity.
    const data: UpdateSchemaInput = {};
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.entity !== undefined) data.entity = patch.entity;
    if (patch.active !== undefined) data.active = patch.active;
    if (patch.upstreamRef !== undefined) data.upstreamRef = patch.upstreamRef;
    if (patch.derivesFrom !== undefined) data.derivesFrom = patch.derivesFrom;

    // The contract rules have to hold on BOTH write paths. update() can set
    // `entity`, `upstreamRef` AND `derivesFrom`, so guarding only register()
    // would leave every rule reachable through the back door. Merge onto the
    // current row, because a patch that only touches one field is still judged
    // as the whole row it produces. Reading from `data` and not from `patch` is
    // what makes "the row we validated" and "the row we write" the same object
    // by construction rather than by two lists agreeing.
    await this.assertContract({
      name: current.name,
      kind: current.kind,
      entity: data.entity !== undefined ? data.entity : current.entity,
      upstreamRef: data.upstreamRef !== undefined ? data.upstreamRef : current.upstreamRef,
      derivesFrom: data.derivesFrom !== undefined ? data.derivesFrom : current.derivesFrom,
    });
    return this.prisma.schema.update({ where: { id }, data });
  }

  /** Run every contract rule: the pure ones, then the one that needs a lookup.
   *
   *  A cited lineage must actually resolve, and must resolve to a CANONICAL —
   *  a projection pointing at another projection is a chain nobody models, and
   *  one pointing at a name that was never registered is a typo that would
   *  otherwise sit in the table looking authoritative. */
  private async assertContract(row: {
    name: string;
    kind: string;
    entity?: string | null;
    upstreamRef?: string | null;
    derivesFrom?: string | null;
  }): Promise<void> {
    const problems = checkSchemaContract(row);
    if (problems.length > 0) throw new BadRequestException(problems.join("; "));
    if (!row.derivesFrom) return;

    const cited = parseCitation(row.derivesFrom);
    // Same rule as resolve(): a deleted parent resolves to nothing, so citing
    // one is refused exactly like citing a name that was never registered.
    const parent = await this.prisma.schema.findFirst({
      where: { name: cited.name, deletedAt: null, ...(cited.version === undefined ? { active: true } : { version: cited.version }) },
      orderBy: { version: "desc" },
    });
    if (!parent) {
      throw new BadRequestException(`derivesFrom cites "${row.derivesFrom}", which is not registered`);
    }
    if (parent.kind !== "canonical") {
      throw new BadRequestException(`derivesFrom must cite a canonical schema; "${cited.name}" is kind "${parent.kind}"`);
    }
  }

  /** Delete a schema (soft).
   *
   *  Refused while anything still POINTS at it, in either of the two ways
   *  something can. Both guards work because what makes a reference dangle is
   *  `resolve()` / `resolveSchema()` no longer returning the row — and neither
   *  returns a soft-deleted one:
   *
   *    Schema.derivesFrom     → a projection would claim a lineage that cannot
   *                             be resolved, which register() already refuses
   *                             to create.
   *    SchemaRecord.schemaName → a record would keep a contract name that no
   *                             longer resolves; see the note on that query for
   *                             why this one fails silently rather than loudly.
   *
   *  Deleting is for mistakes — a row registered by accident, a name typo
   *  caught before anything cited it. To retire a schema that has been USED,
   *  set `active: false` instead: historic records still need their document to
   *  stay interpretable, which is the whole reason old versions are kept. */
  async remove(id: string) {
    // Two dependent scans and the write share one transaction. Read then write
    // as separate statements leaves a window where a projection citing this
    // schema, or a SchemaRecord interpreting its payload with it, is created
    // between the check and the delete — and the delete then succeeds against
    // an answer that stopped being true, leaving exactly the dangling reference
    // both guards exist to prevent. `books.service.ts` delete() puts its check
    // and its write in one transaction for the same reason.
    return this.prisma.$transaction(async (tx) => {
      const schema = await tx.schema.findFirst({ where: { id, deletedAt: null } });
      if (!schema) throw new NotFoundException(`schema ${id} not found`);
      // derivesFrom cites either "name@version" or bare "name" (whichever is
      // active), so both spellings have to be checked — a dependent using the
      // short form is no less dependent.
      //
      // `deletedAt: null` on the dependents: an already-deleted projection is not
      // a live lineage claim, and counting it would make one mistaken
      // registration permanently un-deletable behind another.
      const dependents = await tx.schema.findMany({
        where: {
          derivesFrom: { in: [`${schema.name}@${schema.version}`, schema.name] },
          deletedAt: null,
        },
        select: { name: true, version: true },
      });
      if (dependents.length > 0) {
        const cited = dependents.map((d) => `${d.name}@${d.version}`).join(", ");
        throw new BadRequestException(
          `cannot delete "${schema.name}@${schema.version}" — still cited by derivesFrom of: ${cited}`,
        );
      }
      // SchemaRecord is the OTHER kind of dependent, and it is the one that goes
      // wrong silently. A record keeps `schemaName` + `schemaVersion`; nothing
      // hides it when its schema goes, so it stays in the browse list looking
      // fine, but SchemaRecordsService.update() re-resolves that pair through
      // `resolveSchema` (which filters `deletedAt: null`) and throws a 404 naming
      // a schema the user can no longer see anywhere. The row becomes
      // permanently uneditable, and the error points at a ghost.
      //
      // Matched on name AND version: the pair is what a record pins and what
      // `resolveSchema(name, version)` looks up, so another version of the same
      // name is not a dependent. Both current writers of `schemaName` set the
      // version alongside it — SchemaRecordsService.create() from the resolved
      // schema, and output-landing via `planOutputRecord`, whose `parseSchemaRef`
      // yields both fields or neither — so a name-without-version record is not a
      // state that can be reached today. Should one appear (it would resolve to
      // whatever is active), this needs the unpinned case too.
      //
      // `deletedAt: null` for the same reason as the derivesFrom query above: a
      // deleted record is not a live claim on this schema.
      const records = await tx.schemaRecord.findMany({
        where: { schemaName: schema.name, schemaVersion: schema.version, deletedAt: null },
        select: { id: true },
      });
      if (records.length > 0) {
        // The count is the real total; only the id list is abridged, so the
        // message never understates how much is still pointing here.
        const shown = records.slice(0, 5).map((r) => r.id).join(", ");
        const more = records.length > 5 ? `, +${records.length - 5} more` : "";
        throw new BadRequestException(
          `cannot delete "${schema.name}@${schema.version}" — ${records.length} schema record(s) still interpret their payload with it (${shown}${more}); retire it with active:false instead`,
        );
      }
      // Flow references live inside graphJson rather than a relational column,
      // so Prisma cannot discover them. Scan live graphs in the same transaction
      // before soft-deleting the registry row.
      if (tx.flow?.findMany) {
        const flows = await tx.flow.findMany({ where: { deletedAt: null }, select: { name: true, graphJson: true } });
        const flowRefs = flows.flatMap((flow: { name: string; graphJson: string }) => collectFlowSchemaRefs(flow.name, flow.graphJson));
        const matches = flowRefs.filter((ref) => ref.name === schema.name && (ref.version === schema.version || (ref.version === undefined && schema.active)));
        if (matches.length > 0) {
          const shown = matches.slice(0, 5).map((ref) => `${ref.flow} / ${ref.path}`).join(", ");
          const more = matches.length > 5 ? `, +${matches.length - 5} more` : "";
          throw new BadRequestException(`cannot delete "${schema.name}@${schema.version}" — still cited by Flow: ${shown}${more}; retire it with active:false instead`);
        }
      }
      await tx.schema.update({ where: { id }, data: { deletedAt: new Date() } });
      return { ok: true, name: schema.name, version: schema.version };
    });
  }

  /** Real delete. Deliberately not routed — see BooksService.purge. The
   *  derivesFrom guard above is NOT re-run here: purging is the escape hatch
   *  for someone who has already decided what they are removing.
   *
   *  Looks the row up WITHOUT the `deletedAt` filter, unlike findById. The
   *  usual reason to purge is to reclaim something already soft-deleted, so
   *  routing this through the visible-rows lookup would refuse exactly the
   *  rows it exists to remove. */
  async purge(id: string) {
    const schema = await this.prisma.schema.findUnique({ where: { id } });
    if (!schema) throw new NotFoundException(`schema ${id} not found`);
    await this.prisma.schema.delete({ where: { id } });
    return { ok: true, name: schema.name, version: schema.version };
  }
}

/** Accept an object or a JSON string; return both the canonical serialization
 *  (what gets hashed and stored) and the parsed form (to lift title out of).
 *  Serializing with a stable 2-space indent means two callers submitting the
 *  same schema through different paths hash identically. */
function normalizeDocument(doc: unknown): { text: string; parsed: Record<string, unknown> } {
  let parsed: unknown;
  if (typeof doc === "string") {
    try {
      parsed = JSON.parse(doc);
    } catch (e) {
      throw new BadRequestException(`jsonSchema is not valid JSON: ${(e as Error).message}`);
    }
  } else {
    parsed = doc;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadRequestException("jsonSchema must be a JSON object");
  }
  return { text: JSON.stringify(parsed, null, 2), parsed: parsed as Record<string, unknown> };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function collectFlowSchemaRefs(flowName: string, graphJson: string): Array<{ flow: string; path: string; name: string; version?: number }> {
  const graph = parseFlowGraph(graphJson);
  const refs: Array<{ flow: string; path: string; name: string; version?: number }> = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    for (const key of ["schemaRef", "inputSchemaRef", "outputSchemaRef"]) {
      const ref = object[key];
      if (ref && typeof ref === "object" && typeof (ref as { name?: unknown }).name === "string") {
        const version = (ref as { version?: unknown }).version;
        refs.push({ flow: flowName, path: `${path}.${key}`, name: (ref as { name: string }).name, ...(typeof version === "number" ? { version } : {}) });
      }
    }
    const fieldRef = object["x-bcp-schema-ref"];
    if (fieldRef && typeof fieldRef === "object" && typeof (fieldRef as { name?: unknown }).name === "string") {
      const version = (fieldRef as { version?: unknown }).version;
      refs.push({ flow: flowName, path: `${path}.x-bcp-schema-ref`, name: (fieldRef as { name: string }).name, ...(typeof version === "number" ? { version } : {}) });
    }
    for (const [key, child] of Object.entries(object)) visit(child, `${path}.${key}`);
  };
  visit(graph.nodes, "nodes");
  return refs;
}
