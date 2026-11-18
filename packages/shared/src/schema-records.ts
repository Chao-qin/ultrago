// The 2020-12 build, not ajv's default export — that one is draft-07, and this
// repo's schemas declare 2020-12 (`canonical.schema.json` says so on its first
// line). Under draft-07 ajv silently ignores seven keywords it does not know:
// prefixItems, minContains, maxContains, dependentRequired, dependentSchemas,
// unevaluatedItems, unevaluatedProperties. Silently, because `strict: false` is
// required here and its cost is that unknown keywords pass without a word — so
// a record could declare `dependentRequired` and be told it conformed while
// nothing had looked. Verified by running each keyword through both builds.
import Ajv, { type ValidateFunction } from "ajv/dist/2020.js";
import type { JsonValue } from "./index.js";
import { UNCHECKED_PREFIX } from "./schema-keywords.js";

/**
 * SchemaRecord 的 API 响应形状（匹配 Prisma SchemaRecord 模型）。
 *
 * 一行走两支之一：
 *   - 载荷支：`data` 有值，`fileName` / `url` 为 null
 *   - 文件支：反过来
 * **判支只能看 `data`**：建表时的 `CHECK ((data IS NULL) <> (url IS NULL))` 是
 * 唯一强制这条互斥的东西（见 prisma/migrations 里手写的那行）。
 *
 * `schemaName` 不是分支标记，是**另一条独立的轴**。落地时
 * `runs/output-type.ts` 的 `planOutputRecord` 分别决定两件事：`schemaName` 取
 * 自 book 的 `outputSchemaRef`，而 `inline`（= 走不走 `data` 列）是
 * `(schema !== null && bytes <= INLINE_OUTPUT_LIMIT) || payload === ""`。
 * 两个方向都会出现偏差，都不是异常：
 *
 *   - `schemaName = null, data = ""` —— 空载荷走载荷支，却没有契约名；
 *   - `schemaName` 非空 + `data = null` —— 有契约但超过 256KB，字节落文件支，
 *     契约名照记。`doudian-category-tree` 就是这种：它带
 *     `outputSchemaRef = book-output-nonempty-string@1`，产出 1,171,535 字节。
 *
 * 库里现有 19 行两种偏差都还是 0 行（2026-08-28 只读查询实测），但那是当前数据
 * 的状态，不是约束 —— 唯一被强制的互斥是 `data` / `url` 那条 CHECK。
 */
export interface SchemaRecordRow {
  id: string;
  /** IANA media type，回答"这串字节怎么解码"。两支都记。 */
  contentType: string;
  schemaName: string | null;
  schemaVersion: number | null;
  /** 载荷支的载荷本体；文件支为 null。**判支只看这个。** */
  data: string | null;
  /** 三态：null=无契约或未检查, "[]"=检查通过, 非空数组=违约但已收录。两支都记。 */
  schemaErrors: string | null;
  /** 文件支：resource/records/ 下的文件名；载荷支为 null。 */
  fileName: string | null;
  /** 文件支：下载地址 /api/records/<fileName>；载荷支为 null。 */
  url: string | null;
  /** UTF-8 字节数。 */
  bytes: number;
  /** 溯源兼幂等键，形态见 schema.prisma 的 `SchemaRecord.source`。 */
  source: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 列表投影里代替载荷本体的东西。
 *
 *  它是**对象而不是字符串**，这是拿来挡误用的：`CreateSchemaRecordInput.data` /
 *  `UpdateSchemaRecordInput.data` 的类型是 `JsonValue`，而 TypeScript 不给
 *  `interface` 隐式索引签名，所以 `DataPreview` 满足不了 `JsonValue` 的
 *  `{ [key: string]: JsonValue }` 那一支 —— `{ data: row.dataPreview ?? "" }`
 *  于是是一个 tsc 错误，而不是一次把 200 字符写回去的静默数据损坏。
 *
 *  只有 `interface` + `head`/`truncated` 两个字段挡不住**对象展开**：
 *  `{ ...row.dataPreview }` 产出的是一个全新的对象字面量类型，而对象字面量类型
 *  拿得到隐式索引签名 —— 展开等于把 interface 那层保护整个摘掉，`{ data: {
 *  ...row.dataPreview } }` 于是编译通过（2026-08-28 用本文件的真实类型跑 tsc
 *  实测：直接赋值 TS2322，展开 exit 0）。而展开恰恰比 `.head` 更像顺手写出来的。
 *  `notAPayload?: undefined` 就是为堵这条路加的：展开会把它一起带进新类型，
 *  `undefined` 不是 `JsonValue`，索引签名那一支于是仍然对不上。
 *
 *  三条已实测的边界，别踩：
 *   - 改成 `type DataPreview = { … }` 保护就没了（type alias 拿得到隐式索引
 *     签名，实测赋值通过）；branded string（`string & { [B]: true }`）同样挡不住，
 *     因为它仍然是 `string` 的子类型。
 *   - `unique symbol` 键的品牌**不管用**（实测 exit 0）：字符串索引签名只约束
 *     字符串键的属性，symbol 键根本不参与那次检查。挡展开只能靠一个字符串键、
 *     且类型不是 `JsonValue` 的属性。`?: void` 同样实测放行，`?: undefined` /
 *     `?: symbol` 才拦得住。
 *   - 谁真想把预览当载荷写回去，挡不住——已知可绕过的写法不止下面这些，这里不是
 *     穷举：`{ data: row.dataPreview.head }`；先解构掉 `notAPayload` 再展开；
 *     `{ ...(row.dataPreview as Omit<DataPreview, "notAPayload">) }`；
 *     `JSON.parse(JSON.stringify(row.dataPreview))`；
 *     `Object.fromEntries(Object.entries(row.dataPreview))`（2026-08-28 用本文件
 *     真实类型、项目实际 lib 设置逐条实测：这五条全部 tsc exit 0，同一份测试里
 *     直接赋值和裸展开两条仍如上文所说被 TS2322 挡住）。`JSON.parse` 那条产出的
 *     类型是 `any`，任何类型守卫都拦不住 `any`——这是类型层面保护的固有上限，不是
 *     这份守卫漏做了什么。类型只挡得住顺手写出来的那次，挡不住存心的。
 *  守卫本身由 `packages/console/web/src/lib/schema-records.test.ts` 的
 *  `@ts-expect-error` 探针盯着（赋值一条、展开一条）：保护一旦失效，那条指令
 *  变成"未使用"，`build:web` 的 tsc 直接红。 */
export interface DataPreview {
  /** 载荷开头的一小段，按码点边界截断（不会留下半个代理对）。 */
  head: string;
  /** true = 后面还有；false = `head` 就是完整载荷。 */
  truncated: boolean;
  /** 纯类型标记，运行时永远不存在这个键（类型就写死成 `undefined`，
   *  `previewOf` 也从不写它）。它的唯一作用是让**展开**产出的对象字面量类型
   *  仍然满足不了 `{ [key: string]: JsonValue }`，理由见上面那段。 */
  readonly notAPayload?: undefined;
}

/** 列表投影的行形状：`GET /api/schema-records?preview=true` 返回它。
 *
 *  `data` 是**拿掉的，不是截断的**。截断后的载荷与完整载荷长得一模一样，而这张
 *  表的编辑框拿 `row.data` 当初值、PATCH 再原样写回 —— 截断值混进来就是一次静默
 *  的数据损坏。上一版为此写了 `data?: never`，那只挡得住**赋值**：在列表行上直接
 *  读 `row.data` 不报错，而 `row.data !== null` 恒为 true（`undefined !== null`），
 *  正好是它想替换掉的旧谓词。这里改成纯 `Omit`，读 `row.data` 直接 TS2339。
 *  要完整载荷的调用方走 `GET /api/schema-records/:id`。
 *
 *  分支判据在列表行上是 `dataPreview !== null`：服务端只在 `data === null` 时把
 *  它置 null，所以它是 `data !== null` 的等价投影，背后仍是那条 CHECK。 */
export type SchemaRecordListRow = Omit<SchemaRecordRow, "data"> & {
  /** 载荷支的预览；文件支没有载荷本体，为 null。 */
  dataPreview: DataPreview | null;
};

/** POST /api/schema-records 的请求体 */
export interface CreateSchemaRecordInput {
  schemaName: string;
  schemaVersion?: number; // 省略取该 name 的最新 active version
  /** 载荷本体。`JsonValue` 而不是 `unknown`：`unknown` 什么都收，包括
   *  `DataPreview`，而这张表的整个 preview 投影就是为了让预览进不来。 */
  data: JsonValue;
}

/** PATCH /api/schema-records/:id 的请求体 */
export interface UpdateSchemaRecordInput {
  /** 必须重新校验。类型同 `CreateSchemaRecordInput.data`，理由也同。 */
  data: JsonValue;
}

/** 校验结果 */
export interface SchemaRecordValidationResult {
  ok: boolean;
  errors?: string[];
}

/**
 * 用 ajv 校验 data 是否符合 jsonSchema。
 * jsonSchema 是 Schema 表里存的 JSON Schema 文档（已 parse）。
 */
/**
 * Compiled validators, keyed by the schema document itself.
 *
 * Compiling is the expensive half — `canonical-product` resolves nine `$ref`s
 * and generates a function, measured at ~15ms, against well under 1ms to run
 * it. Without this, a map over twenty items recompiled the identical schema
 * twenty times: 300ms of a strictly serial pipeline spent producing the same
 * function over and over.
 *
 * Keyed on the serialised schema rather than on object identity, because the
 * documents arrive freshly parsed from a database column every time and would
 * never be the same object twice. Bounded so a console that has seen thousands
 * of one-off schemas does not hold them all — the working set here is the
 * handful of contracts a flow actually uses.
 */
const COMPILED = new Map<string, ValidateFunction>();
const COMPILED_LIMIT = 64;

export function validateRecordData(
  jsonSchema: Record<string, unknown>,
  data: unknown,
): SchemaRecordValidationResult {
  // `logger: false` because the one thing ajv would print — "unknown format
  // ... ignored" — is now reported properly by `unenforcedSchemaKeywords`,
  // where the person whose data went unchecked can actually see it. A console
  // line repeated on every validation is not a second signal, it is noise that
  // buries the first one.
  // `multipleOfPrecision` because ajv's default for that keyword is a bare
  // `data / multipleOf !== parseInt(...)`, and binary floating point makes that
  // question unanswerable for money: `19.9 / 0.01` is 1989.9999999999998, so a
  // price of 19.90 元 — which converts to exactly 1990 分 — was reported as
  // "must be multiple of 0.01". Not an edge case: 11,426 of the 100,000 legal
  // two-decimal prices between 0.01 and 1000.00 fail it, with no pattern a
  // human could predict (9.9 passes, 19.9 does not). It cost three of the last
  // fifteen flow runs, two of them on prices copied verbatim off a 1688 page
  // and never arithmetic'd at all.
  //
  // 6 is not a new judgement call — `validate_doudian_rules.py` rule 6 enforces
  // this same constraint on the Python side and already uses a 1e-6 tolerance
  // for the same reason. One rule with two implementations had one of them
  // right; this is the other one catching up. It does not weaken the check:
  // 19.905 and 12.3456 still fail, and an integer `multipleOf` is untouched.
  const ajv = new Ajv({ allErrors: true, strict: false, logger: false, multipleOfPrecision: 6 });
  // Dropped so the engine above judges every record, whatever dialect the
  // document claims. A schema declaring draft-07 would otherwise fail to
  // compile against a 2020-12 instance — and a record that cannot be compiled
  // is a record nobody checks. Neither keyword constrains a value.
  const { $schema, $id, ...schema } = jsonSchema;
  try {
    const key = JSON.stringify(schema);
    let validate = COMPILED.get(key);
    if (!validate) {
      validate = ajv.compile(schema);
      if (COMPILED.size >= COMPILED_LIMIT) COMPILED.clear();
      COMPILED.set(key, validate);
    }
    if (validate(data)) return { ok: true };
    return {
      ok: false,
      errors: (validate.errors ?? []).map(
        (e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`,
      ),
    };
  } catch (e) {
    // A schema that will not compile is the DECLARATION being wrong, not the
    // value. Reported as a notice so it lands in the same bucket as "nobody
    // could check this" — which is exactly what happened — rather than as a
    // violation, which would fail the node and send whoever reads the message
    // hunting through data that was never even examined.
    //
    // `output-type.ts` already reached this conclusion for a schema that is not
    // valid JSON: "the book's declaration is at fault, not the run's output,
    // and failing the wrong party would send the reader hunting in the wrong
    // place." Valid JSON that is not a valid schema is the same mistake one
    // step further in, and it only became reachable when ajv started compiling.
    return { ok: false, errors: [`${UNCHECKED_PREFIX} 这份 schema 编译不了（${(e as Error).message}）—— 声明本身有问题，产出没被检查`] };
  }
}
