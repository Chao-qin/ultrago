import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, writeFile, rename, access, cp, copyFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createIngress } from './ingress.mjs';
import { Supervisor } from './supervisor.mjs';
import { cleanEnvironment, selectedBrowser } from './runtime-state.mjs';
import { stripVTControlCharacters } from 'node:util';
import { constants } from 'node:fs';
import { DESKTOP_BOOK_NAMES, desktopBookSchemas } from '@bcp/backend/dist/desktop-books.js';
import { registerNativeHost } from './native-registration.mjs';
import { createAgentConnections } from './agent-connections.mjs';
import { LOCAL_MODEL, detectOllama, pullModel, startOllama } from './local-model.mjs';

const BACKUP_KEEP = 5;
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export async function bundledMigrations(schema) {
  try { return (await readdir(join(dirname(schema), 'migrations'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
  catch (error) {
    // Without the bundled migrations nothing can prove the database is current; never skip on that basis.
    if (error.code === 'ENOENT') throw new Error('随包数据库迁移文件缺失，请重新安装客户端。');
    throw error;
  }
}

/** Migrations the database itself records as finished, read without writing; throws when they cannot be read. */
export function appliedMigrations(db) {
  const database = new DatabaseSync(db, { readOnly: true });
  try { return new Set(database.prepare('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL').all().map((row) => row.migration_name)); }
  finally { database.close(); }
}

export async function upgradeBundledDemo(source, destination) {
  const bundled = JSON.parse(await readFile(source, 'utf8'));
  const previous = structuredClone(bundled);
  delete previous.schemaVersion;
  delete previous.pages;
  for (const step of previous.steps) { step.page = 'desktop-demo'; delete step.gate; }
  previous.steps[0].verify = { settled: true, noErrors: true };
  let installed;
  try { installed = JSON.parse(await readFile(destination, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) return false; throw error; }
  if (JSON.stringify(installed) === JSON.stringify(previous)) await copyFile(source, destination);
  return true;
}

export class Coordinator extends EventEmitter {
  constructor({ paths, fork, forkJob, safeStorage, registerBridge = () => registerNativeHost(paths), readMigrations = appliedMigrations, openConnections, ollama = { detect: detectOllama, start: startOllama, pull: pullModel } }) {
    super();
    Object.assign(this, { paths, fork, forkJob, safeStorage, registerBridge, readMigrations, openConnections, ollama });
    this.localModel = { checked: false, installed: false, running: false, hasModel: false, version: '', pull: null };
    this.agentConnections = createAgentConnections();
    this.connectionsSince = Date.now();
    this.generation = randomUUID();
    this.token = randomBytes(32).toString('hex');
    this.nativeToken = randomBytes(32).toString('hex');
    this.browserToken = randomBytes(32).toString('hex');
    this.policyToken = randomBytes(32).toString('hex');
    this.settings = { modelMode: 'skip', setupCompleted: false };
    this.settingsWrite = Promise.resolve();
    this.phase = 'waiting';
    this.preparationStep = 0;
    this.detail = '点击准备工作台，开始检查本地环境。';
    this.browsers = [];
    this.busy = false;
    // busy belongs to the latest operation; failures counts service failures so a running prepare can see one.
    this.operation = 0;
    this.failures = 0;
    this.demo = null;
    this.logs = [];
    this.phaseStartedAt = Date.now();
    this.logWrite = Promise.resolve();
  }

  async load() {
    await mkdir(this.paths.userData, { recursive: true, mode: 0o700 });
    const logDirectory = join(this.paths.userData, 'logs');
    await mkdir(logDirectory, { recursive: true });
    this.logFile = join(logDirectory, 'desktop.log');
    try { await rename(this.logFile, join(logDirectory, 'desktop.previous.log')); }
    catch (error) { if (error.code !== 'ENOENT') this.logError = `上次日志保留失败：${error.message}`; }
    this.recordLog({ service: 'desktop', text: '客户端已打开，等待准备工作台。' });
    try {
      const saved = JSON.parse(await readFile(this.paths.settings, 'utf8'));
      this.settings = { ...this.settings, ...saved };
      if (saved.setupCompleted === undefined && saved.browserId) this.settings.setupCompleted = true;
    }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('用户配置无法读取，请检查数据目录。'); }
    // Lets an already-loaded unpacked extension notice that this client shipped a different build.
    if (this.paths.extension) {
      try { this.extensionVersion = JSON.parse(await readFile(join(this.paths.extension, 'manifest.json'), 'utf8')).version; }
      catch (error) { this.recordLog({ service: 'desktop', text: `随包扩展版本读取失败，升级后需在 chrome://extensions 手动重新加载：${error.message}` }); }
    }
    await this.openIngress();
  }

  async openIngress() {
    this.ingress = await createIngress({
      token: this.token, nativeToken: this.nativeToken,
      resolve: (service) => {
        const table = this.supervisor?.endpoints || {};
        if (service === 'backend') return table.backend?.internal;
        if (service === 'mcp') return table.backend?.mcp;
        return table[service]?.[service];
      },
      discover: () => this.supervisor?.endpoints.backend
        ? { version: 1, generation: this.generation, backendUrl: this.supervisor.endpoints.backend.ws, token: this.browserToken, extensionVersion: this.extensionVersion }
        : { version: 1, error: '本地服务尚未准备，请在客户端开始准备。' },
      target: () => this.pairedGeneration === this.generation ? selectedBrowser(this.browsers, this.settings.browserId) : null,
      status: () => this.connectionStatus(),
      agentEvent: (event) => {
        this.agentConnections.update(event);
        if (event.state === 'connected' && event.name !== 'ultrago-connection-check') this.lastMcpSuccess = Date.now();
        this.emit('change');
      },
      openConnections: this.openConnections,
      sample: await readFile(new URL('../ui/sample.html', import.meta.url), 'utf8'),
    });
    await this.atomic(this.paths.descriptor, { version: 1, origin: this.ingress.origin, token: this.nativeToken, generation: this.generation });
  }

  async atomic(file, value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  }

  saveSettings() {
    const snapshot = structuredClone(this.settings);
    const write = () => this.atomic(this.paths.settings, snapshot);
    this.settingsWrite = this.settingsWrite.then(write, write);
    return this.settingsWrite;
  }

  snapshot() {
    const endpoints = this.supervisor?.endpoints || {};
    return {
      phase: this.phase, detail: this.detail, busy: this.busy, generation: this.generation,
      setupCompleted: !!this.settings.setupCompleted,
      connections: this.connectionStatus(),
      preparationStep: this.preparationStep,
      services: Object.keys(endpoints), browsers: this.browsers,
      browserId: this.settings.browserId || '',
      browserReady: this.pairedGeneration === this.generation && !!selectedBrowser(this.browsers, this.settings.browserId),
      modelMode: this.settings.modelMode, modelConfigured: !!this.settings.cloud, localModel: { ...this.localModel, model: LOCAL_MODEL, configured: !!this.settings.local },
      allowEval: this.settings.allowEval !== false, allowLocalEval: this.settings.allowLocalEval !== false, screenshotDir: this.settings.screenshotDir || '',
      model: this.settings.cloud?.model || '', dataDirectory: this.paths.userData,
      modelUrl: this.settings.cloud?.url || '',
      bridgeReady: this.bridgeReady || false, bridgeBusy: this.bridgeBusy || false,
      bridgeError: this.bridgeError || '', demo: this.demo,
      logs: this.logs,
      phaseStartedAt: this.phaseStartedAt, logFile: this.logFile || '', logError: this.logError || '',
    };
  }

  connectionStatus() {
    const assistants = this.agentConnections.snapshot();
    // Connection status covers this run only, like the assistant list reset with it: the launch-error file keeps a
    // failure from an earlier run or an older version forever, and showing it would report an assistant the user
    // has not even started as failing.
    const lastConnected = Math.max(this.connectionsSince, this.lastMcpSuccess || 0, ...assistants.filter((entry) => entry.state === 'connected').map((entry) => entry.lastSeen));
    const currentFailure = assistants.find((entry) => entry.error && entry.state !== 'connected' && !assistants.some((live) => live.state === 'connected' && (live.name === entry.name || entry.name === 'AI 助手') && live.lastSeen >= entry.lastSeen));
    return {
      serviceReady: this.phase === 'ready',
      browserReady: this.phase === 'ready' && this.pairedGeneration === this.generation && !!selectedBrowser(this.browsers, this.settings.browserId),
      browserId: this.settings.browserId || '', modelMode: this.settings.modelMode,
      mcpReady: this.phase === 'ready' && !!this.supervisor?.endpoints.backend?.mcp,
      assistants, lastError: this.mcpLaunchError?.time > lastConnected ? this.mcpLaunchError.message : currentFailure?.error || '',
    };
  }

  update(phase, detail) {
    if (this.phase !== phase) this.phaseStartedAt = Date.now();
    this.phase = phase; this.detail = detail;
    const steps = { waiting: 0, checking: 0, initializing: 1, starting: 2, registering: 3, ready: 4 };
    if (Object.hasOwn(steps, phase)) this.preparationStep = steps[phase];
    this.recordLog({ service: 'desktop', text: detail });
  }

  diagnosticsText() {
    return [`状态：${this.phase}`, this.detail, `连接：${JSON.stringify(this.connectionStatus())}`, ...this.logs.map((entry) => `${entry.time} [${entry.service}] ${entry.text}`)].join('\n');
  }

  recordLog(entry) {
    this.logs.push({ ...entry, text: stripVTControlCharacters(String(entry.text)).slice(-8192), time: new Date().toISOString() });
    this.logs = this.logs.slice(-60);
    if (this.logFile) this.logWrite = this.logWrite.then(() => writeFile(this.logFile, this.diagnosticsText(), { mode: 0o600 })).catch((error) => {
      this.logError = `日志文件写入失败：${error.message}`;
      this.emit('change');
    });
    this.emit('change');
  }

  async api(path, options = {}) {
    const response = await fetch(`${this.ingress.origin}${path}`, {
      ...options, headers: { ...options.headers, Authorization: `Bearer ${this.token}`, 'X-BCP-Internal-Token': this.token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      let reason = '';
      try {
        const body = await response.json();
        reason = [body.message, body.error].flat().filter((value) => typeof value === 'string').join('；');
      } catch { reason = response.statusText; }
      for (const secret of [this.token, this.nativeToken, this.browserToken]) reason = reason.replaceAll(secret, '[hidden]');
      throw new Error(`本地请求失败（${response.status}，${path.split('?')[0]}）${reason ? `：${stripVTControlCharacters(reason).slice(0, 1000)}` : ''}`);
    }
    return response.json();
  }

  async prepareBridge() {
    if (this.bridgeBusy) return;
    this.bridgeReady = false;
    this.bridgeError = '';
    this.bridgeBusy = true;
    this.emit('change');
    try {
      await this.registerBridge();
      this.bridgeReady = true;
      this.recordLog({ service: 'desktop', text: '浏览器连接组件已自动注册。' });
    } catch (error) {
      this.bridgeError = `浏览器连接组件注册失败：${error.message}`;
      this.recordLog({ service: 'desktop', text: this.bridgeError });
    } finally {
      this.bridgeBusy = false;
      this.emit('change');
    }
  }

  async prepare() {
    if (this.busy) return;
    const operation = ++this.operation;
    const failures = this.failures;
    this.busy = true;
    this.demo = null;
    this.browsers = [];
    this.emit('change');
    try {
      if (this.supervisor) await this.supervisor.close();
      await this.ingress.close();
      this.generation = randomUUID();
      this.token = randomBytes(32).toString('hex');
      this.nativeToken = randomBytes(32).toString('hex');
      this.browserToken = randomBytes(32).toString('hex');
      this.policyToken = randomBytes(32).toString('hex');
      this.agentConnections = createAgentConnections();
      this.connectionsSince = Date.now();
      await this.openIngress();
      this.update('checking', '正在检查随包运行资源和用户数据目录…');
      for (const file of [this.paths.entries.backend, this.paths.entries.console, this.paths.schema, join(this.paths.web, 'index.html'), join(this.paths.extension, 'manifest.json')]) await access(file);
      for (const dir of ['resource/db', 'resource/playbooks', 'resource/uploads', 'resource/records', 'reports', 'browser', 'llm']) await mkdir(join(this.paths.userData, dir), { recursive: true });
      await this.prepareBridge();
      const llmDir = join(this.paths.userData, 'llm');
      const model = await this.writeChannels();
      if (this.settings.modelMode === 'local' && !(await this.detectLocalModel()).running) {
        this.recordLog({ service: 'desktop', text: '本机 Ollama 没有运行，验证码提醒暂不可用；打开 Ollama 后自动恢复，不用重新准备。' });
      }
      const origin = this.ingress.origin;
      const supervisor = this.supervisor = new Supervisor({
        fork: this.fork, forkJob: this.forkJob, worker: fileURLToPath(new URL('./worker.mjs', import.meta.url)),
        cwd: this.paths.userData, generation: this.generation,
        env: {
          ...cleanEnvironment(process.env), BCP_DESKTOP: '1',
          BCP_DESKTOP_GENERATION: this.generation, BCP_DESKTOP_TOKEN: this.token,
          BCP_DESKTOP_ORIGIN: origin, BCP_INTERNAL_TOKEN: this.token, BCP_TOKEN: this.browserToken,
          BCP_PORT: '0', BCP_MCP_PORT: '0', BCP_INTERNAL_PORT: '0', CONSOLE_PORT: '0', BCP_LLM_PORT: '0',
          BCP_HOST: '127.0.0.1', CONSOLE_HOST: '127.0.0.1', BCP_LLM_HOST: '127.0.0.1',
          BCP_WECLAW_DISABLE: '1', BCP_DATA_ROOT: this.paths.userData,
          BCP_DESKTOP_BOOKS_DIR: this.paths.library,
          BCP_PYTHON_EXECUTABLE: this.paths.python,
          BCP_BROWSER_ROOT: join(this.paths.userData, 'browser'), BCP_EXTENSION_DIR: this.paths.extension,
          DATABASE_URL: `file:${this.paths.db}`, BCP_CONSOLE_WEB_DIR: this.paths.web,
          ...(process.platform === 'win32' ? {
            PRISMA_QUERY_ENGINE_LIBRARY: join(this.paths.engines, 'query_engine-windows.dll.node'),
            PRISMA_SCHEMA_ENGINE_BINARY: join(this.paths.engines, 'schema-engine-windows.exe'),
          } : {}),
          BCP_PLAYBOOKS_DIR: join(this.paths.userData, 'resource/playbooks'),
          BCP_CONSOLE_URL: origin, BCP_INTERNAL_URL: `${origin}/__bcp/backend`,
          BCP_LLM_URL: `${origin}/__bcp/llm`, BCP_LLM_BASE_URL: `${origin}/__bcp/llm`,
          BCP_EVENT_WEBHOOK: `${origin}/internal/browser-events/hook`,
          BCP_LLM_TELEMETRY_URL: `${origin}/internal/llm-calls/hook`,
          BCP_LLM_CHANNELS_PATH: join(llmDir, 'channels.json'), BCP_LLM_KEYS_PATH: join(llmDir, 'keys.json'),
          // Browser-tool policy reaches the backend through ONE channel, pushPolicy(), right after the services
          // start and on every change; an env copy taken here would go stale for a switch flipped mid-start.
          BCP_POLICY_TOKEN: this.policyToken,
        },
      });
      supervisor.on('failure', (message) => {
        const closing = ++this.operation;
        this.failures++;
        this.browsers = []; this.busy = true; this.update('failed', message);
        void supervisor.close().finally(() => { if (this.operation === closing) this.busy = false; this.emit('change'); });
      });
      this.supervisor.on('change', () => this.emit('change'));
      this.supervisor.on('log', (entry) => this.recordLog(entry));
      this.update('initializing', '正在准备工作台数据库，已有记录会保留…');
      // The database's own migration table decides; anything unreadable falls back to running migrate deploy.
      let pending = await bundledMigrations(this.paths.schema);
      let databaseExists = true;
      try { await access(this.paths.db); }
      catch (error) { if (error.code !== 'ENOENT') throw error; databaseExists = false; }
      if (databaseExists) {
        try { const applied = this.readMigrations(this.paths.db); pending = pending.filter((name) => !applied.has(name)); }
        catch (error) { this.recordLog({ service: 'desktop', text: `无法读取数据库迁移记录，将执行初始化：${error.message}` }); }
      }
      if (databaseExists && !pending.length) {
        this.recordLog({ service: 'desktop', text: '数据库已是最新结构，跳过初始化。' });
      } else {
        if (databaseExists) await this.backupDatabase(pending);
        await this.supervisor.start('migrate', this.paths.entries.migrate, { BCP_DESKTOP_JOB: 'migrate', BCP_DESKTOP_SCHEMA: this.paths.schema }, true);
      }
      await cp(this.paths.templates, join(this.paths.userData, 'resource/playbooks'), { recursive: true, force: false, errorOnExist: false });
      const validDemo = await upgradeBundledDemo(join(this.paths.templates, 'desktop-readonly-demo.json'), join(this.paths.userData, 'resource/playbooks/desktop-readonly-demo.json'));
      if (!validDemo) this.recordLog({ service: 'desktop', text: '用户目录中的示例模板不是有效 JSON，已保留原文件并跳过升级；首次只读体验仍使用随包模板。' });
      for (const name of DESKTOP_BOOK_NAMES) {
        const destination = join(this.paths.userData, 'resource/playbooks', `${name}.json`);
        try { await copyFile(join(this.paths.library, `${name}.json`), destination, constants.COPYFILE_EXCL); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      this.update('starting', '正在启动浏览器连接与工作台服务…');
      // Services reach each other through the ingress only on demand, so none waits for another to start.
      await Promise.all([
        this.supervisor.start('backend', this.paths.entries.backend),
        this.supervisor.start('console', this.paths.entries.console),
        ...(model ? [this.supervisor.start('llm', this.paths.entries.llm, model.key ? { BCP_DESKTOP_UPSTREAM_KEY: model.key } : {})] : []),
      ]);
      // A switch flipped while the services were starting was saved after their env was fixed; apply it now.
      await this.pushPolicy();
      this.update('registering', '服务已启动，正在检查内置示例模板…');
      for (const schema of await desktopBookSchemas(this.paths.library, this.paths.rawOfferSchema)) await this.api('/api/schemas', { method: 'POST', body: JSON.stringify(schema) });
      await this.api('/api/schemas', { method: 'POST', body: JSON.stringify({ name: 'desktop-readonly-demo-output', kind: 'book_output', version: 1, jsonSchema: { type: 'object' }, source: 'desktop-bundled' }) });
      await this.api('/api/books/rescan', { method: 'POST', body: '{}' });
      // A service that failed meanwhile has already reported the root cause and stopped the group.
      if (this.failures === failures) this.update('ready', '工作台已启动，请安装扩展并确认要使用的浏览器。');
    } catch (error) {
      if (this.supervisor) await this.supervisor.close();
      this.browsers = [];
      if (this.failures === failures) this.update('failed', error instanceof Error ? error.message : String(error));
    } finally {
      if (this.operation === operation) this.busy = false;
      this.emit('change');
    }
  }

  /**
   * One backup per set of pending migrations: retrying a failed migration keeps the copy taken before the
   * first attempt instead of piling up copies of a half-migrated database that push it out of retention.
   */
  async backupDatabase(pending) {
    const root = join(this.paths.userData, 'backups');
    const marker = JSON.stringify(pending);
    let others = [];
    try { others = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && BACKUP_NAME.test(entry.name)).map((entry) => entry.name).sort(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Every backup is checked, not just the newest name: names come from the wall clock, which can go back.
    for (const name of others) {
      try {
        if (await readFile(join(root, name, 'pending.json'), 'utf8') === marker) {
          this.recordLog({ service: 'desktop', text: `本次迁移前的数据库已备份在 backups/${name}，不重复备份。` });
          return;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const name = new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir(root, { recursive: true });
    await mkdir(join(root, name));
    for (const suffix of ['', '-wal', '-shm']) {
      try { await copyFile(this.paths.db + suffix, join(root, name, `console.db${suffix}`)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await writeFile(join(root, name, 'pending.json'), marker);
    for (const old of others.filter((entry) => entry !== name).slice(0, Math.max(0, others.length - (BACKUP_KEEP - 1)))) await rm(join(root, old), { recursive: true, force: true });
  }

  /** Writes the gateway channel list; returns the model in use (with the decrypted key for a cloud API), or null. */
  async writeChannels() {
    const file = join(this.paths.userData, 'llm', 'channels.json');
    if (this.settings.modelMode === 'local') {
      const local = this.settings.local;
      if (!local) throw new Error('请先完成本机模型准备，或选择暂不设置。');
      // numCtx: without it Ollama silently cuts the input at 2048 tokens; 8192 fits a screenshot and stays light on memory.
      await this.atomic(file, { channels: [{ id: local.model, adapter: 'ollama', baseUrl: local.url, model: local.model, options: { numCtx: 8192 } }] });
      return { model: local.model, key: '' };
    }
    const cloud = this.settings.modelMode === 'cloud' ? this.settings.cloud : null;
    if (this.settings.modelMode === 'cloud' && !cloud) throw new Error('请填写云 API 配置，或选择稍后设置。');
    const key = cloud ? this.safeStorage.decryptString(Buffer.from(cloud.encryptedKey, 'base64')) : '';
    await this.atomic(file, { channels: cloud ? [{ id: cloud.model, adapter: 'openai', baseUrl: cloud.url, model: cloud.model, apiKey: 'env.BCP_DESKTOP_UPSTREAM_KEY' }] : [] });
    return cloud ? { model: cloud.model, key } : null;
  }

  /** Checks Ollama and the model again; the setup page calls this while the model step is open. */
  async detectLocalModel() {
    const found = await this.ollama.detect();
    this.localModel = { ...found, checked: true, pull: this.localModel.pull };
    this.emit('change');
    return this.localModel;
  }

  /** A second click while Ollama is starting waits for the first instead of launching another server. */
  startLocalModel() {
    this.startingOllama ??= this.launchOllama().finally(() => { this.startingOllama = undefined; });
    return this.startingOllama;
  }

  async launchOllama() {
    const found = await this.detectLocalModel();
    if (found.running) return;
    if (!found.executable) throw new Error('没有找到 Ollama，请先下载安装。');
    this.ollama.start(found.executable);
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((done) => setTimeout(done, 500));
      if ((await this.detectLocalModel()).running) {
        this.recordLog({ service: 'desktop', text: '已启动本机 Ollama。' });
        return;
      }
    }
    throw new Error('Ollama 没有在 10 秒内启动，请从开始菜单打开 Ollama 后重新检测。');
  }

  /**
   * Starts downloading the model through Ollama and returns once it is under way; progress goes into the snapshot
   * and `pullTask` settles when the download ends. Only the user's click starts it.
   */
  async pullLocalModel() {
    // Taken before the first await, so a double click cannot start two downloads.
    if (this.pullStarting || this.localModel.pull?.status === 'running') return;
    this.pullStarting = true;
    try {
      const found = await this.detectLocalModel();
      if (!found.running) throw new Error('Ollama 没有运行，请先启动 Ollama。');
      if (found.hasModel) return;
      this.pullTask = this.runPull(found.baseUrl);
    } finally { this.pullStarting = false; }
  }

  async runPull(baseUrl) {
    const controller = this.pullController = new AbortController();
    this.localModel.pull = { status: 'running', completed: 0, total: 0, error: '' };
    this.emit('change');
    try {
      await this.ollama.pull({ baseUrl, model: LOCAL_MODEL, signal: controller.signal, onProgress: ({ completed, total }) => {
        this.localModel.pull = { status: 'running', completed, total, error: '' };
        this.emit('change');
      } });
      // Re-checked before the progress is cleared, so the page never flashes the download button back.
      await this.detectLocalModel();
      this.localModel.pull = null;
      this.recordLog({ service: 'desktop', text: `本机模型 ${LOCAL_MODEL} 已下载。` });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      this.localModel.pull = cancelled ? null : { ...this.localModel.pull, status: 'failed', error: error.message };
      if (!cancelled) this.recordLog({ service: 'desktop', text: `本机模型下载失败：${error.message}` });
    } finally {
      if (this.pullController === controller) this.pullController = undefined;
      this.emit('change');
    }
  }

  cancelLocalPull() { this.pullController?.abort(); }

  async refreshBrowsers() {
    try {
      const error = await readFile(join(this.paths.userData, 'logs/mcp-last-error.log'), 'utf8');
      const time = Date.parse(error.slice(0, 24));
      this.mcpLaunchError = { time: Number.isFinite(time) ? time : 0, message: error.slice(25, 2025).trim() };
    } catch (error) { if (error.code !== 'ENOENT') this.mcpLaunchError = { time: Date.now(), message: `MCP 诊断日志读取失败：${error.message}` }; }
    if (this.phase !== 'ready' || !this.supervisor?.endpoints.backend) return this.snapshot();
    // Polls overlap; only the newest list may update state or start an automatic confirmation.
    const refresh = this.refreshes = (this.refreshes || 0) + 1;
    try {
      const browsers = await this.api('/__bcp/backend/internal/browsers/connected');
      if (refresh !== this.refreshes) return this.snapshot();
      this.browsers = browsers;
      if (this.pairedGeneration !== this.generation && selectedBrowser(this.browsers, this.settings.browserId)) {
        const probe = await this.api('/__bcp/backend/internal/browsers/select', { method: 'POST', body: JSON.stringify({ instanceId: this.settings.browserId }) });
        if (probe.ok) this.pairedGeneration = this.generation;
      }
      // First use with exactly one connected Chrome needs no choice. A saved browser that is offline is never replaced.
      const ready = this.browsers.filter((browser) => browser.kind === 'chrome' && browser.ready);
      const attempt = ready.length === 1 ? `${this.generation}:${ready[0].instanceId}` : '';
      // Each browser is probed once per generation; a refresh that overlaps an in-flight probe only waits for it.
      if (!this.settings.browserId && attempt && !this.autoPairing && this.autoPairAttempt !== attempt) {
        this.autoPairAttempt = attempt;
        this.autoPairing = this.pairBrowser(ready[0].instanceId)
          .then(() => this.recordLog({ service: 'desktop', text: '已自动确认唯一连接的 Chrome。' }))
          .catch((error) => this.recordLog({ service: 'desktop', text: `自动确认 Chrome 未完成，可手动确认：${error.message}` }))
          .finally(() => { this.autoPairing = undefined; });
      }
      await this.autoPairing;
    } catch { if (refresh === this.refreshes) this.browsers = []; }
    this.emit('change');
    return this.snapshot();
  }

  async chooseBrowser(instanceId) {
    await this.refreshBrowsers();
    if (!selectedBrowser(this.browsers, instanceId)) throw new Error('该浏览器已离线，请重新检测。');
    await this.pairBrowser(instanceId);
  }

  async pairBrowser(instanceId) {
    const probe = await this.api('/__bcp/backend/internal/browsers/select', { method: 'POST', body: JSON.stringify({ instanceId }) });
    if (!probe.ok) throw new Error('浏览器探测未通过，请检查扩展连接。');
    this.pairedGeneration = this.generation;
    this.settings.browserId = instanceId;
    await this.saveSettings();
    this.emit('change');
  }

  async saveModel(input) {
    if (this.busy) throw new Error('工作台准备中，请稍后修改模型配置。');
    if (input?.mode === 'skip') { this.settings.modelMode = 'skip'; }
    else if (input?.mode === 'local') {
      const found = await this.detectLocalModel();
      if (!found.running || !found.hasModel) throw new Error(`请先启动 Ollama 并下载 ${LOCAL_MODEL}。`);
      this.settings.modelMode = 'local';
      this.settings.local = { url: found.baseUrl, model: LOCAL_MODEL };
    }
    else {
      const url = new URL(input?.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('云 API 地址必须是无用户名和密码的 HTTPS 地址。');
      if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200 || typeof input.key !== 'string' || !input.key.trim() || input.key.length > 8192) throw new Error('请填写模型名称和 API Key。');
      if (!this.safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存 API Key。');
      this.settings.modelMode = 'cloud';
      this.settings.cloud = { url: url.href.replace(/\/$/, '').replace(/\/v1$/, ''), model: input.model.trim(), encryptedKey: this.safeStorage.encryptString(input.key.trim()).toString('base64') };
    }
    const live = this.phase === 'ready' && !!this.supervisor;
    if (!live) {
      await this.saveSettings();
      if (this.supervisor) await this.supervisor.close();
      this.browsers = [];
      this.update('waiting', '模型方式已保存，点击准备工作台使配置生效。');
      return;
    }
    // Only the model gateway reads the channel list; the browser and workbench services keep running.
    // busy is taken before the first await so a preparation cannot start underneath this change.
    const operation = ++this.operation;
    this.busy = true;
    this.emit('change');
    try {
      await this.saveSettings();
      let model;
      try {
        model = await this.writeChannels();
        await this.supervisor.stop('llm');
        if (model) await this.supervisor.start('llm', this.paths.entries.llm, model.key ? { BCP_DESKTOP_UPSTREAM_KEY: model.key } : {});
      } catch (error) {
        this.recordLog({ service: 'desktop', text: `模型网关未能启动：${error.message}` });
        throw new Error(`模型设置已保存，但模型网关未能启动：${error.message}`);
      }
      this.recordLog({ service: 'desktop', text: model ? `模型设置已生效：${model.model}。` : '已停用模型，浏览器与工作台继续运行。' });
    } finally {
      if (this.operation === operation) this.busy = false;
      this.emit('change');
    }
  }

  /** Page and backend eval are on unless the user turned them off; screenshots may also go to a folder they chose. */
  async savePolicy(input) {
    const change = {};
    if (input?.allowEval !== undefined) {
      if (typeof input.allowEval !== 'boolean') throw new Error('页面脚本开关无效。');
      change.eval = input.allowEval;
    }
    if (input?.allowLocalEval !== undefined) {
      if (typeof input.allowLocalEval !== 'boolean') throw new Error('本机脚本开关无效。');
      change.localEval = input.allowLocalEval;
    }
    if (input?.screenshotDir !== undefined) {
      if (input.screenshotDir !== null && (typeof input.screenshotDir !== 'string' || !isAbsolute(input.screenshotDir))) throw new Error('截图目录必须是完整路径。');
      change.screenshotDir = input.screenshotDir;
    }
    if (change.eval !== undefined) this.settings.allowEval = change.eval;
    if (change.localEval !== undefined) this.settings.allowLocalEval = change.localEval;
    if (change.screenshotDir !== undefined) {
      if (change.screenshotDir) this.settings.screenshotDir = change.screenshotDir;
      else delete this.settings.screenshotDir;
    }
    await this.saveSettings();
    // A running backend reads these on every use, so the change applies without a restart — also mid-start.
    if (this.supervisor?.endpoints.backend) await this.pushPolicy();
    this.recordLog({ service: 'desktop', text: `浏览器能力已更新：页面脚本${this.settings.allowEval === false ? '关闭' : '开启'}，本机脚本${this.settings.allowLocalEval === false ? '关闭' : '开启'}，截图目录${this.settings.screenshotDir || '为系统临时目录'}。` });
  }

  /** Sends the saved policy straight to the backend's internal port. Like every request to a desktop service it
   *  must pass the service's desktop guard (Authorization); the policy token on top is what only this coordinator holds. */
  async pushPolicy() {
    await this.policyRequest({ eval: this.settings.allowEval !== false, localEval: this.settings.allowLocalEval !== false, screenshotDir: this.settings.screenshotDir || null });
  }

  async policyRequest(body) {
    const response = await fetch(`${this.supervisor.endpoints.backend.internal}/internal/browsers/policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}`, 'X-BCP-Policy-Token': this.policyToken },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`浏览器能力未能应用到后端（${response.status}）。`);
  }

  async completeSetup() {
    this.settings.setupCompleted = true;
    await this.saveSettings();
  }

  async saveShellPosition(position) {
    this.settings.shellPosition = position;
    await this.saveSettings();
  }

  async runDemo() {
    await this.refreshBrowsers();
    if (this.busy || !this.snapshot().browserReady) throw new Error('请先确认已连接的浏览器。');
    this.busy = true;
    this.demo = { status: 'running', currentGoal: '正在打开只读示例页', ranSteps: 0, totalSteps: 2 };
    this.emit('change');
    try {
      const book = JSON.parse(await readFile(join(this.paths.templates, 'desktop-readonly-demo.json'), 'utf8'));
      const started = await this.api('/__bcp/backend/internal/run', {
        method: 'POST', body: JSON.stringify({ name: book.name, params: { sampleUrl: `${this.ingress.origin}/__desktop/sample` }, mode: 'auto', playbookJson: JSON.stringify(book) }),
      });
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const run = await this.api(`/__bcp/backend/internal/run/${encodeURIComponent(started.planId)}`);
        this.demo = run; this.emit('change');
        if (!['running', 'pending'].includes(run.status)) {
          const reading = run.stepHistory?.find((step) => step.method === 'browser.readContent' && step.resultId);
          if (reading) {
            const detail = await this.api(`/__bcp/backend/internal/run/${encodeURIComponent(started.planId)}/results/${encodeURIComponent(reading.resultId)}`);
            this.demo.content = detail;
            this.emit('change');
          }
          return;
        }
        await new Promise((done) => setTimeout(done, 700));
      }
      throw new Error('示例任务等待超时，请到工作台查看任务实际状态。');
    } catch (error) { this.demo = { ...this.demo, status: 'failed', error: error.message }; }
    finally { this.busy = false; this.emit('change'); }
  }

  async close() {
    this.cancelLocalPull();
    await this.supervisor?.close();
    await this.ingress?.close();
    await this.logWrite;
    await this.settingsWrite;
  }
}
