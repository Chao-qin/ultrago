import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { ChildProcess } from 'node:child_process';
import { FlowRunnerService, resolveInsideRepo, runScriptProcess, scriptEnv, terminateScriptTree } from './flow-runner.service.js';

test('service shutdown waits for running scripts and dry runs and prevents further launches', async () => {
  const runner = new FlowRunnerService(null as never, null as never, null as never, null as never, null as never, null as never, null as never);
  const owned = runner as unknown as { runScript: typeof runScriptProcess; scriptTasks: Set<Promise<unknown>> };
  let child: ChildProcess | undefined;
  let ready!: () => void;
  const started = new Promise<void>((done) => { ready = done; });
  const command = owned.runScript({ command: [process.execPath, '-e', 'process.stderr.write("fixture-ready");setInterval(()=>{},100);'], timeoutMs: 3000 }, {}, { input: null, output: null }, (proc) => {
    child = proc;
    proc.stderr!.once('data', ready);
  });
  const dry = runner.dryRunScript({ source: 'await new Promise(resolve => setTimeout(resolve, 10000)); return {};', language: 'ts' }, {});
  try {
    await started;
    assert.equal(owned.scriptTasks.size, 2);
    await runner.onModuleDestroy();
    assert.equal((await command).errorCategory, 'cancelled');
    assert.equal((await dry).errorCategory, 'cancelled');
    assert.equal(owned.scriptTasks.size, 0);
    assert.ok(child!.exitCode !== null || child!.signalCode !== null);
    const after = await runner.dryRunScript({ source: 'return {};', language: 'ts' }, {});
    assert.equal(after.errorCategory, 'cancelled');
  } finally {
    if (child) terminateScriptTree(child);
    await runner.onModuleDestroy();
  }
});

test('desktop scripts use a real user directory and enable Node only for the owned executable', () => {
  const previous = { desktop: process.env.BCP_DESKTOP, root: process.env.BCP_DATA_ROOT, secret: process.env.BCP_DESKTOP_TOKEN };
  process.env.BCP_DESKTOP = '1';
  process.env.BCP_DATA_ROOT = tmpdir();
  process.env.BCP_DESKTOP_TOKEN = 'must-not-reach-script';
  try {
    assert.equal(resolveInsideRepo(undefined), tmpdir());
    assert.throws(() => resolveInsideRepo('../outside'), /逃出了仓库目录/);
    assert.equal(scriptEnv(process.execPath).ELECTRON_RUN_AS_NODE, '1');
    assert.equal(scriptEnv('python').ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(scriptEnv(process.execPath).BCP_DESKTOP_TOKEN, undefined);
    delete process.env.BCP_DATA_ROOT;
    assert.throws(() => resolveInsideRepo(undefined), /用户数据目录/);
  } finally {
    for (const [key, value] of Object.entries({ BCP_DESKTOP: previous.desktop, BCP_DATA_ROOT: previous.root, BCP_DESKTOP_TOKEN: previous.secret })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Windows cancellation targets only the owned PID and its descendants and surfaces failures', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const childProcess = createRequire(import.meta.url)('node:child_process');
  const requests: unknown[][] = [];
  let status = 0;
  const call = mock.method(childProcess, 'spawnSync', (...args: unknown[]) => { requests.push(args); return { status, stderr: 'access denied' }; });
  Object.defineProperty(process, 'platform', { value: 'win32' });
  syncBuiltinESMExports();
  try {
    const proc = { pid: 123456, exitCode: null, signalCode: null } as ChildProcess;
    terminateScriptTree(proc);
    assert.deepEqual(requests[0][1], ['/PID', '123456', '/T', '/F']);
    assert.ok(String(requests[0][0]).endsWith('taskkill.exe'));
    status = 1;
    assert.throws(() => terminateScriptTree(proc), /access denied/);
    terminateScriptTree({ ...proc, exitCode: 0 } as ChildProcess);
    assert.equal(requests.length, 2);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    call.mock.restore();
    syncBuiltinESMExports();
  }
});

test('a Windows taskkill failure is reported by the script timeout instead of claiming successful cleanup', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const childProcess = createRequire(import.meta.url)('node:child_process');
  const call = mock.method(childProcess, 'spawnSync', () => ({ status: 1, stderr: 'fixture-taskkill-denied' }));
  Object.defineProperty(process, 'platform', { value: 'win32' });
  syncBuiltinESMExports();
  try {
    const result = await runScriptProcess({ command: [process.execPath, '-e', 'setInterval(() => {}, 100);'], timeoutMs: 80 }, {}, { input: null, output: null });
    assert.equal(result.ok, false);
    assert.match(result.error!, /进程树终止未确认.*fixture-taskkill-denied/);
    assert.match(result.stderr, /进程树终止失败/);
    assert.doesNotMatch(result.stderr, /已终止/);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    call.mock.restore();
    syncBuiltinESMExports();
  }
});

test('an abort failure survives the later timeout after the parent exits while a descendant holds its pipes', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const childProcess = createRequire(import.meta.url)('node:child_process');
  const call = mock.method(childProcess, 'spawnSync', () => ({ status: 1, stderr: 'first-termination-failed' }));
  Object.defineProperty(process, 'platform', { value: 'win32' });
  syncBuiltinESMExports();
  const controller = new AbortController();
  try {
    const source = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setTimeout(()=>{},350)'],{stdio:['ignore',process.stdout,process.stderr]});process.stderr.write('fixture-ready');setInterval(()=>{},100);`;
    const result = await runScriptProcess({ command: [process.execPath, '-e', source], timeoutMs: 250 }, {}, { input: null, output: null }, (proc) => {
      proc.stderr!.on('data', (chunk) => { if (String(chunk).includes('fixture-ready')) controller.abort(); });
    }, controller.signal);
    assert.equal(result.ok, false);
    assert.match(result.error!, /进程树终止未确认.*first-termination-failed/);
    assert.match(result.stderr, /进程树终止失败/);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    call.mock.restore();
    syncBuiltinESMExports();
  }
});
