const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const descriptor = process.argv[2];
const source = existsSync(join(__dirname, 'app.asar')) ? join(__dirname, 'app.asar', 'src', 'mcp-bridge.mjs') : join(__dirname, 'mcp-bridge.mjs');
import(pathToFileURL(source).href).then(({ runMcpBridge }) => runMcpBridge(descriptor)).catch((error) => {
  const message = `MCP 启动失败：${error.message}`;
  try {
    const logs = join(dirname(descriptor), 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'mcp-last-error.log'), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch (logError) { process.stderr.write(`MCP 日志写入失败：${logError.message}\n`); }
  process.stderr.write(message + '\n');
  process.exitCode = 1;
});
