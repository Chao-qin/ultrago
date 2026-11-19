/**
 * Book 里内联 JS 的存储形态：`string` 或**每行一个元素的 `string[]`**。
 *
 * 为什么需要它：JSON 规范不允许字符串里出现字面换行符，所以只要 `code` 是一个
 * 字符串，落到文件里就必然是一整行——`doudian-publish-canonical` 单块最大 7893
 * 字符挤成一行，1538 处 `\"` 转义，改一个字符 git 就显示整行替换。这不是实现
 * 选择，是 JSON 本身的限制；想在文件里看到真实的换行和缩进，`code` 只能是数组。
 *
 * 契约照抄 Postman Collection Format v2.1.0 的 `Script.exec`，不自己发明：
 *   schema.postman.com/json/collection/v2.1.0/collection.json 里原文——
 *   "exec": { "oneOf": [
 *       { "type": "array", "items": { "type": "string" },
 *         "description": "This is an array of strings, where each line
 *          represents a single line of code. Having lines separate makes it
 *          possible to easily track changes made to scripts." },
 *       { "type": "string" } ] }
 * 即：数组用 `join("\n")` 还原，字符串输入用 `split(/\r?\n/)` 切分。同一套做法在
 * VS Code snippets 的 `body: string[]` 上也是如此。反面案例是 Node-RED——function
 * 代码存成单个转义字符串，社区实测「diff 极难读、GitHub 认不出 function 内部的
 * 行级变化」，最终只能靠换 YAML 绕开，而 book 必须保持「一个可移植 JSON」。
 *
 * **归一化只发生在读盘边界**：`loadPlaybook` / codegen / lint 解析完 JSON 后立刻
 * 调 `normalizeBookCode`，此后全链路（instantiateSteps、validateBookV2、RPC 契约、
 * 扩展注入）看到的 `code` 永远是 `string`，运行时类型一个都不用改。因此
 * `validateBookV2` 继续要求 `string` 这件事本身就是哨兵：谁忘了归一化，它当场报
 * `expected { code: string }`，而不是把数组一路带到页面上炸掉。
 */

/** Book 文件里 `code` 字段的合法形态。 */
export type BookCode = string | string[];

/** 行数组 → 源码。与 Postman `Script.toSource()` 同语义。 */
export function bookCodeToSource(code: BookCode): string {
  return Array.isArray(code) ? code.join("\n") : code;
}

/** 源码 → 行数组。`\r\n` 与 `\n` 一视同仁，与 Postman 的 `SCRIPT_NEWLINE_PATTERN` 一致。 */
export function bookSourceToLines(source: string): string[] {
  return source.split(/\r?\n/);
}

/** 值是不是「每行一个元素」的行数组。空数组不算——那是写坏了，不是空代码，
 * 交给下游的 `expected { code: string }` 去报，别在这里悄悄变成空字符串。 */
function isLineArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
}

/** 递归把 book 里所有 `code` 行数组就地合成字符串，返回改动过的字段数。
 *
 * 按 key 名递归而不是按已知路径写死，理由是路径不止一种且会长：今天实测有三种
 * ——`steps[].action.params.code`、`steps[].verify.evalCheck.code` / `evalUntil.code`、
 * `pages.*.signals.*.condition[.all[]].script.code`，最后一种还能任意深地嵌在
 * `all`/`any` 里。按路径枚举等于每加一种信号就要回来改一次，漏改的表现是那处
 * 代码原样带着数组跑到页面上。
 *
 * 只认「全是字符串的非空数组」，所以别的 `code` 字段（如 RPC 错误码）不会被误伤。
 */
export function normalizeBookCode(book: unknown): number {
  let joined = 0;
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (key === "code" && isLineArray(value)) {
        obj[key] = value.join("\n");
        joined++;
      } else {
        walk(value);
      }
    }
  };
  walk(book);
  return joined;
}

/** `normalizeBookCode` 的逆操作：把 `code` 字符串就地切成行数组，返回改动过的字段数。
 *
 * 用在写盘侧（`savePlaybook`），这样 `record_stop` 录出来的书也是可读形态，不会
 * 一录就把人工排好的版打回一整行。Postman 的 `Script.update()` 对字符串入参做的
 * 是同一件事。
 */
export function splitBookCode(book: unknown): number {
  let split = 0;
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (key === "code" && typeof value === "string") {
        obj[key] = bookSourceToLines(value);
        split++;
      } else {
        walk(value);
      }
    }
  };
  walk(book);
  return split;
}
