import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { runtimePort, desktopHttpGuard } from './desktop-runtime.js';

test('shared runtime can be loaded by the extension without Node globals', () => {
  const source = readFileSync(new URL('./desktop-runtime.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  runInNewContext(outputText, { exports });
  assert.equal(exports.desktopRuntimeActive(), true);
});

test('desktop recovery callbacks wait for user activation and can be cancelled', () => {
  const source = readFileSync(new URL('./desktop-runtime.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  let receive = (_event: { data: { type: string } }) => { assert.fail('parent listener was not registered'); };
  runInNewContext(outputText, { exports, process: { env: { BCP_DESKTOP: '1' }, parentPort: {
    on: (_name: string, listener: typeof receive) => { receive = listener; },
  } } });
  let calls = 0;
  exports.desktopAfterActivation(() => { calls++; });
  const cancel = exports.desktopAfterActivation(() => { calls += 100; }) as () => void;
  cancel();
  assert.equal(exports.desktopRuntimeActive(), false);
  assert.equal(calls, 0);
  receive({ data: { type: 'heartbeat' } });
  assert.equal(calls, 0);
  receive({ data: { type: 'activate' } });
  receive({ data: { type: 'activate' } });
  assert.equal(calls, 1);
  assert.equal(exports.desktopRuntimeActive(), true);
});

test('runtime port preserves OS-assigned zero and validates explicit input', () => {
  assert.equal(runtimePort('0', 8787), 0);
  assert.equal(runtimePort(undefined, 8787), 8787);
  assert.equal(runtimePort('65535', 8787), 65535);
  for (const value of ['-1', '65536', '1.2', ' ', 'NaN', '0x10']) assert.throws(() => runtimePort(value, 8787));
});

test('desktop direct HTTP access requires its current launch credential', () => {
  const oldMode = process.env.BCP_DESKTOP;
  const oldToken = process.env.BCP_DESKTOP_TOKEN;
  try {
    process.env.BCP_DESKTOP = '1'; process.env.BCP_DESKTOP_TOKEN = 'current';
    let called = false;
    const res = { statusCode: 200, end: (_body: string) => {} };
    desktopHttpGuard({ headers: {} }, res, () => { called = true; });
    assert.equal(res.statusCode, 401); assert.equal(called, false);
    for (const wrong of ['Bearer currenT', 'Bearer curren', 'Bearer current ', 'current', 'Bearer undefined']) {
      res.statusCode = 200;
      desktopHttpGuard({ headers: { authorization: wrong } }, res, () => { called = true; });
      assert.equal(res.statusCode, 401, wrong); assert.equal(called, false, wrong);
    }
    desktopHttpGuard({ headers: { authorization: 'Bearer current' } }, res, () => { called = true; });
    assert.equal(called, true);
    delete process.env.BCP_DESKTOP_TOKEN;
    called = false; res.statusCode = 200;
    desktopHttpGuard({ headers: { authorization: 'Bearer undefined' } }, res, () => { called = true; });
    assert.equal(res.statusCode, 401, '令牌没下发时 "Bearer undefined" 不是正确令牌'); assert.equal(called, false);
  } finally {
    if (oldMode === undefined) delete process.env.BCP_DESKTOP; else process.env.BCP_DESKTOP = oldMode;
    if (oldToken === undefined) delete process.env.BCP_DESKTOP_TOKEN; else process.env.BCP_DESKTOP_TOKEN = oldToken;
  }
});
