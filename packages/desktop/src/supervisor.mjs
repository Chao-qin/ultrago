import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { acceptReady } from './runtime-state.mjs';
import { createLogRedactor, createTerminalFilter } from './log-redaction.mjs';

const LABELS = { migrate: '工作台数据库初始化', backend: '浏览器服务', console: '工作台服务', llm: '模型网关' };
// The browser service is not restarted: the workbench re-queues runs a fresh backend no longer knows.
const SELF_HEALING = new Set(['console', 'llm']);
const RESTART_LIMIT = 3;
const RESTART_WINDOW = 60_000;
const credentials = (env) => Object.entries(env).filter(([key, value]) => /TOKEN|SECRET|KEY/.test(key) && value?.length >= 8).map(([, value]) => value);

export class Supervisor extends EventEmitter {
  constructor({ fork, forkJob, worker, env, cwd, generation, timeout = 30_000, restartDelay = 1000 }) {
    super();
    Object.assign(this, { fork, forkJob, worker, env, cwd, generation, timeout, restartDelay });
    this.children = new Map();
    this.endpoints = {};
    this.stopping = false;
    this.active = false;
    // Services that reached readiness, so an unexpected exit restarts only that one.
    this.specs = new Map();
    this.restarts = new Map();
    this.pending = new Map();
    this.stopped = new Set();
    this.secrets = credentials(env);
    this.heartbeat = setInterval(() => {
      for (const child of this.children.values()) {
        if (child.postMessage) child.postMessage({ type: 'heartbeat' });
        else if (child.connected) child.send({ type: 'heartbeat' });
      }
    }, 3000);
    this.heartbeat.unref();
  }

  start(service, entry, extra = {}, job = false) {
    if (this.children.has(service) || this.stopping) return Promise.reject(new Error('service already running or stopping'));
    for (const secret of credentials(extra)) if (!this.secrets.includes(secret)) this.secrets.push(secret);
    return new Promise((done, fail) => {
      let settled = false;
      let ready = false;
      let tail = '';
      const label = LABELS[service] || service;
      const failure = (reason) => new Error(`${label}${reason}${tail.trim() ? `\n最近输出：\n${tail.trim()}` : '\n进程尚未输出日志。'}`);
      const spawn = job ? this.forkJob : this.fork;
      if (!spawn) { fail(new Error('CLI process launcher is unavailable')); return; }
      const child = spawn(job ? entry : this.worker, job ? ['migrate', 'deploy', '--schema', extra.BCP_DESKTOP_SCHEMA] : [], {
        cwd: this.cwd, stdio: 'pipe',
        env: { ...this.env, ...extra, NO_COLOR: '1', BCP_DESKTOP_ENTRY: entry },
        serviceName: `UltraGo ${service}`,
      });
      this.children.set(service, child);
      const redactors = [];
      const log = (value) => {
        const text = value.slice(-8192);
        if (!text) return;
        tail = (tail + text).slice(-4096);
        this.emit('log', { service, text });
      };
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        const redactor = createLogRedactor(this.secrets);
        const terminal = createTerminalFilter();
        const flush = () => redactor.write(terminal.flush()) + redactor.flush();
        redactors.push({ flush });
        stream.on('data', (chunk) => log(redactor.write(terminal.write(chunk))));
        stream.once('end', () => log(flush()));
      }
      const flushLogs = () => { for (const redactor of redactors) log(redactor.flush()); };
      const timer = setTimeout(() => { flushLogs(); child.kill(); finish(failure('启动超时')); }, job ? Math.max(this.timeout, 120_000) : this.timeout);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) fail(error); else done(value);
      };
      child.on('message', (message) => {
        if (message?.type === 'failed') {
          let reason = String(message.message);
          for (const secret of this.secrets) reason = reason.replaceAll(secret, '[hidden]');
          flushLogs(); child.kill(); finish(failure(`：${reason}`)); return;
        }
        const endpoints = acceptReady(message, service, this.generation);
        if (!job && endpoints && !settled) {
          ready = true;
          this.endpoints[service] = endpoints;
          this.specs.set(service, { entry, extra });
          if (this.active) child.postMessage?.({ type: 'activate' });
          finish(null, endpoints);
          this.emit('change');
        }
      });
      child.once('exit', (code, signal) => {
        flushLogs();
        this.children.delete(service);
        delete this.endpoints[service];
        finish(job && code === 0 ? null : failure(`已退出（${signal || code}）`));
        this.emit('change');
        // Exits before readiness reject start() above; only a ready service is recovered here.
        if (this.stopped.delete(service) || this.stopping || job || !ready) return;
        if (SELF_HEALING.has(service)) this.recover(service, `${signal || code}`);
        else this.emit('failure', `${service} 已退出，请恢复本地服务；已开始的任务不会自动重跑。`);
      });
      child.once('error', (error) => { child.kill(); finish(error); });
    });
  }

  recover(service, reason) {
    const label = LABELS[service] || service;
    const now = Date.now();
    const recent = (this.restarts.get(service) || []).filter((time) => now - time < RESTART_WINDOW);
    if (recent.length >= RESTART_LIMIT) {
      this.emit('failure', `${label}在 1 分钟内连续退出 ${RESTART_LIMIT + 1} 次（${reason}），已停止自动重启，请恢复本地服务。`);
      return;
    }
    recent.push(now);
    this.restarts.set(service, recent);
    this.emit('log', { service, text: `${label}意外退出（${reason}），正在自动重启（1 分钟内第 ${recent.length} 次）。` });
    const { entry, extra } = this.specs.get(service);
    const timer = setTimeout(() => {
      this.pending.delete(service);
      if (this.stopping || this.children.has(service)) return;
      this.start(service, entry, extra).then(
        () => { this.emit('log', { service, text: `${label}已自动恢复。` }); this.emit('restarted', service); },
        // stop() during the restart removes the spec; that exit is intended, not a failure.
        (error) => { if (!this.stopping && this.specs.has(service)) this.emit('failure', `${label}自动重启失败：${error.message}`); },
      );
    }, this.restartDelay);
    timer.unref?.();
    this.pending.set(service, timer);
  }

  activate() {
    this.active = true;
    for (const child of this.children.values()) child.postMessage?.({ type: 'activate' });
  }

  /** Stops one service on purpose; it is not restarted. */
  async stop(service) {
    const child = this.children.get(service);
    clearTimeout(this.pending.get(service));
    this.pending.delete(service);
    this.specs.delete(service);
    if (!child) return;
    this.stopped.add(service);
    await this.terminate(service, child);
  }

  terminate(service, child) {
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        try {
          if (service === 'console' && process.platform === 'win32' && child.pid) {
            const result = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 4000 });
            if (result.error) throw result.error;
            if (result.status !== 0) throw new Error(`工作台进程树清理失败：${result.stderr || result.status}`);
          } else child.kill();
          done();
        } catch (error) { fail(error); }
      }, 5000);
      child.once('exit', () => { clearTimeout(timer); done(); });
      if (child.postMessage) child.postMessage({ type: 'shutdown' });
      else child.kill();
    });
  }

  async close() {
    this.stopping = true;
    clearInterval(this.heartbeat);
    await Promise.all([...this.children.entries()].map(([service, child]) => this.terminate(service, child)));
    this.children.clear();
    this.endpoints = {};
  }
}
