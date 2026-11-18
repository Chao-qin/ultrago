import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bookCodeToSource,
  bookSourceToLines,
  normalizeBookCode,
  splitBookCode,
} from "./book-code.js";

test("行数组按换行还原成源码", () => {
  assert.equal(bookCodeToSource(["a", "b", "c"]), "a\nb\nc");
});

test("字符串原样返回 —— 老 book 必须照跑不误", () => {
  assert.equal(bookCodeToSource("a\nb"), "a\nb");
});

test("切分对 \\r\\n 与 \\n 一视同仁", () => {
  assert.deepEqual(bookSourceToLines("a\r\nb\nc"), ["a", "b", "c"]);
});

test("join 与 split 在 \\n 源码上互为逆操作", () => {
  const src = "const a = 1;\nif (a) {\n  return a;\n}";
  assert.equal(bookCodeToSource(bookSourceToLines(src)), src);
});

test("三种真实落点全部归一化 —— 动作 / 校验 / 信号", () => {
  // 与实测到的 JSON 路径一一对应：steps[].action.params.code、
  // steps[].verify.evalCheck.code、pages.*.signals.*.condition.all[].script.code。
  const book = {
    steps: [
      {
        action: { method: "browser.eval", params: { code: ["const a = 1;", "return a;"] } },
        verify: { evalCheck: { code: ["document", "  .title"] } },
      },
    ],
    pages: {
      p: {
        signals: {
          ready: { condition: { all: [{ urlIncludes: "/x" }, { script: { code: ["1", "+ 1"] } }] } },
        },
      },
    },
  };

  assert.equal(normalizeBookCode(book), 3, "三处都要被合成，少一处就是漏了一种落点");
  assert.equal(book.steps[0].action.params.code, "const a = 1;\nreturn a;");
  assert.equal(book.steps[0].verify.evalCheck.code, "document\n  .title");
  const cond = book.pages.p.signals.ready.condition.all[1] as unknown as { script: { code: string } };
  assert.equal(cond.script.code, "1\n+ 1");
});

test("非代码的 code 字段不被误伤", () => {
  // RPC 错误码这类 `code` 是数字/枚举，不是行数组，必须原样留着。
  const payload = { error: { code: 500 }, tags: { code: ["a", "b"] } };
  const joined = normalizeBookCode(payload);
  assert.equal(payload.error.code, 500);
  // `tags.code` 恰好是字符串数组，会被合成 —— 这是按 key 递归的已知代价。
  // 断言写出来是为了让它成为**明示的**契约：book 里除内联 JS 外不得再用名为
  // `code` 的字符串数组字段。哪天有人加了，这条会连同下面的计数一起变红。
  assert.equal(joined, 1);
  assert.equal(payload.tags.code, "a\nb");
});

test("空数组不当成空代码 —— 留给下游报错，别悄悄吞掉", () => {
  const book = { steps: [{ action: { params: { code: [] } } }] };
  assert.equal(normalizeBookCode(book), 0);
  assert.deepEqual(book.steps[0].action.params.code, []);
});

test("混入非字符串元素时不合成 —— 那是写坏了，不是代码", () => {
  const book = { steps: [{ action: { params: { code: ["a", 1] } } }] };
  assert.equal(normalizeBookCode(book), 0);
});

test("写盘侧把字符串切回行数组", () => {
  const book = { steps: [{ action: { params: { code: "const a = 1;\nreturn a;" } } }] };
  assert.equal(splitBookCode(book), 1);
  assert.deepEqual(book.steps[0].action.params.code, ["const a = 1;", "return a;"]);
});

test("split 之后再 normalize 回到原样 —— 存盘再读盘不得改变代码", () => {
  const source = "const vis = e => {\n  return e.width > 0;\n};\nreturn vis;";
  const book = { steps: [{ verify: { evalCheck: { code: source } } }] };
  splitBookCode(book);
  normalizeBookCode(book);
  assert.equal(book.steps[0].verify.evalCheck.code, source);
});
