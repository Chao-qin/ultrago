import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('navigation and routes present scripts as a library with a full-page editor', async () => {
  const [app, list] = await Promise.all([
    read('packages/console/web/src/App.tsx'),
    read('packages/console/web/src/pages/Scripts.tsx'),
  ]);
  assert.match(app, /label: ["']脚本库["']/);
  assert.match(app, /path=["']\/scripts\/new["']/);
  assert.match(list, /navigate\(["']\/scripts\/new["']\)/);
  assert.doesNotMatch(list, /ScriptFormDialog/);
  assert.match(list, /更新时间/);
});

test('standalone workbench shares contracts and draft testing', async () => {
  const page = await read('packages/console/web/src/pages/ScriptWorkbench.tsx');
  assert.match(page, /<ScriptEditor/);
  assert.match(page, /kind=["']input["']/);
  assert.match(page, /kind=["']output["']/);
  assert.match(page, /<ScriptTestConsole/);
  assert.match(page, /未保存/);
  assert.match(page, /运行已保存版本/);
  assert.match(page, /api\.runScript/);
  assert.match(page, /受影响的定时任务/);
});

test('new scripts offer blank, template and pasted-code starting points', async () => {
  const page = await read('packages/console/web/src/pages/ScriptWorkbench.tsx');
  assert.match(page, /空白脚本/);
  assert.match(page, /常用模板/);
  assert.match(page, /粘贴已有代码/);
  assert.match(page, /恢复本地草稿/);
});

test('saved scripts can run or create a preselected schedule from every main entry', async () => {
  const [list, workbench, schedules] = await Promise.all([
    read('packages/console/web/src/pages/Scripts.tsx'),
    read('packages/console/web/src/pages/ScriptWorkbench.tsx'),
    read('packages/console/web/src/pages/Schedules.tsx'),
  ]);
  assert.match(list, /运行已保存版本/);
  assert.match(list, /创建定时任务/);
  assert.match(workbench, /创建定时任务/);
  assert.match(schedules, /useSearchParams/);
  assert.match(schedules, /scriptId/);
  assert.match(workbench, /status === 'success'/);
  assert.match(workbench, /脚本运行失败/);
});

test('confirming an incompatible contract pauses impacted schedules', async () => {
  const page = await read('packages/console/web/src/pages/ScriptWorkbench.tsx');
  assert.match(page, /保存并暂停/);
  assert.match(page, /api\.updateSchedule/);
});

test('a running draft trial can be stopped', async () => {
  const [consoleSource, api] = await Promise.all([
    read('packages/console/web/src/components/script-test-console.tsx'),
    read('packages/console/web/src/lib/api.ts'),
  ]);
  assert.match(consoleSource, /停止试跑/);
  assert.match(consoleSource, /AbortController/);
  assert.match(api, /signal/);
});

test('trial failures expose a category and a user-code location', async () => {
  const [consoleSource, editor, page] = await Promise.all([
    read('packages/console/web/src/components/script-test-console.tsx'),
    read('packages/console/web/src/components/ScriptEditor.tsx'),
    read('packages/console/web/src/pages/ScriptWorkbench.tsx'),
  ]);
  assert.match(consoleSource, /errorCategory/);
  assert.match(consoleSource, /errorLocation/);
  assert.match(consoleSource, /错误分类/);
  assert.match(consoleSource, /跳到代码/);
  assert.match(editor, /revealLine/);
  assert.match(page, /onErrorLocation/);
});

test('advanced contracts reject invalid schema structure without losing the draft text', async () => {
  const editor = await read('packages/console/web/src/components/script-contract-editor.tsx');
  assert.match(editor, /validateScriptContractDefinition/);
  assert.match(editor, /Schema 结构无效/);
  assert.match(editor, /setRaw\(next\)/);
  assert.match(editor, /onValidityChange/);
  assert.match(editor, /Modal\.confirm/);
  assert.match(editor, /替换当前定义/);
});

test('unsaved workbench changes guard app navigation as well as page closing', async () => {
  const [app, page] = await Promise.all([
    read('packages/console/web/src/App.tsx'),
    read('packages/console/web/src/pages/ScriptWorkbench.tsx'),
  ]);
  assert.match(app, /UnsavedChangesProvider/);
  assert.match(page, /useUnsavedChangesGuard/);
  assert.match(page, /beforeunload/);
});

test('field contracts expose nested fields and common constraints', async () => {
  const editor = await read('packages/console/web/src/components/param-list-editor.tsx');
  assert.match(editor, /嵌套字段/);
  assert.match(editor, /显示名称/);
  assert.match(editor, /最小长度/);
  assert.match(editor, /最小值/);
  assert.match(editor, /格式/);
});

test('the body-only editor hides its generated wrapper and offers formatting', async () => {
  const editor = await read('packages/console/web/src/components/ScriptEditor.tsx');
  assert.match(editor, /查看运行包装/);
  assert.match(editor, /格式化代码/);
  assert.match(editor, /indentRange/);
});

test('trial output inference is reviewable and can be adopted field by field', async () => {
  const consoleSource = await read('packages/console/web/src/components/script-test-console.tsx');
  assert.match(consoleSource, /逐字段采用/);
  assert.match(consoleSource, /Checkbox/);
  assert.match(consoleSource, /mergeInferredFields/);
  assert.match(consoleSource, /待确认/);
  assert.match(consoleSource, /当前定义/);
  assert.match(consoleSource, /建议定义/);
});

test('script schedules render declared parameters instead of requiring raw JSON', async () => {
  const page = await read('packages/console/web/src/pages/Schedules.tsx');
  assert.match(page, /scriptParamSchema/);
  assert.match(page, /<SchemaParamEditor schema=\{scriptParamSchema\}/);
  assert.doesNotMatch(page, /name=["']paramsText["']/);
  assert.match(page, /参数待修复/);
  assert.match(page, /validateParams/);
});

test('flow and standalone scripts share the same test console', async () => {
  const panel = await read('packages/console/web/src/components/FlowScriptPanel.tsx');
  assert.match(panel, /ScriptTestConsole/);
  assert.match(panel, /从脚本库导入/);
  assert.match(panel, /保存到脚本库/);
  assert.match(panel, /不会自动同步/);
  assert.match(panel, /description: selected\.description/);
});

test('trial cancellation and running duration are distinct from failure', async () => {
  const consoleSource = await read('packages/console/web/src/components/script-test-console.tsx');
  assert.match(consoleSource, /试跑已取消/);
  assert.match(consoleSource, /errorCategory: 'cancelled'/);
  assert.match(consoleSource, /已运行/);
});

test('the workbench explains module loading and runtime boundaries', async () => {
  const page = await read('packages/console/web/src/pages/ScriptWorkbench.tsx');
  assert.match(page, /await import/);
  assert.match(page, /文件和子进程/);
  assert.match(page, /网络未被禁止/);
});

test('trial, manual run and schedules share the schema parameter editor', async () => {
  const [consoleSource, workbench, schedules] = await Promise.all([
    read('packages/console/web/src/components/script-test-console.tsx'),
    read('packages/console/web/src/pages/ScriptWorkbench.tsx'),
    read('packages/console/web/src/pages/Schedules.tsx'),
  ]);
  assert.match(consoleSource, /SchemaParamEditor/);
  assert.match(workbench, /SchemaParamEditor/);
  assert.match(schedules, /SchemaParamEditor/);
});
