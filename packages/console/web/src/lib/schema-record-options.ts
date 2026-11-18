/**
 * SchemaRecord 选取器的纯逻辑，从 `ParamForm` 的 SchemaRecordJsonControl 里
 * 拆出来 —— 与 `schema-records.ts` 同一个理由：console 的测试是 `node --test`
 * 没有 DOM，混在组件回调里就只有渲染路径能碰到它。
 *
 * 这三个函数只回答触发表单里「这个字段引用了 registry schema（schemaRef），
 * 不要手写 JSON，从该 schema 已存档的 SchemaRecord 里选一条直接填入」所需要
 * 的三个问题：哪些行可选、一行显示成什么、选中后往表单里填什么。
 */
import type { SchemaCitationInput, SchemaRecordRow } from "@bcp/shared";

/** 从按 schemaName 拉回的行里筛出**可选**的那些：
 *
 *  - `data !== null`：文件支的行没有内联载荷，选中也填不出 JSON，不可选。
 *    判支看 `data` 而不是 `schemaName` —— 理由见 shared/schema-records.ts
 *    的 SchemaRecordRow 注释（schemaName 与分支是两条独立的轴）。
 *  - citation 带版本时只留同版本；不带版本（解析为 active）时全版本都给，
 *    由 label 里的 `v{n}` 让人选。版本号是 SchemaRecord 自带的登记快照，
 *    不是它 data 的属性 —— 同一份数据登记在 @2 下不会因为 schema 升到 @3
 *    就消失，所以这里不按「当前 active 版本」二次过滤，citation 是几就筛几。 */
export function filterSchemaRecordRows(
  rows: SchemaRecordRow[],
  citation?: SchemaCitationInput,
): SchemaRecordRow[] {
  return rows.filter(
    (row) =>
      row.data !== null &&
      (citation?.version === undefined || row.schemaVersion === citation.version),
  );
}

/** 三值归属存档时的校验结论（`schemaErrors`：null=未检查，"[]"=通过，
 *  非空数组=违约但已收录）。选数据的动作不该被历史结论拦死 —— 违约的存档
 *  依然可选，只是标签上把话说开，填进去之后提交时的 validateParams 会再拦一次。 */
export type RecordVerdict = "ok" | "violated" | "unchecked";

export function recordVerdict(row: SchemaRecordRow): RecordVerdict {
  if (row.schemaErrors === null) return "unchecked";
  try {
    const errors = JSON.parse(row.schemaErrors);
    return Array.isArray(errors) && errors.length === 0 ? "ok" : "violated";
  } catch {
    return "violated";
  }
}

/** 下拉里一行的显示文本。`v{n}` 只在 citation 不带版本（或无 citation、
 *  全库挑选）时出现 —— 带了版本的 citation 筛出来的行全是同一版本，重复写
 *  一遍是噪音。 */
export function recordOptionLabel(
  row: SchemaRecordRow,
  citation?: SchemaCitationInput,
): string {
  const parts = [
    `#${row.id.slice(0, 8)}`,
    row.createdAt.slice(0, 16).replace("T", " "),
    `${row.bytes}B`,
  ];
  if (citation?.version === undefined && row.schemaVersion !== null) {
    parts.splice(1, 0, `v${row.schemaVersion}`);
  }
  let label = parts.join(" · ");
  if (recordVerdict(row) === "violated") label += " · ⚠ 存档违约";
  return label;
}

/** 选中后往表单里填什么。JSON 就给解析后的对象（走 textarea 的
 *  getValueFromEvent 同一条管道存回对象）；不是合法 JSON（或文件支）就回退
 *  原始字符串 —— 照填不误，让提交时的 validateParams 去报错，而不是在
 *  选取这步静默丢数据。 */
export function parseRecordData(
  row: SchemaRecordRow,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (row.data === null) return { ok: false, error: "文件支记录没有内联载荷" };
  if (row.data.trim() === "") return { ok: true, value: "" };
  try {
    return { ok: true, value: JSON.parse(row.data) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
