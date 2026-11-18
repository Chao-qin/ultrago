import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const entry of ['start', 'start:no-weclaw', 'restart']) {
  test(`${entry} checks Python before building or stopping services`, (t) => {
    const root = fixture(t);
    mkdirSync(path.join(root, 'bin'));
    writeFileSync(path.join(root, 'bin/pnpm'), '#!/bin/bash\necho "$*"\nif [ "$1" = "python:check" ]; then exit 7; fi\n', { mode: 0o755 });
    writeFileSync(path.join(root, 'scripts/backend.sh'), '#!/bin/bash\necho "backend $*"\n');
    const command = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts[entry];
    const result = spawnSync('bash', ['-c', command], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}` },
    });
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout.trim(), 'python:check');
  });
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'bcp-python runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'scripts'));
  for (const file of ['scripts/python.sh', 'scripts/check-python-runtime.py', '.python-version', 'uv.lock']) {
    copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  return root;
}

test('missing project environment fails before executing user code', (t) => {
  const root = fixture(t);
  const result = spawnSync('bash', [path.join(root, 'scripts/python.sh'), '-c', 'print("executed")'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pnpm python:setup/);
  assert.equal(result.stdout, '');
});

for (const dependency of ['pillow', 'openpyxl']) {
  test(`${dependency} drift fails before executing user code`, (t) => {
    const root = fixture(t);
    symlinkSync(path.join(ROOT, '.venv'), path.join(root, '.venv'), 'dir');
    writeFileSync(path.join(root, 'uv.lock'), `[[package]]\nname = "${dependency}"\nversion = "0.0.0"\nsource = { registry = "https://pypi.org/simple" }\n`);
    const result = spawnSync('bash', [path.join(root, 'scripts/python.sh'), '-c', 'print("executed")'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${dependency} 版本不匹配`, 'i'));
    assert.match(result.stderr, /pnpm python:setup/);
    assert.equal(result.stdout, '');
  });
}

test('project Python includes the spreadsheet dependency used by repository scripts', () => {
  const result = spawnSync('bash', [path.join(ROOT, 'scripts/python.sh'), '-c', [
    'from io import BytesIO',
    'from openpyxl import Workbook, load_workbook',
    'book = Workbook()',
    'book.active["A1"] = "商品评论"',
    'data = BytesIO()',
    'book.save(data)',
    'data.seek(0)',
    'assert load_workbook(data).active["A1"].value == "商品评论"',
  ].join('\n')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('Python version drift fails before executing user code', (t) => {
  const root = fixture(t);
  symlinkSync(path.join(ROOT, '.venv'), path.join(root, '.venv'), 'dir');
  writeFileSync(path.join(root, '.python-version'), '3.10.0\n');
  const result = spawnSync('bash', [path.join(root, 'scripts/python.sh'), '-c', 'print("executed")'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Python 版本不匹配/);
  assert.equal(result.stdout, '');
});

test('project Python ignores ambient Python settings and preserves exit status', () => {
  const result = spawnSync('bash', [path.join(ROOT, 'scripts/python.sh'), '-c', 'import sys; print(sys.prefix); sys.exit(7)'], {
    cwd: tmpdir(),
    encoding: 'utf8',
    env: { ...process.env, PYTHONHOME: '/nonexistent', PYTHONPATH: '/nonexistent' },
  });
  assert.equal(result.status, 7, result.stderr);
  assert.equal(result.stdout.trim(), path.join(ROOT, '.venv'));
});

test('an interpreter without tomllib still reports how to repair its version', () => {
  const program = [
    'import builtins, importlib.util, sys',
    'from unittest.mock import patch',
    'original_import = builtins.__import__',
    'def legacy_import(name, *args, **kwargs):',
    '    if name == "tomllib": raise ModuleNotFoundError("No module named tomllib")',
    '    return original_import(name, *args, **kwargs)',
    'spec = importlib.util.spec_from_file_location("runtime_check", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'sys.argv = [sys.argv[1]]',
    'with patch("builtins.__import__", side_effect=legacy_import):',
    '    spec.loader.exec_module(module)',
    '    with patch.object(sys, "version_info", (3, 10, 0)):',
    '        sys.exit(module.main())',
  ].join('\n');
  const result = spawnSync(path.join(ROOT, '.venv/bin/python'), ['-c', program, path.join(ROOT, 'scripts/check-python-runtime.py')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Python 版本不匹配/);
  assert.match(result.stderr, /pnpm python:setup/);
});
