import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { CreateSchemaRecordInput, DataPreview, UpdateSchemaRecordInput } from "@bcp/shared";
import { validateRecordData } from "@bcp/shared";
import { PrismaService } from "../prisma/prisma.service.js";

/** The only branch this hand-CRUD entry point may create. The file branch is
 *  written by the backend as a run produces bytes, and has no manual form. */
const JSON_CONTENT_TYPE = "application/json";

/** UTF-8 byte count, which is what `bytes` means — NOT `json.length`, which
 *  counts UTF-16 code units and undercounts any CJK payload by 20%+. */
function byteLength(json: string): number {
  return Buffer.byteLength(json, "utf8");
}

/** How much of a payload the list projection carries, in UTF-16 code units —
 *  the unit `String.prototype.slice` counts in. Enough to tell at a glance what
 *  a row holds, short enough that the biggest row costs the same as the
 *  smallest. */
const PREVIEW_CHARS = 200;

/** The bounded stand-in for a payload body.
 *
 *  "Was it cut" is a FLAG rather than a trailing ellipsis: the receiver can tell
 *  "this is all of it" from "this is the head of it" without being told what the
 *  cap is, and without a payload that genuinely ends in "…" reading as truncated.
 *
 *  The cut never splits a surrogate pair. `"a".repeat(199) + "😀"` sliced at code
 *  unit 200 leaves the lone high surrogate 0xD83D, which `JSON.stringify` emits
 *  as `\ud83d` and the browser renders as U+FFFD. A high surrogate in the last
 *  position means the pair straddles the cut, so drop it — one character short
 *  beats one broken one. */
function previewOf(data: string | null): DataPreview | null {
  if (data === null) return null;
  if (data.length <= PREVIEW_CHARS) return { head: data, truncated: false };
  const cut = data.slice(0, PREVIEW_CHARS);
  const last = cut.charCodeAt(PREVIEW_CHARS - 1);
  const straddles = last >= 0xd800 && last <= 0xdbff;
  return { head: straddles ? cut.slice(0, PREVIEW_CHARS - 1) : cut, truncated: true };
}

/** The request's payload, as a value. Both write paths accept either a JSON
 *  string or an already-parsed value, and both used to reach `JSON.parse`
 *  unguarded — so `{"data":"{oops"}` threw a raw SyntaxError and a body with no
 *  `data` key at all reached `Buffer.byteLength(undefined)` and threw a
 *  TypeError. `main.ts` deliberately installs no global ValidationPipe, and the
 *  one global filter it does install is narrowed to Prisma's known-request
 *  errors — a SyntaxError is not one — so both still surface as 500s for what a
 *  caller can fix. The guard below is what stops that.
 *
 *  `null` is a legitimate payload (`JsonValue` includes it) and is let through;
 *  only `undefined` — the absent key — is refused. */
function parseInputData(input: { data?: unknown }): unknown {
  if (input?.data === undefined) throw new BadRequestException("data is required");
  if (typeof input.data !== "string") return input.data;
  try {
    return JSON.parse(input.data);
  } catch (e) {
    throw new BadRequestException(`data is not valid JSON: ${(e as Error).message}`);
  }
}

/** The request's schema name, as a value. It exists for the same reason
 *  `parseInputData` does: `CreateSchemaRecordInput.schemaName` is DECLARED
 *  `string`, but `main.ts:72-75` deliberately installs no global
 *  ValidationPipe, so that declaration is a claim about the request body rather
 *  than a fact about it — a `POST` whose body omits `schemaName` reaches the
 *  service with `undefined`.
 *
 *  Unlike the `data` hole, this one does not throw, and that is what makes it
 *  worth a guard of its own. `resolveSchema` would hand Prisma
 *  `{ name: undefined, deletedAt: null, active: true }`, and Prisma reads an
 *  `undefined` VALUE as "this field does not take part in the filter" — so
 *  `findFirst` skips the missing name and returns whichever active schema sorts
 *  first. Against the live registry (12 active schemas, queried read-only
 *  through the real client on 2026-08-28) that is `canonical-product@1`. The
 *  payload is then validated against that schema, and if it happens to pass,
 *  the row is written stamped `canonical-product@1` — a contract the caller
 *  never named. Silent mislabelling, not a 500, so nothing downstream would
 *  ever report it.
 *
 *  Blank is refused alongside absent: `where.name = ""` matches no row, so it
 *  would otherwise surface as a 404 about a schema named "" — a bad request
 *  reported as a missing resource. */
function requireSchemaName(input: { schemaName?: unknown }): string {
  const name = input?.schemaName;
  if (typeof name !== "string" || name.trim() === "") {
    throw new BadRequestException("schemaName is required");
  }
  return name;
}

@Injectable()
export class SchemaRecordsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** `sourcePrefix` is how a run or flow detail page asks for what it produced:
   *  the source keys are hierarchical (`run:<id>` is a prefix of
   *  `run:<id>:artifact:<path>`), so one prefix fetches a run's product and the
   *  files it wrote together.
   *
   *  ROW COUNT is deliberately unbounded — no `take` — and that is the part a
   *  naive fix gets wrong. A bare `take` under `createdAt desc` silently drops a
   *  run's OLDEST artifacts, and the detail page then reports what it received
   *  as the whole product: a slow page turned into a wrong one. Capping the row
   *  count needs real paging (a cursor plus a total the UI can show). The
   *  trigger for building that is the row count reaching the thousands; the
   *  table holds 19 rows today, so it is not built.
   *
   *  PAYLOAD SIZE is a separate axis, and it IS bounded — by `preview`. Note the
   *  browse page (`web/src/pages/SchemaRecords.tsx`) passes no `sourcePrefix` at
   *  all: it asks for the whole table by design, and renders nothing but a short
   *  preview of each payload. Shipping it full payloads is pure waste — one row
   *  in the current database carries 968 KB of `data`, and every landed run adds
   *  more. Under `preview` the payload never leaves this process; what crosses
   *  the wire and lands in the browser's query cache is `PREVIEW_CHARS`
   *  characters per row.
   *
   *  What `preview` does NOT bound: the column is still read out of SQLite. That
   *  is a local file read of a 19-row table, and bounding it would mean either
   *  raw `substr` SQL (a hand-built dynamic WHERE, drifting from the model) or a
   *  stored preview column (a migration). Neither is worth it at this size — but
   *  the row count is what would force the issue, not the payload size. */
  async list(
    opts: { schemaName?: string; sourcePrefix?: string; includeDeleted?: boolean; preview?: boolean } = {},
  ) {
    const where: Record<string, unknown> = {};
    if (opts.schemaName) where.schemaName = opts.schemaName;
    if (opts.sourcePrefix) where.source = { startsWith: opts.sourcePrefix };
    if (!opts.includeDeleted) where.deletedAt = null;
    const rows = await this.prisma.schemaRecord.findMany({ where, orderBy: { createdAt: "desc" } });
    if (!opts.preview) return rows;
    // `data` is dropped from the shape, not shortened in place: a truncated
    // payload sitting under the `data` key is indistinguishable from a real one,
    // and the edit form writes whatever it finds there straight back.
    return rows.map(({ data, ...rest }) => ({ ...rest, dataPreview: previewOf(data) }));
  }

  async findById(id: string) {
    const row = await this.prisma.schemaRecord.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new NotFoundException(`schema record ${id} not found`);
    return row;
  }

  async create(input: CreateSchemaRecordInput) {
    const schema = await this.resolveSchema(requireSchemaName(input), input.schemaVersion);
    const parsed = parseInputData(input);
    const result = validateRecordData(JSON.parse(schema.jsonSchema), parsed);
    if (!result.ok) {
      throw new BadRequestException(`data does not match schema "${schema.name}@${schema.version}": ${result.errors?.join("; ")}`);
    }
    const json = JSON.stringify(parsed);
    return this.prisma.schemaRecord.create({
      data: {
        contentType: JSON_CONTENT_TYPE,
        schemaName: schema.name,
        schemaVersion: schema.version,
        data: json,
        bytes: byteLength(json),
      },
    });
  }

  async update(id: string, input: UpdateSchemaRecordInput) {
    const existing = await this.findById(id);
    // The file branch has no `data` column to write. `CHECK ((data IS NULL) <>
    // (url IS NULL))` (hand-written in the migration, since Prisma's schema
    // language cannot express a CHECK) makes the UPDATE below a guaranteed
    // constraint violation on such a row, and `main.ts` deliberately installs
    // no global ValidationPipe while PrismaExceptionFilter maps only an
    // allowlist of codes that a CHECK violation is not in — so the raw Prisma
    // error would still surface as a 500 for what is a fully predictable bad
    // request.
    //
    // The web app already hides the edit button for these rows
    // (SchemaRecords.tsx:118, gated on `hasPayload` from
    // web/src/lib/schema-records.ts), which is exactly why this has to exist:
    // an invariant enforced only in the browser is not enforced at all.
    // Branch on `data`, not on `url` — `data` is the documented branch
    // predicate (see SchemaRecordRow in @bcp/shared), and it is the one the
    // list projection's `dataPreview !== null` mirrors.
    if (existing.data === null) {
      throw new BadRequestException(
        `record ${id} is a file record — its payload is the bytes at ${existing.url}, not a JSON column, so there is nothing here to PATCH`,
      );
    }
    const parsed = parseInputData(input);
    // `schemaName` became nullable when this table absorbed the file branch,
    // but "file row" and "no contract" are two different things and this test
    // is about the second: `planOutputRecord` records `schemaName` on BOTH
    // branches and leaves it null only when the book named no resolvable
    // `outputSchemaRef` (or the payload was empty). A contract-bearing file row
    // never reaches here anyway — the `data === null` guard above rejects it
    // first — so what this actually skips is a payload row with no contract to
    // resolve and nothing ajv could say about it. It is let through rather than
    // rejected for failing to declare something it was never given.
    if (existing.schemaName !== null) {
      const schema = await this.resolveSchema(existing.schemaName, existing.schemaVersion ?? undefined);
      const result = validateRecordData(JSON.parse(schema.jsonSchema), parsed);
      if (!result.ok) {
        throw new BadRequestException(`data does not match schema "${schema.name}@${schema.version}": ${result.errors?.join("; ")}`);
      }
    }
    const json = JSON.stringify(parsed);
    return this.prisma.schemaRecord.update({
      where: { id },
      data: { data: json, bytes: byteLength(json) },
    });
  }

  /** 逻辑删除 */
  async remove(id: string): Promise<{ ok: boolean; id: string }> {
    await this.findById(id); // 确认存在
    await this.prisma.schemaRecord.update({ where: { id }, data: { deletedAt: new Date() } });
    return { ok: true, id };
  }

  /** 恢复逻辑删除。
   *
   *  A restore can collide, and the collision is reachable by ordinary use:
   *  delete the `run:<id>` row, let that run land again (`upsertBySource` finds
   *  no live row and creates one), then restore the old row. Both rows would
   *  then be live under the same `source`, which the partial unique index
   *  `uniq_active_record_source` (`ON SchemaRecord(source) WHERE source IS NOT
   *  NULL AND deletedAt IS NULL`) forbids — so the UPDATE fails with P2002.
   *  PrismaExceptionFilter now turns that into a bare 409 rather than the 500
   *  it used to be, which is the right STATUS but says only "already exists".
   *  The pre-check stays because it can say which record and why — a status
   *  table knows the shape of the failure, never the subject of it.
   *
   *  Rows with a NULL `source` (anything created through POST) are outside the
   *  partial index and are never blocked. */
  async restore(id: string) {
    // All three statements share one transaction. The pre-check exists to turn
    // a partial-index violation into a message that names the conflicting
    // record, and run as three separate statements it cannot do that reliably:
    // between the `findFirst` that reports "no live record for this source" and
    // the `update`, another restore — or an ordinary `upsertBySource` landing a
    // fresh run — can commit its own live row. The UPDATE then hits the index
    // anyway and the caller gets the bare 409 this check was written to
    // replace. One transaction makes the answer the check gave still true when
    // the write lands.
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.schemaRecord.findUnique({ where: { id } });
      if (!row) throw new NotFoundException(`schema record ${id} not found`);
      if (!row.deletedAt) throw new BadRequestException(`record ${id} is not deleted`);
      if (row.source !== null) {
        const live = await tx.schemaRecord.findFirst({
          where: { source: row.source, deletedAt: null },
          select: { id: true },
        });
        if (live) {
          throw new ConflictException(
            `cannot restore ${id}: source "${row.source}" already has a live record (${live.id}) — only one record per source may be live at a time`,
          );
        }
      }
      return tx.schemaRecord.update({ where: { id }, data: { deletedAt: null } });
    });
  }

  /** 按 name 解析 schema（指定版本或最新 active）。
   *  `deletedAt: null` 与 SchemasService.resolve 同口径：退休版本仍可按
   *  name+version 精确取（历史记录要靠它解释），删除的版本一律不解析。
   *
   *  `name` 是**前置条件**，不只是类型标注：必须是已校验的非空字符串。两个调用点
   *  各自负责把它变成事实，而不是依赖签名上那个 `string` —— 请求体里的
   *  `schemaName` 只是声明成 `string`（没装 ValidationPipe，见
   *  `requireSchemaName`），库里读出来的才天然是。所以 `create` 先过
   *  `requireSchemaName(input)`，`update` 传的是被 `existing.schemaName !== null`
   *  收窄过的库值。
   *
   *  这条前置条件不能省的原因在下面这行 `where`：Prisma 把 `name: undefined`
   *  读成"这个字段不参与过滤"，于是漏掉 name 的查询**不报错**，而是安静地返回
   *  排序第一的那份 schema。失败模式是贴错标签，不是异常，谁也不会发现。 */
  private async resolveSchema(name: string, version?: number) {
    const where: Record<string, unknown> = { name, deletedAt: null };
    if (version !== undefined) where.version = version;
    else where.active = true;
    const schema = await this.prisma.schema.findFirst({ where, orderBy: { version: "desc" } });
    if (!schema) throw new NotFoundException(`schema "${name}"${version ? ` v${version}` : ""} not found`);
    return schema;
  }
}
