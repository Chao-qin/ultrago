import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Coordinator, appliedMigrations } from '../src/coordinator.mjs';
import { Supervisor } from '../src/supervisor.mjs';

const settle = () => new Promise((done) => setImmediate(done));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(condition, label) {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await sleep(2);
  assert.ok(condition(), label);
}

/** Utility-process stand-ins that never run code: readiness, output and exit are driven by the test. */
function workers() {
  const children = [];
  let port = 41000;
  const fork = (_worker, _args, options) => {
    const child = new EventEmitter();
    child.service = options.serviceName.replace('UltraGo ', '');
    child.env = options.env;
    child.stderr = new EventEmitter();
    child.messages = [];
    child.postMessage = (message) => {
      child.messages.push(message);
      if (message.type === 'shutdown') queueMicrotask(() => child.emit('exit', 0));
    };
    child.kill = () => { queueMicrotask(() => child.emit('exit', 1)); return true; };
    child.ready = () => {
      const endpoint = () => `http://127.0.0.1:${port++}`;
      const endpoints = child.service === 'backend' ? { ws: endpoint().replace('http:', 'ws:'), mcp: endpoint(), internal: endpoint() } : { [child.service]: endpoint() };
      child.emit('message', { type: 'ready', version: 1, generation: options.env.BCP_DESKTOP_GENERATION, service: child.service, endpoints });
    };
    children.push(child);
    return child;
  };
  const live = (service) => children.filter((child) => child.service === service).at(-1);
  const count = (service) => children.filter((child) => child.service === service).length;
  return { children, fork, live, count };
}
const supervised = (fork, restartDelay = 0) => new Supervisor({ fork, worker: '/unused', cwd: '/unused', env: { BCP_DESKTOP_GENERATION: 'now' }, generation: 'now', timeout: 1000, restartDelay });

test('the workbench service restarts alone with its activation, stops after the limit, and the browser service is never restarted', async () => {
  const { fork, live, count } = workers();
  const supervisor = supervised(fork);
  const failures = [];
  const restarted = [];
  supervisor.on('failure', (message) => failures.push(message));
  supervisor.on('restarted', (service) => restarted.push(service));
  try {
    const starting = Promise.all([supervisor.start('backend', '/backend'), supervisor.start('console', '/console')]);
    live('backend').ready(); live('console').ready();
    await starting;
    supervisor.activate();
    const consoleBefore = supervisor.endpoints.console.console;
    for (let exit = 1; exit <= 3; exit++) {
      live('console').emit('exit', 1);
      await until(() => count('console') === exit + 1, `console restart ${exit}`);
      live('console').ready();
      await until(() => restarted.length === exit, `restart ${exit} reported`);
    }
    assert.equal(count('backend'), 1, '浏览器服务不随工作台服务重启');
    assert.notEqual(supervisor.endpoints.console.console, consoleBefore);
    assert.deepEqual(live('console').messages.filter((message) => message.type === 'activate'), [{ type: 'activate' }], '重启后的服务继续处于激活状态');
    assert.deepEqual(failures, []);
    live('console').emit('exit', 1);
    await sleep(20);
    assert.equal(count('console'), 4, '1 分钟内超过 3 次不再重启');
    assert.match(failures[0], /连续退出 4 次/);
    live('backend').emit('exit', 1);
    await sleep(20);
    assert.equal(count('backend'), 1, '浏览器服务重启会让工作台重排已开始的任务，因此从不自动重启');
    assert.match(failures[1], /backend 已退出/);
  } finally { await supervisor.close(); }
});

test('stopping a service cancels its automatic restart, whether still waiting or already starting', async () => {
  const { fork, live, count } = workers();
  const supervisor = supervised(fork, 20);
  const failures = [];
  supervisor.on('failure', (message) => failures.push(message));
  try {
    const starting = supervisor.start('llm', '/llm', { BCP_DESKTOP_UPSTREAM_KEY: 'old-upstream-key' });
    live('llm').ready();
    await starting;
    live('llm').emit('exit', 1);
    await supervisor.stop('llm');
    await sleep(60);
    assert.equal(count('llm'), 1, '停止后不再按旧配置拉起');

    const again = supervisor.start('llm', '/llm', { BCP_DESKTOP_UPSTREAM_KEY: 'new-upstream-key' });
    live('llm').ready();
    await again;
    live('llm').emit('exit', 1);
    await until(() => count('llm') === 3, 'restart spawned');
    await supervisor.stop('llm');
    await sleep(20);
    assert.equal(count('llm'), 3);
    assert.deepEqual(failures, [], '重启启动途中被主动停止不是故障');
  } finally { await supervisor.close(); }
});

test('a key given to one service is redacted on that service’s own output stream, and early exits are not crashes', async () => {
  const { fork, live, count } = workers();
  const supervisor = supervised(fork);
  const failures = [];
  const logs = [];
  supervisor.on('failure', (message) => failures.push(message));
  supervisor.on('log', (entry) => logs.push(entry.text));
  try {
    const starting = supervisor.start('llm', '/llm', { BCP_DESKTOP_UPSTREAM_KEY: 'upstream-secret-key' });
    live('llm').stderr.emit('data', Buffer.from('gateway rejected upstream-se'));
    live('llm').stderr.emit('data', Buffer.from('cret-key\n'));
    live('llm').ready();
    await starting;
    live('llm').stderr.emit('end');
    assert.match(logs.join(''), /gateway rejected \[hidden\]/);
    assert.doesNotMatch(logs.join(''), /upstream-secret-key/);
    await supervisor.stop('llm');
    assert.equal(supervisor.endpoints.llm, undefined);
    const early = supervisor.start('console', '/console');
    live('console').emit('exit', 1);
    await assert.rejects(early, /已退出/);
    await sleep(10);
    assert.equal(count('console'), 1, '尚未就绪就退出由 start 报错，不自动重启');
    assert.deepEqual(failures, []);
  } finally { await supervisor.close(); }
});

async function preparedFixture() {
  const userData = await mkdtemp(join(tmpdir(), 'bcp-fast-start-'));
  const bundle = await mkdtemp(join(tmpdir(), 'bcp-bundle-'));
  const schema = join(bundle, 'prisma', 'schema.prisma');
  const addMigration = async (name) => {
    await mkdir(join(bundle, 'prisma', 'migrations', name), { recursive: true });
    await writeFile(join(bundle, 'prisma', 'migrations', name, 'migration.sql'), '-- fixture only');
  };
  await addMigration('0001_init');
  await writeFile(join(bundle, 'prisma', 'migrations', 'migration_lock.toml'), 'provider = "sqlite"');
  await writeFile(schema, 'model Fixture { id Int @id }');
  await mkdir(join(bundle, 'web'));
  await writeFile(join(bundle, 'web', 'index.html'), '<!doctype html>');
  await mkdir(join(bundle, 'extension'));
  await writeFile(join(bundle, 'extension', 'manifest.json'), JSON.stringify({ version: '0.1.7' }));
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const paths = {
    userData, db: join(userData, 'resource', 'db', 'console.db'), settings: join(userData, 'settings.json'), descriptor: join(userData, 'runtime.json'),
    extension: join(bundle, 'extension'), web: join(bundle, 'web'), schema, engines: bundle, python: 'python',
    templates: fileURLToPath(new URL('../templates', import.meta.url)), library: join(repository, 'resource/playbooks'),
    rawOfferSchema: join(repository, '.claude/skills/product-preprocess/raw-1688-offer.schema.json'),
    entries: { backend: schema, console: schema, llm: schema, migrate: schema },
  };
  const { children, fork, live, count } = workers();
  const migrations = [];
  let migrateExit = 0;
  const forkJob = (_entry, args) => {
    migrations.push(args);
    const child = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => child.emit('exit', migrateExit));
    return child;
  };
  // The migration table is read through this seam so no test opens or creates a database.
  const database = { applied: new Set(), readable: true };
  const coordinator = new Coordinator({
    paths, fork, forkJob, registerBridge: async () => {},
    readMigrations: () => { if (!database.readable) throw new Error('fixture: no such table: _prisma_migrations'); return database.applied; },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
  });
  coordinator.api = async () => ({});
  // Policy goes to the backend's internal port; here it is recorded instead of sent.
  const policies = [];
  coordinator.policyRequest = async (body) => { policies.push(body); };
  await coordinator.load();
  const prepare = async () => {
    const started = children.length;
    let settled = false;
    const running = coordinator.prepare().finally(() => { settled = true; });
    await until(() => settled || ['backend', 'console'].every((service) => children.slice(started).some((child) => child.service === service)), 'services forked');
    if (!settled) for (const child of children.slice(started)) child.ready();
    await running;
  };
  return { coordinator, paths, children, live, count, migrations, database, policies, addMigration, prepare, setMigrateExit: (code) => { migrateExit = code; } };
}

test('the database’s own migration table decides, and each set of pending migrations is backed up once', async () => {
  const { coordinator, paths, migrations, database, addMigration, prepare, setMigrateExit } = await preparedFixture();
  const backups = join(paths.userData, 'backups');
  const automatic = async () => (await readdir(backups)).filter((name) => /^\d{4}-/.test(name)).sort();
  try {
    await prepare();
    assert.equal(coordinator.phase, 'ready', coordinator.detail);
    assert.equal(migrations.length, 1, '没有数据库时执行迁移');
    await assert.rejects(readdir(backups), { code: 'ENOENT' }, '新库无需备份');

    await writeFile(paths.db, 'fixture database');
    database.applied = new Set(['0001_init']);
    await prepare();
    assert.equal(migrations.length, 1, '迁移表已包含全部随包迁移时跳过');
    await assert.rejects(readdir(backups), { code: 'ENOENT' }, '未迁移时不复制备份');

    database.applied = new Set();
    await prepare();
    assert.equal(migrations.length, 2, '恢复的旧库缺少迁移记录时重新迁移');
    assert.equal((await automatic()).length, 1);
    database.applied = new Set(['0001_init']);

    await addMigration('0002_next');
    await sleep(5);
    setMigrateExit(1);
    await prepare();
    assert.equal(coordinator.phase, 'failed');
    const firstTry = await automatic();
    assert.equal(firstTry.length, 2);
    assert.equal(await readFile(join(backups, firstTry.at(-1), 'pending.json'), 'utf8'), '["0002_next"]');
    await writeFile(paths.db, 'half migrated');
    for (let retry = 0; retry < 6; retry++) await prepare();
    assert.equal(migrations.length, 9);
    assert.deepEqual(await automatic(), firstTry, '同一批待执行迁移失败重试时不重复备份，迁移前的副本不会被挤掉');
    assert.equal(await readFile(join(backups, firstTry.at(-1), 'console.db'), 'utf8'), 'fixture database');

    setMigrateExit(0);
    await sleep(5);
    for (let index = 1; index <= 6; index++) await mkdir(join(backups, `2020-01-0${index}T00-00-00-000Z`));
    await mkdir(join(backups, '我的手动备份'));
    await addMigration('0003_more');
    await prepare();
    assert.equal(coordinator.phase, 'ready', coordinator.detail);
    const kept = await automatic();
    assert.equal(kept.length, 5, '自动备份保留最近 5 份');
    assert.ok(kept.includes(firstTry.at(-1)), '保留更早的迁移前副本，删最旧的');
    assert.ok((await readdir(backups)).includes('我的手动备份'), '不碰其他目录');
    assert.equal(await readFile(join(backups, kept.at(-1), 'pending.json'), 'utf8'), '["0002_next","0003_more"]');

    database.readable = false;
    await prepare();
    assert.equal(migrations.length, 11, '读不到迁移记录时按需迁移');
    assert.ok(coordinator.logs.some((entry) => /无法读取数据库迁移记录/.test(entry.text)));
  } finally { await coordinator.close(); }
});

test('missing bundled migrations stop preparation instead of trusting the database', async () => {
  const { coordinator, paths, migrations, database, prepare } = await preparedFixture();
  try {
    await mkdir(join(paths.db, '..'), { recursive: true });
    await writeFile(paths.db, 'fixture database');
    database.applied = new Set(['0001_init']);
    await rm(join(paths.schema, '..', 'migrations'), { recursive: true });
    await prepare();
    assert.equal(coordinator.phase, 'failed');
    assert.match(coordinator.detail, /迁移文件缺失/);
    assert.equal(migrations.length, 0);
  } finally { await coordinator.close(); }
});

test('an older browser list that resolves late never overrides a newer one', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'bcp-stale-list-'));
  const coordinator = new Coordinator({ paths: { userData, settings: join(userData, 'settings.json'), descriptor: join(userData, 'runtime.json') }, safeStorage: {} });
  await coordinator.load();
  coordinator.phase = 'ready';
  coordinator.supervisor = { endpoints: { backend: {} }, close: async () => {} };
  const lists = [];
  const selected = [];
  coordinator.api = (path, options) => {
    if (!path.endsWith('/connected')) { selected.push(JSON.parse(options.body).instanceId); return Promise.resolve({ ok: true }); }
    return new Promise((done) => lists.push(done));
  };
  try {
    const older = coordinator.refreshBrowsers();
    const newer = coordinator.refreshBrowsers();
    await until(() => lists.length === 2, 'both lists requested');
    lists[1]([{ kind: 'chrome', instanceId: 'a', ready: true }, { kind: 'chrome', instanceId: 'b', ready: true }]);
    await newer;
    lists[0]([{ kind: 'chrome', instanceId: 'a', ready: true }]);
    await older;
    assert.equal(coordinator.browsers.length, 2, '旧列表不能覆盖新列表');
    assert.deepEqual(selected, [], '不能依据过期的“唯一浏览器”自动确认');
  } finally { await coordinator.close(); }
});

test('reading applied migrations never creates or accepts a file that is not a database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bcp-applied-'));
  const missing = join(directory, 'console.db');
  assert.throws(() => appliedMigrations(missing));
  await assert.rejects(access(missing), { code: 'ENOENT' }, '只读打开不能创建数据库文件');
  const text = join(directory, 'notes.db');
  await writeFile(text, 'not a sqlite database');
  assert.throws(() => appliedMigrations(text));
  assert.equal(await readFile(text, 'utf8'), 'not a sqlite database');
});

test('backend and console start concurrently', async () => {
  const { coordinator, children } = await preparedFixture();
  try {
    const running = coordinator.prepare();
    await until(() => ['backend', 'console'].every((service) => children.some((child) => child.service === service)), 'both services forked');
    assert.equal(coordinator.snapshot().services.length, 0, '两个服务在任何一个就绪前都已启动');
    for (const child of children) child.ready();
    await running;
    assert.equal(coordinator.phase, 'ready');
  } finally { await coordinator.close(); }
});

test('a workbench restart keeps the browser paired, a browser service exit stops the group, and model changes restart only the gateway', async () => {
  const { coordinator, paths, children, live, count, prepare } = await preparedFixture();
  try {
    await prepare();
    coordinator.supervisor.restartDelay = 0;
    coordinator.pairedGeneration = coordinator.generation;
    live('console').emit('exit', 1);
    await until(() => count('console') === 2, 'console restarted');
    live('console').ready();
    await until(() => coordinator.supervisor.endpoints.console, 'console ready');
    assert.equal(coordinator.pairedGeneration, coordinator.generation);
    assert.equal(coordinator.phase, 'ready');

    const before = children.length;
    const saving = coordinator.saveModel({ mode: 'cloud', url: 'https://fixture.example/v1', model: 'fixture-model', key: 'upstream-secret-key' });
    await until(() => children.length === before + 1, 'gateway started');
    const gateway = live('llm');
    assert.equal(gateway.env.BCP_DESKTOP_UPSTREAM_KEY, 'upstream-secret-key');
    gateway.ready();
    await saving;
    assert.equal(coordinator.phase, 'ready');
    assert.equal(children.length, before + 1, '浏览器服务和工作台服务不重启');
    assert.ok(children.filter((child) => child.service !== 'llm').every((child) => !Object.hasOwn(child.env, 'BCP_DESKTOP_UPSTREAM_KEY')), '上游密钥只交给模型网关');
    assert.equal(JSON.parse(await readFile(join(paths.userData, 'llm', 'channels.json'), 'utf8')).channels[0].model, 'fixture-model');
    await coordinator.saveModel({ mode: 'skip' });
    assert.deepEqual(gateway.messages.at(-1), { type: 'shutdown' });
    assert.equal(children.length, before + 1, '停用模型后不再启动网关');
    assert.equal(coordinator.supervisor.endpoints.llm, undefined);
    assert.equal(coordinator.phase, 'ready');

    live('backend').emit('exit', 1);
    await until(() => coordinator.phase === 'failed', 'group failed');
    assert.match(coordinator.detail, /backend 已退出/);
    assert.equal(count('backend'), 1);
  } finally { await coordinator.close(); }
});

test('the only connected Chrome is confirmed automatically, and a saved browser is never replaced', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'bcp-auto-pair-'));
  const coordinator = new Coordinator({ paths: { userData, settings: join(userData, 'settings.json'), descriptor: join(userData, 'runtime.json') }, safeStorage: {} });
  await coordinator.load();
  coordinator.phase = 'ready';
  coordinator.supervisor = { endpoints: { backend: {} }, close: async () => {} };
  let browsers = [{ kind: 'chrome', instanceId: 'first', ready: true }, { kind: 'chrome', instanceId: 'second', ready: true }];
  let probe = async () => ({ ok: true });
  const selected = [];
  coordinator.api = async (path, options) => {
    if (path.endsWith('/connected')) return browsers;
    selected.push(JSON.parse(options.body).instanceId);
    return probe();
  };
  try {
    await coordinator.refreshBrowsers();
    assert.deepEqual(selected, [], '多个浏览器时由用户选择');
    browsers = [{ kind: 'chrome', instanceId: 'only', ready: true }];
    await Promise.all([coordinator.refreshBrowsers(), coordinator.refreshBrowsers()]);
    assert.deepEqual(selected, ['only'], '同时刷新只探测一次');
    assert.equal(coordinator.settings.browserId, 'only');
    assert.equal(coordinator.snapshot().browserReady, true);
    assert.equal(JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')).browserId, 'only');
    browsers = [{ kind: 'chrome', instanceId: 'other', ready: true }];
    await coordinator.refreshBrowsers();
    assert.deepEqual(selected, ['only'], '已保存的浏览器离线时不切换');
    assert.equal(coordinator.snapshot().browserReady, false);

    delete coordinator.settings.browserId;
    let release;
    probe = () => new Promise((done) => { release = () => done({ ok: false }); });
    browsers = [{ kind: 'chrome', instanceId: 'first-profile', ready: true }];
    const pending = coordinator.refreshBrowsers();
    await until(() => selected.length === 2, 'first probe started');
    browsers = [{ kind: 'chrome', instanceId: 'second-profile', ready: true }];
    const overlapping = coordinator.refreshBrowsers();
    probe = async () => ({ ok: true });
    release();
    await Promise.all([pending, overlapping]);
    await coordinator.refreshBrowsers();
    assert.deepEqual(selected.slice(1), ['first-profile', 'second-profile'], '前一个探测失败时，换上来的浏览器仍会被探测');
    assert.equal(coordinator.settings.browserId, 'second-profile');

    delete coordinator.settings.browserId;
    probe = async () => ({ ok: false });
    browsers = [{ kind: 'chrome', instanceId: 'refusing', ready: true }];
    await coordinator.refreshBrowsers();
    await coordinator.refreshBrowsers();
    assert.equal(selected.filter((id) => id === 'refusing').length, 1, '探测未通过时本轮不反复重试');
    assert.equal(coordinator.settings.browserId, undefined);
    assert.match(coordinator.logs.at(-1).text, /自动确认 Chrome 未完成/);
  } finally { await coordinator.close(); }
});

test('restarts older than one minute no longer count toward the limit', async (t) => {
  const { fork, live, count } = workers();
  const supervisor = supervised(fork);
  const failures = [];
  supervisor.on('failure', (message) => failures.push(message));
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    const starting = supervisor.start('console', '/console');
    live('console').ready();
    await starting;
    for (let exit = 1; exit <= 3; exit++) {
      live('console').emit('exit', 1);
      await until(() => count('console') === exit + 1, `restart ${exit}`);
      live('console').ready();
      await until(() => supervisor.endpoints.console, `ready ${exit}`);
    }
    t.mock.timers.tick(60_001);
    live('console').emit('exit', 1);
    await until(() => count('console') === 5, 'restart after the window');
    assert.deepEqual(failures, [], '1 分钟前的重启不再计入');
  } finally { t.mock.timers.reset(); await supervisor.close(); }
});

test('after services restart under a new generation the saved browser is selected again once it reconnects', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'bcp-repair-'));
  const coordinator = new Coordinator({ paths: { userData, settings: join(userData, 'settings.json'), descriptor: join(userData, 'runtime.json') }, safeStorage: {} });
  await coordinator.load();
  coordinator.settings.browserId = 'saved';
  coordinator.phase = 'ready';
  coordinator.supervisor = { endpoints: { backend: {} }, close: async () => {} };
  let browsers = [];
  const selected = [];
  coordinator.api = async (path, options) => {
    if (path.endsWith('/connected')) return browsers;
    selected.push(JSON.parse(options.body).instanceId);
    return { ok: true };
  };
  try {
    await coordinator.refreshBrowsers();
    assert.equal(coordinator.snapshot().browserReady, false, '原浏览器未重连前不显示已连接');
    browsers = [{ kind: 'chrome', instanceId: 'saved', ready: true }];
    await coordinator.refreshBrowsers();
    assert.deepEqual(selected, ['saved']);
    assert.equal(coordinator.snapshot().browserReady, true);
    await coordinator.refreshBrowsers();
    assert.deepEqual(selected, ['saved'], '同一轮服务只确认一次');
  } finally { await coordinator.close(); }
});

test('a model change holds busy from its first moment and a failure during registration keeps its root cause', async () => {
  const { coordinator, children, live, prepare } = await preparedFixture();
  try {
    await prepare();
    const before = children.length;
    const saving = coordinator.saveModel({ mode: 'skip' });
    assert.equal(coordinator.busy, true, '保存模型设置期间不能开始新的准备');
    await coordinator.prepare();
    await saving;
    assert.equal(children.length, before, '准备没有在模型切换中途插入');
    assert.equal(coordinator.busy, false);

    let release;
    coordinator.api = () => new Promise((done) => { release = done; });
    const started = children.length;
    const running = coordinator.prepare();
    await until(() => children.length >= started + 2, 'services forked');
    for (const child of children.slice(started)) child.ready();
    await until(() => release, 'registering');
    live('backend').emit('exit', 1);
    await until(() => coordinator.phase === 'failed', 'failure reported');
    release({});
    coordinator.api = async () => ({});
    await running;
    assert.equal(coordinator.phase, 'failed', '服务已失败时不能再标记为就绪');
    assert.match(coordinator.detail, /backend 已退出/, '保留真正的根因');
    await until(() => !coordinator.busy, 'busy released after the group closed');
  } finally { await coordinator.close(); }
});

test('a clock that went back cannot trick retries into replacing the pre-migration backup', async (t) => {
  const { coordinator, paths, migrations, database, addMigration, prepare, setMigrateExit } = await preparedFixture();
  const backups = join(paths.userData, 'backups');
  try {
    await mkdir(join(paths.db, '..'), { recursive: true });
    await writeFile(paths.db, 'pre-migration');
    database.applied = new Set(['0001_init']);
    for (let index = 1; index <= 4; index++) await mkdir(join(backups, `2099-01-0${index}T00-00-00-000Z`), { recursive: true });
    await addMigration('0002_next');
    setMigrateExit(1);
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00.000Z') });
    await prepare();
    await writeFile(paths.db, 'half migrated');
    t.mock.timers.setTime(Date.parse('2026-01-01T00:01:00.000Z'));
    await prepare();
    assert.equal(migrations.length, 2);
    const kept = (await readdir(backups)).sort();
    assert.deepEqual(kept, ['2026-01-01T00-00-00-000Z', '2099-01-01T00-00-00-000Z', '2099-01-02T00-00-00-000Z', '2099-01-03T00-00-00-000Z', '2099-01-04T00-00-00-000Z']);
    assert.equal(await readFile(join(backups, '2026-01-01T00-00-00-000Z', 'console.db'), 'utf8'), 'pre-migration');
  } finally { t.mock.timers.reset(); await coordinator.close(); }
});

test('page and backend eval are on by default, reach the backend through one channel, and a switch flipped mid-start still applies', async () => {
  const { coordinator, paths, children, live, policies, prepare } = await preparedFixture();
  try {
    await coordinator.savePolicy({ allowEval: false, allowLocalEval: false, screenshotDir: join(paths.userData, 'shots') });
    assert.deepEqual(policies, [], '服务未就绪时只保存设置');
    assert.equal(JSON.parse(await readFile(paths.settings, 'utf8')).allowEval, false);
    await prepare();
    assert.deepEqual(policies.at(-1), { eval: false, localEval: false, screenshotDir: join(paths.userData, 'shots') }, '服务起来后推送一次当前策略');
    assert.ok(children.every((child) => !Object.hasOwn(child.env, 'BCP_EVAL') && !Object.hasOwn(child.env, 'BCP_LOCAL_EVAL')), '策略只走推送这一个通道，不再写进环境变量');
    assert.ok(live('backend').env.BCP_POLICY_TOKEN && live('backend').env.BCP_POLICY_TOKEN === coordinator.policyToken, '后端拿到客户端独有的策略令牌');
    assert.equal(coordinator.snapshot().allowEval, false);
    await coordinator.savePolicy({ allowEval: true });
    assert.deepEqual(policies.at(-1), { eval: true, localEval: false, screenshotDir: join(paths.userData, 'shots') }, '运行中切换立即推送，不重启');

    delete coordinator.settings.allowEval;
    delete coordinator.settings.allowLocalEval;
    delete coordinator.settings.screenshotDir;
    const started = children.length;
    const running = coordinator.prepare();
    await until(() => children.slice(started).some((child) => child.service === 'backend'), 'backend forked');
    await coordinator.savePolicy({ allowLocalEval: false });
    for (const child of children.slice(started)) child.ready();
    await until(() => ['console'].every((service) => children.slice(started).some((child) => child.service === service)), 'console forked');
    for (const child of children.slice(started)) child.ready();
    await running;
    assert.deepEqual(policies.at(-1), { eval: true, localEval: false, screenshotDir: null }, '准备途中关闭的开关在服务起来后生效；从未设置的默认开启');
    await assert.rejects(coordinator.savePolicy({ allowEval: 'yes' }), /开关无效/);
    await assert.rejects(coordinator.savePolicy({ allowLocalEval: 1 }), /本机脚本开关无效/);
  } finally { await coordinator.close(); }
});

test('a local model is used only once Ollama runs with it, starts the gateway with no key, and downloads only on request', async () => {
  const { coordinator, paths, children, live, prepare } = await preparedFixture();
  const ollama = { running: true, hasModel: false, pulls: [] };
  coordinator.ollama = {
    detect: async () => ({ baseUrl: 'http://127.0.0.1:11434', executable: 'ollama', installed: true, running: ollama.running, version: '0.12.0', hasModel: ollama.hasModel }),
    start: () => { ollama.starts = (ollama.starts || 0) + 1; ollama.running = true; },
    pull: ({ onProgress, signal }) => new Promise((done, fail) => {
      ollama.pulls.push({ onProgress, done: () => { ollama.hasModel = true; done(); } });
      signal.addEventListener('abort', () => fail(new Error('aborted')));
    }),
  };
  try {
    await prepare();
    ollama.running = false;
    await Promise.all([coordinator.startLocalModel(), coordinator.startLocalModel()]);
    assert.equal(ollama.starts, 1, '连点只启动一个 Ollama');
    await assert.rejects(coordinator.saveModel({ mode: 'local' }), /下载 qwen3\.5:4b/);
    assert.equal(coordinator.settings.modelMode, 'skip', '没准备好时不切换');
    assert.equal(ollama.pulls.length, 0, '检测不会触发下载');

    await Promise.all([coordinator.pullLocalModel(), coordinator.pullLocalModel()]);
    assert.equal(ollama.pulls.length, 1, '连点只下载一次');
    ollama.pulls[0].onProgress({ completed: 512, total: 2048 });
    assert.deepEqual(coordinator.snapshot().localModel.pull, { status: 'running', completed: 512, total: 2048, error: '' });
    await coordinator.pullLocalModel();
    assert.equal(ollama.pulls.length, 1, '下载中再点不会重复下载');
    coordinator.cancelLocalPull();
    await coordinator.pullTask;
    assert.equal(coordinator.snapshot().localModel.pull, null, '取消不算失败');

    await coordinator.pullLocalModel();
    const seen = [];
    const watch = () => seen.push(coordinator.snapshot().localModel);
    coordinator.on('change', watch);
    ollama.pulls[1].done();
    await coordinator.pullTask;
    coordinator.off('change', watch);
    assert.ok(seen.every((local) => local.pull?.status === 'running' || local.hasModel), '下载完成时不会先闪回「未下载」');
    assert.equal(coordinator.snapshot().localModel.hasModel, true);

    const before = children.length;
    const saving = coordinator.saveModel({ mode: 'local' });
    await until(() => children.length === before + 1, 'gateway started');
    const gateway = live('llm');
    assert.equal(Object.hasOwn(gateway.env, 'BCP_DESKTOP_UPSTREAM_KEY'), false, '本机模型没有上游密钥');
    gateway.ready();
    await saving;
    assert.deepEqual(JSON.parse(await readFile(join(paths.userData, 'llm', 'channels.json'), 'utf8')).channels, [
      { id: 'qwen3.5:4b', adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b', options: { numCtx: 8192 } },
    ]);
    assert.equal(coordinator.snapshot().modelMode, 'local');
    assert.equal(coordinator.snapshot().localModel.configured, true);
  } finally { await coordinator.close(); }
});
