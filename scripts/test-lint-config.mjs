import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { promisify } from 'node:util';

import { ESLint } from 'eslint';

import { LINT_CONFIG } from './lint-config.mjs';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = new URL('..', import.meta.url);
const require = createRequire(import.meta.url);
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: LINT_CONFIG,
  fix: false,
});

async function lintText(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });

  return result;
}

function supportsApprovedNodeRange(version) {
  const [major, minor] = version.split('.').map(Number);

  return (
    (major === 20 && minor >= 19) ||
    (major === 22 && minor >= 13) ||
    major >= 24
  );
}

test('declares Node support compatible with installed lint visitor keys', () => {
  const rootPackage = require('../package.json');
  const typescriptEslintRequire = createRequire(require.resolve('typescript-eslint'));
  const parserRequire = createRequire(
    typescriptEslintRequire.resolve('@typescript-eslint/parser'),
  );
  const visitorKeysRequire = createRequire(
    parserRequire.resolve('@typescript-eslint/visitor-keys'),
  );
  const visitorKeysPackage = visitorKeysRequire('eslint-visitor-keys/package.json');
  const supportedNodeRange = '^20.19.0 || ^22.13.0 || >=24';

  assert.equal(rootPackage.engines.node, supportedNodeRange);
  assert.equal(visitorKeysPackage.engines.node, supportedNodeRange);
  assert.ok(
    supportsApprovedNodeRange(process.versions.node),
    `Node ${process.versions.node} must satisfy ${supportedNodeRange}`,
  );
});

test('exports a named flat configuration without a default export', async () => {
  const lintConfigModule = await import('./lint-config.mjs');

  assert.ok(Array.isArray(lintConfigModule.LINT_CONFIG));
  assert.equal('default' in lintConfigModule, false);
});

test('reports debugger statements', async () => {
  const result = await lintText('debugger;', 'scripts/example.mjs');

  assert.ok(result.messages.some((message) => message.ruleId === 'no-debugger'));
});

test('reports duplicate switch cases', async () => {
  const result = await lintText(
    'switch (value) { case 1: break; case 1: break; }',
    'scripts/example.mjs',
  );

  assert.ok(result.messages.some((message) => message.ruleId === 'no-duplicate-case'));
});

test('reports unparenthesized assignment conditions', async () => {
  const result = await lintText('if (value = next) {}', 'scripts/example.mjs');

  assert.ok(result.messages.some((message) => message.ruleId === 'no-cond-assign'));
});

test('accepts parenthesized assignment conditions', async () => {
  const result = await lintText('if ((value = next)) {}', 'scripts/example.mjs');

  assert.equal(result.errorCount, 0);
});

test('parses valid TypeScript interfaces and type imports', async () => {
  const result = await lintText(
    "import type { Item } from './item.js';\ninterface Box { item: Item }\nexport const box: Box = {} as Box;",
    'packages/shared/src/example.ts',
  );

  assert.equal(result.errorCount, 0);
});

test('parses valid TSX', async () => {
  const result = await lintText(
    'interface Props { label: string }\nexport const Button = ({ label }: Props) => <button>{label}</button>;',
    'packages/extension/src/example.tsx',
  );

  assert.equal(result.errorCount, 0);
});

test('ignores known generated, build, and cache outputs', async () => {
  const ignoredPaths = [
    'packages/backend/dist/example.js',
    'packages/console/dist-web/assets/example.js',
    'packages/console/web/vite.config.ts.timestamp-example.mjs',
    'packages/extension/.output/chrome-mv3/example.js',
    'packages/extension/.wxt/example.ts',
    'packages/llm/scripts/.opencode-home/.cache/example.js',
    'packages/shared/src/generated/example.ts',
    'packages/desktop/release/win-unpacked/resources/example.js',
    'packages/desktop/native/bin/prisma-client/example.js',
    'packages/comfyui/ComfyUI/custom_nodes/vendor/example.js',
  ];

  for (const filePath of ignoredPaths) {
    assert.equal(await eslint.isPathIgnored(filePath), true, filePath);
    const result = await lintText('debugger;', filePath);
    assert.equal(
      result.messages.some((message) => message.ruleId === 'no-debugger'),
      false,
      filePath,
    );
  }
});

test('keeps real source adjacent to generated output in lint scope', async () => {
  const sourcePaths = [
    'packages/console/web/src/example.tsx',
    'packages/extension/entrypoints/example.ts',
    'packages/llm/scripts/example.mjs',
    'packages/shared/src/example.ts',
    'packages/comfyui/nodes/bcp/web/config.js',
  ];

  for (const filePath of sourcePaths) {
    assert.equal(await eslint.isPathIgnored(filePath), false, filePath);
    const result = await lintText('debugger;', filePath);
    assert.ok(
      result.messages.some((message) => message.ruleId === 'no-debugger'),
      filePath,
    );
  }
});

test('lints existing console entry points without directive diagnostics', async () => {
  const results = await eslint.lintFiles([
    'packages/console/src/main.ts',
    'packages/console/web/src/components/ScriptEditor.tsx',
  ]);
  const diagnostics = results.flatMap((result) =>
    result.messages.map(
      (message) =>
        `${result.filePath}: ${message.ruleId ?? 'fatal'}: ${message.message}`,
    ),
  );

  assert.deepEqual(diagnostics, []);
});

test('pnpm lint accepts a focused path after the argument separator', async () => {
  await assert.doesNotReject(
    execFileAsync('pnpm', ['lint', '--', 'scripts/lint-config.mjs'], {
      cwd: PROJECT_ROOT,
    }),
  );
});

test('lint command reports configuration failures concisely', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['scripts/lint.mjs', 'missing-lint-target.mjs'],
      { cwd: PROJECT_ROOT },
    ),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /^Lint failed: /);
      return true;
    },
  );
});
