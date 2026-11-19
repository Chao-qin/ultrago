import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SERVER = 'ultrago';

const GUIDES = {
  generic: { name: '其他支持 MCP 的助手', docs: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers', steps: ['在助手中找到 MCP / 工具 / 本地服务器设置，选择 stdio（命令行）。', '填写下方程序路径与参数；支持 mcpServers 的客户端也可合并下方 JSON。保留已有服务器配置。', '保存并重新连接，在助手工具列表中确认 ultrago。'] },
  claude: { name: 'Claude Desktop', download: 'https://claude.com/download', docs: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers', steps: ['打开 Claude Desktop 的设置 → Developer → Edit Config。', '将下方 ultrago 项合并到 mcpServers，保留已有配置。', '保存后完全退出并重新打开 Claude Desktop，在工具列表中确认 ultrago。'] },
  cursor: { name: 'Cursor', download: 'https://cursor.com/download', docs: 'https://cursor.com/docs/mcp', steps: ['在 Cursor 设置中找到 MCP，打开或创建 mcp.json。', '将下方 ultrago 项合并到 mcpServers，保留已有配置。', '启用服务器，在 Agent 的工具列表中确认 ultrago。'] },
  opencode1: { name: 'OpenCode 1.x', download: 'https://opencode.ai/download', docs: 'https://opencode.ai/docs/mcp-servers/', steps: ['运行 opencode --version 确认是 1.x，再打开 OpenCode 的 opencode.json / opencode.jsonc 配置。', '将下方 ultrago 项合并到 mcp，服务器名直接放在 mcp 下。官方文档现为 2.x 的 mcp.servers 写法，较早的 1.x 读到它会判整份配置无效。', '保存后重新打开 OpenCode，运行 opencode mcp list 确认列出了 ultrago。'] },
  opencode: { name: 'OpenCode 2.x', download: 'https://opencode.ai/download', docs: 'https://opencode.ai/docs/mcp-servers/', steps: ['运行 opencode --version 确认是 2.x，再打开 OpenCode 的 opencode.json / opencode.jsonc 配置。', '将下方 ultrago 项合并到 mcp.servers。此格式只用于 2.x；1.x 请选择 OpenCode 1.x。', '保存并重新连接，在 MCP 管理界面确认 ultrago 已连接。'] },
};

export function agentSetup(client, executable, args) {
  if (!Object.hasOwn(GUIDES, client)) throw new Error('请选择列表中的助手类型。');
  // OpenCode 2.x nests servers under mcp.servers; 1.x keeps them directly under mcp, and up to 1.18 rejects the
  // whole config when it meets mcp.servers.
  const local = { type: 'local', command: [executable, ...args] };
  const config = client === 'opencode' ? { mcp: { servers: { [SERVER]: local } } }
    : client === 'opencode1' ? { mcp: { [SERVER]: local } }
    : { mcpServers: { [SERVER]: { command: executable, args } } };
  return { ...GUIDES[client], executable, args, config: JSON.stringify(config, null, 2) };
}

/**
 * Assistants the client connects for the user, each the way its own documentation offers: an install link opens
 * the assistant's own confirmation, a CLI is the assistant's own command, and Claude Desktop, which has neither,
 * gets its documented config file merged.
 */
const CONNECTORS = {
  claude: { name: 'Claude Desktop', via: 'config' },
  'claude-code': { name: 'Claude Code', via: 'cli', command: 'claude' },
  codex: { name: 'Codex', via: 'cli', command: 'codex' },
  opencode: { name: 'OpenCode', via: 'cli', command: 'opencode' },
  cursor: { name: 'Cursor', via: 'link', protocol: 'cursor://' },
  vscode: { name: 'VS Code', via: 'link', protocol: 'vscode://' },
  trae: { name: 'Trae', via: 'link', protocol: 'trae://' },
};

export const claudeConfigFile = (appData) => join(appData, 'Claude', 'claude_desktop_config.json');

/** Install links in the formats VS Code, Cursor and Trae document; each shows the server and asks before adding it. */
export function agentLink(client, command, args) {
  const config = encodeURIComponent(Buffer.from(JSON.stringify({ command, args })).toString('base64'));
  if (client === 'vscode') return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER, command, args }))}`;
  if (client === 'cursor') return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER}&config=${config}`;
  if (client === 'trae') return `trae://trae.ai-ide/mcp-import?type=stdio&name=${SERVER}&config=${config}`;
  throw new Error('该助手没有安装链接。');
}

/**
 * The commands that (re)register this server with a CLI assistant. Claude Code refuses to add a name that already
 * exists, and ours may still point at a previous install folder, so the user-scope entry is removed first; that
 * remove fails when there is none, which is fine. Codex and OpenCode replace an existing entry by themselves.
 * OpenCode 2.x writes to the project config in its working directory unless told `--global`; 1.x (still npm's
 * `latest`) rejects that flag and always writes the global config, and before 1.17 its `mcp add` is interactive
 * only. `version` is what `opencode --version` printed.
 */
export function agentCliSteps(client, command, args, version = '') {
  if (client === 'claude-code') return [{ args: ['mcp', 'remove', '-s', 'user', SERVER], optional: true }, { args: ['mcp', 'add', '-s', 'user', SERVER, '--', command, ...args] }];
  if (client === 'codex') return [{ args: ['mcp', 'add', SERVER, '--', command, ...args] }];
  if (client === 'opencode') {
    const [major, minor] = /(\d+)\.(\d+)\.\d+/.exec(version)?.slice(1).map(Number) ?? [];
    if (major < 1 || (major === 1 && minor < 17)) throw new Error(`OpenCode ${major}.${minor} 只能交互添加 MCP，无法一键接入：请升级 OpenCode，或在「手动接入其他助手」中选择 OpenCode 1.x 复制配置。`);
    return [{ args: ['mcp', 'add', ...(major < 2 ? [] : ['--global']), SERVER, '--', command, ...args] }];
  }
  throw new Error('该助手没有命令行。');
}

/** The newest versions first: a version manager keeps every Node it ever installed, and the assistant is on one of them. */
async function versionBins(root, ...rest) {
  let versions;
  try { versions = await readdir(root); } catch { return []; }
  return versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((version) => join(root, version, ...rest));
}

/**
 * Where macOS keeps assistants that a GUI launch cannot see. A client started from Finder inherits launchd's PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), not the shell's, so every Homebrew, npm or version-manager install is invisible
 * until the user happens to start the client from a terminal. These are the folders those installers document;
 * the version-manager ones are read from the user's home instead of guessed.
 */
export async function macFolders(env = process.env) {
  const folders = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/opt/local/bin'];
  const home = env.HOME;
  if (!home) return folders;
  folders.push(
    join(home, '.local', 'bin'), join(home, 'bin'), join(home, '.npm-global', 'bin'), join(home, 'Library', 'pnpm'),
    join(home, '.bun', 'bin'), join(home, '.volta', 'bin'), join(home, '.asdf', 'shims'),
    // OpenCode's own installer links its command here.
    join(home, '.opencode', 'bin'),
  );
  folders.push(...await versionBins(join(home, '.nvm', 'versions', 'node'), 'bin'));
  folders.push(...await versionBins(join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), 'installation', 'bin'));
  return folders;
}

/**
 * PATH lookup as the user's shell does it, plus the folders the installers document: npm links global commands
 * straight into %AppData%\npm, the Claude Code installer puts claude.exe in %USERPROFILE%\.local\bin, and macOS
 * keeps everything outside launchd's PATH (see macFolders).
 * Windows never updates a running process's environment, so without them an assistant installed after this client
 * started (it autostarts at login) would stay undetected until the client is quit.
 */
export async function findExecutable(name, env = process.env, platform = process.platform) {
  const extensions = platform === 'win32' ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const folders = (env.PATH || '').split(platform === 'win32' ? ';' : ':');
  if (platform === 'win32') folders.push(env.APPDATA && join(env.APPDATA, 'npm'), env.USERPROFILE && join(env.USERPROFILE, '.local', 'bin'));
  else if (platform === 'darwin') folders.push(...await macFolders(env));
  for (const folder of folders.filter(Boolean)) {
    for (const extension of extensions) {
      const file = join(folder, name + extension);
      try { if ((await stat(file)).isFile()) return file; } catch { /* not in this folder */ }
    }
  }
  return null;
}

/** The assistants' CLIs print UTF-8, but cmd.exe's own errors ("'node' is not recognized…") use the console's
 *  legacy code page, GBK on Chinese Windows. */
export function decodeOutput(buffer) {
  const text = buffer.toString('utf8');
  if (!text.includes('\uFFFD')) return text;
  try { return new TextDecoder('gbk').decode(buffer); } catch { return text; }
}

const execute = (file, args, options = {}) => new Promise((done) => {
  execFile(file, args, { ...options, encoding: 'buffer', timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
    const output = decodeOutput(Buffer.concat([stdout ?? Buffer.alloc(0), stderr ?? Buffer.alloc(0)])).trim();
    done({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, output: output || error?.message || '' });
  });
});

/**
 * Runs an assistant's CLI. On Windows npm installs it as a .cmd shim, which Node starts only through cmd.exe; every
 * argument is then quoted for cmd, and a value cmd would still reinterpret (a quote, %, a line break) is refused
 * rather than handed over altered.
 */
export function runAgentCli(file, args, { platform = process.platform, run = execute } = {}) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const unsafe = [file, ...args].find((value) => /["%\r\n]/.test(value));
    if (unsafe) return Promise.reject(new Error(`路径含有命令行无法安全传递的字符：${unsafe}`));
    const line = [file, ...args].map((value) => `"${value}"`).join(' ');
    // /v:off: with delayed expansion enabled in the registry, cmd would rewrite a "!" inside quotes as well.
    const shell = process.env.ComSpec || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    return run(shell, ['/d', '/v:off', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true });
  }
  return run(file, args);
}

const MSIX_CLAUDE = '检测到应用商店（MSIX）版 Claude Desktop，它实际读取的配置位置随版本变化，无法可靠写入。请在下方选择 Claude Desktop 并复制配置，到 Claude 的设置 → Developer → Edit Config 中合并，再在工具列表中确认 ultrago。';

/**
 * Which assistants are installed: a link needs the assistant's registered URL scheme, a CLI has to be found the way
 * findExecutable looks, and Claude Desktop is known by its data folder or its Microsoft Store package. Each one is
 * checked on its own, so one that cannot be checked is reported as such instead of emptying the whole list.
 * `blocked` names why a detected assistant still cannot be connected from here.
 */
export async function detectAgents({ appData, localAppData, env, platform, protocolHandler }) {
  const exists = (path) => access(path).then(() => true, () => false);
  return Promise.all(Object.entries(CONNECTORS).map(async ([client, connector]) => {
    const agent = { client, name: connector.name, via: connector.via, detected: false, where: '' };
    try {
      if (connector.via === 'link') agent.where = protocolHandler(connector.protocol) || '';
      else if (connector.via === 'cli') agent.where = await findExecutable(connector.command, env, platform) || '';
      else if (await claudePackagedInstall(localAppData)) return { ...agent, detected: true, blocked: MSIX_CLAUDE };
      else if (await exists(join(appData, 'Claude'))) agent.where = claudeConfigFile(appData);
    } catch (error) { return { ...agent, blocked: `检测失败：${error.message}` }; }
    return { ...agent, detected: !!agent.where };
  }));
}

/** Connects one assistant the user picked; resolves with what the user still has to do, rejects with why it failed. */
export async function connectAgent(client, command, args, { openExternal, appData, localAppData, env, platform, run }) {
  if (!Object.hasOwn(CONNECTORS, client)) throw new Error('请选择列表中的助手。');
  const { name, via, command: cli } = CONNECTORS[client];
  if (via === 'link') {
    await openExternal(agentLink(client, command, args));
    return `已打开 ${name}，请在 ${name} 中确认添加 ultrago。`;
  }
  if (via === 'cli') {
    const file = await findExecutable(cli, env, platform);
    if (!file) throw new Error(`没有找到 ${cli} 命令，请确认 ${name} 已安装并能在命令行中运行。`);
    const version = client === 'opencode' ? (await runAgentCli(file, ['--version'], { platform, run })).output : '';
    for (const step of agentCliSteps(client, command, args, version)) {
      const result = await runAgentCli(file, step.args, { platform, run });
      if (result.code !== 0 && !step.optional) throw new Error(`${name} 未能添加 ultrago：${result.output || `退出码 ${result.code}`}`);
    }
    return `已加入 ${name} 的用户配置，重新打开 ${name} 后可用。`;
  }
  if (await claudePackagedInstall(localAppData)) throw new Error(MSIX_CLAUDE);
  const result = await installAgentConfig(claudeConfigFile(appData), command, args);
  return result.unchanged ? `Claude Desktop 配置已包含 ultrago：${result.file}`
    : `已写入 ${result.file}${result.backup ? `，原文件已备份为 ${result.backup}` : ''}。请完全退出并重新打开 Claude Desktop。`;
}

/**
 * MSIX (Microsoft Store) builds of Claude Desktop read a per-package copy of the config whose location has
 * moved between releases, so a write to the documented %APPDATA% path may never be loaded.
 */
async function claudePackagedInstall(localAppData) {
  if (!localAppData) return false;
  try { if ((await readdir(join(localAppData, 'Packages'))).some((name) => name.startsWith('Claude_'))) return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await access(join(localAppData, 'Claude-Data')); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return false;
}

/** Merges this client into `mcpServers`, keeping every other entry; the previous file is backed up first. */
export async function installAgentConfig(file, executable, args, now = new Date()) {
  let current = {};
  let existed = true;
  try {
    const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    current = text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    if (error.code === 'ENOENT') existed = false;
    else if (error instanceof SyntaxError) throw new Error(`现有配置不是有效 JSON，未做修改：${file}`);
    else throw error;
  }
  const servers = current?.mcpServers ?? {};
  if (!current || typeof current !== 'object' || Array.isArray(current) || !servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`现有配置结构无法识别，未做修改：${file}`);
  }
  const entry = { command: executable, args };
  if (JSON.stringify(servers[SERVER]) === JSON.stringify(entry)) return { file, backup: '', unchanged: true };
  // A symlinked config (dotfile managers) is updated at its real location instead of being replaced by a copy.
  const target = existed ? await realpath(file) : file;
  let backup = '';
  if (existed) {
    backup = `${target}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
    await copyFile(target, backup, constants.COPYFILE_EXCL);
  } else await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ ...current, mcpServers: { ...servers, [SERVER]: entry } }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    // The temporary copy holds every server's settings, including their secrets; never leave it behind.
    await rm(temporary, { force: true });
    throw new Error(`配置写入失败（${error.code || error.message}），原配置未修改：${target}`);
  }
  return { file: target, backup, unchanged: false };
}

export async function checkMcp(origin, token) {
  const client = new Client({ name: 'ultrago-connection-check', version: '0.1.3' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/__bcp/mcp/mcp', origin), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }), { timeout: 5000 });
    const result = await client.listTools({}, { timeout: 5000 });
    if (!result.tools.length) throw new Error('MCP 服务尚未提供工具，请恢复本地服务后重试。');
    return { toolCount: result.tools.length };
  } finally { await client.close(); }
}

export async function checkMcpStdio(launch) {
  const client = new Client({ name: 'ultrago-connection-check', version: '0.1.6' });
  const transport = new StdioClientTransport({ ...launch, stderr: 'pipe' });
  let output = '';
  transport.stderr?.on('data', (chunk) => { output = (output + chunk.toString()).slice(-2000); });
  try {
    await client.connect(transport, { timeout: 12_000 });
    const result = await client.listTools({}, { timeout: 5000 });
    if (!result.tools.length) throw new Error('MCP 服务未提供工具');
    return { toolCount: result.tools.length, transport: 'stdio' };
  } catch (error) { throw new Error(`${error.message}${output ? `\n${output}` : ''}`); }
  finally { await client.close(); }
}
