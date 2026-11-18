import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runLocalEval } from './local-actions.js';
import { fillSlots } from './playbook.js';
import { extractOutputs } from './delivery-executor.js';
import type { PlaybackStepResult } from './playback.js';

const book = JSON.parse(readFileSync(new URL('../../../resource/playbooks/doudian-publish-canonical.json', import.meta.url), 'utf8'));
/** 按 goal 前缀定位，并在找不到时响亮失败：这些前缀同时写在 local.eval 的代码里
 * （它用 startsWith 认上游步骤），所以「找不到」意味着两边已经漂了，不是测试写错。 */
const stepAt = (prefix: string) => {
  const i = book.steps.findIndex((step: { goal: string }) => step.goal.startsWith(prefix));
  if (i < 0) throw new Error(`doudian-publish-canonical 里没有「${prefix}」开头的步骤 —— 断言没有目标 = 没有测`);
  return i;
};
const checkIndex = stepAt('提交前运行抖店的填写检查');
const submitIndex = stepAt('按填写检查后的实际落点提交');
const readIndex = stepAt('读回执页全文');
const assembly = book.steps[readIndex + 1];
const TITLE = '爆炸头萌新出击手办盲盒装饰小众创意生日礼物蜡笔小新周边盲盒批';
// 槽位走真实的 fillSlots：整对象的 inline slot → JSON 字面量，和 replay 时一模一样。
const assemblyCode = (fillSlots(assembly.action.params as Record<string, unknown>, { product: { title: { text: TITLE } } }) as { code: string[] }).code.join('\n');
const result = (index: number, method: string, goal: string, value: unknown): PlaybackStepResult => ({ index, method, goal, value });

const DRAFT_URL = 'https://fxg.jinritemai.com/ffa/g/draft';
const LIST_URL = 'https://fxg.jinritemai.com/ffa/g/list';
/** 回执页 innerText 的形状：一整行表格被拆成多段换行，行与行之间没有任何结构标记 —— 这正是
 * 从 browser.eval(querySelector 一个 tr) 换成 readContent(整页文本) 之后要面对的东西。 */
const LIST_HEAD = '商品管理\n商品信息\n价格\n库存\n状态\n操作\n';
const row = (title: string, id: string, status: string, stamp = '2026/09/15 09:39:46') => `${title}\nID: ${id}\n￥69.00\n${status}\n${stamp}\n`;

/** 组装 local.eval 看得到的上游：填写检查 → 提交 → 读全文。提交那一条是 draft/publish 的
 * 唯一权威来源（它只有拿到成功凭据才返回），读全文那一条是解析原料。 */
const upstream = ({
  mode = 'draft',
  text = LIST_HEAD + row(TITLE, '123456789012', '待提交'),
  checkErrors = [] as string[],
  missingRequired = [] as string[],
  url = DRAFT_URL,
  omitSubmit = false,
  page = undefined as unknown,
}: Partial<{ mode: string; text: string; checkErrors: string[]; missingRequired: string[]; url: string; omitSubmit: boolean; page: unknown }> = {}) =>
  [
    result(checkIndex, 'browser.eval', book.steps[checkIndex].goal, { value: { ok: true, requestedMode: 'auto', mode, checked: true, checkErrors, missingRequired } }),
    omitSubmit
      ? null
      : result(submitIndex, 'browser.eval', book.steps[submitIndex].goal, { value: { ok: true, mode, clicked: mode === 'publish' ? '发布商品' : '保存草稿', receiptPath: mode === 'publish' ? '/ffa/g/list' : '/ffa/g/draft', checkErrors } }),
    result(readIndex, 'browser.readContent', book.steps[readIndex].goal, page === undefined ? { value: { url, title: '商品管理', text } } : page),
  ].filter(Boolean) as PlaybackStepResult[];

function assemble(results: PlaybackStepResult[]) {
  assert.equal(assembly.action.method, 'local.eval');
  const value = runLocalEval(assemblyCode, results);
  return extractOutputs([...results, result(readIndex + 1, 'local.eval', assembly.goal, value), result(readIndex + 2, 'browser.closeTab', '关闭 tab', { ok: true })]);
}

test('book owns publication outcome classification and rejects inconsistent receipts', () => {
  for (const [mode, status, expected] of [
    ['draft', '待提交', 'draft_saved'],
    ['draft', '草稿', 'draft_saved'],
    ['publish', '审核中', 'published'],
    ['publish', '售卖中', 'published'],
    ['publish', '待提交', 'needs_verification'],
    ['draft', '售卖中', 'needs_verification'],
    ['publish', '未知', 'needs_verification'],
  ]) {
    const output = assemble(upstream({ mode, url: mode === 'publish' ? LIST_URL : DRAFT_URL, text: LIST_HEAD + row(TITLE, '123456789012', status) })) as { outcome: { status: string } };
    assert.equal(output.outcome.status, expected, `${mode}/${status}`);
  }
});

test('official book output preserves the latest receipt through local evaluation and tab closure', () => {
  const output = JSON.parse(JSON.stringify(assemble(upstream())));
  const { outcome, ...receipt } = output;
  assert.deepEqual(receipt, {
    ok: true,
    mode: 'draft',
    missingRequired: [],
    productId: '123456789012',
    status: '待提交',
    createdAt: '2026/09/15 09:39:46',
    title: TITLE,
    receiptUrl: DRAFT_URL,
    productUrl: null,
    productUrlSource: null,
    // readContent 只给文本，行内的 record 与锚点都取不到。留空 + 说明，不猜 URL 格式。
    productUrlNote: receipt.productUrlNote,
  });
  assert.equal(typeof receipt.productUrlNote, 'string');
  assert.equal(outcome.status, 'draft_saved');
  assert.equal(outcome.resourceId, '123456789012');
  assert.equal(book.steps[readIndex + 2].action.method, 'browser.closeTab');
  assert.equal(assembly.verify.actionSucceeded, true);
  assert.equal(assembly.onFail, 'escalate');
  assert.equal(assembly.page, book.steps[readIndex].page);
  assert.ok(assembly.gate.all.includes('receiptReady'));
});

test('the receipt text is taken from the LAST read, never an older one', () => {
  // 旧的一次读数里有另一个商品的 ID；只认最后一条 readContent，否则会认领别人的产出。
  const stale = result(readIndex - 1, 'browser.readContent', book.steps[readIndex].goal, { value: { url: DRAFT_URL, title: '商品管理', text: LIST_HEAD + row(TITLE, '999999999999', '待提交') } });
  const output = assemble([stale, ...upstream()]) as { productId: string };
  assert.equal(output.productId, '123456789012');
});

test('missing or malformed latest receipt cannot reuse an older successful object', () => {
  for (const page of [undefined, {}, { value: null }, { value: { url: DRAFT_URL, title: '商品管理' } }, { value: { text: 42 } }]) {
    assert.throws(() => assemble(upstream({ page: page ?? null })), /receipt/i);
  }
  // 最后一条不是「读回执页全文」——上一步换成了别的动作，解析没有原料。
  assert.throws(() => assemble([result(readIndex, 'browser.eval', '无关步骤', { value: { text: 'x' } })]), /receipt/i);
  // 没有提交凭据就不知道点的是 draft 还是 publish；此时产出任何 outcome 都是伪造。
  // 这一条比改版前更严（旧实现让它落到 needs_verification）：旧实现的 mode 读自页面 URL，
  // 是个可以在不知情时也「猜得出来」的东西，而落点是不可逆动作的性质，不该靠猜。
  assert.throws(() => assemble(upstream({ omitSubmit: true })), /submit receipt/i);
});

test('an explicit failed receipt stays failed rather than manufacturing success', () => {
  // 2026-09-13 run a15accc6 的形状：已经点了「发布商品」并跳到 /ffa/g/list，
  // 但列表里读不到这条商品。它必须产出「待核验」，并且【保住已经点下去的那件事】——
  // 那次是整步失败把它抹掉的，run 记 failed、productId 丢失、上层看到「从来没发布过」。
  const output = JSON.parse(JSON.stringify(assemble(upstream({ mode: 'publish', url: LIST_URL, text: LIST_HEAD + row('别人家的商品', '3800000000000000000', '售卖中') }))));
  assert.equal(output.ok, false);
  assert.equal(output.productId, null);
  assert.equal(output.status, null);
  assert.equal(output.mode, 'publish');
  assert.match(output.reason, /发布商品/);
  assert.equal(output.outcome.status, 'needs_verification');
  assert.equal(output.outcome.level, 'warning');
});

for (const [label, text] of [
  ['缺状态', `${LIST_HEAD}${TITLE}\nID: 123456789012\n￥69.00\n`],
  ['缺 ID', `${LIST_HEAD}${TITLE}\n￥69.00\n待提交\n`],
]) {
  test(`incomplete observed receipt returns a valid needs-verification outcome (${label})`, () => {
    const output = JSON.parse(JSON.stringify(assemble(upstream({ text }))));
    assert.equal(output.outcome.status, 'needs_verification');
    assert.equal(Object.hasOwn(output, 'productId'), true);
    assert.equal(Object.hasOwn(output, 'status'), true);
  });
}
