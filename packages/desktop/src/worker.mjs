import { pathToFileURL } from 'node:url';

const parent = process.parentPort;
if (!parent || process.env.BCP_DESKTOP !== '1') throw new Error('This entry requires the desktop coordinator');
let lastHeartbeat = Date.now();
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  if (process.listenerCount('SIGTERM')) process.emit('SIGTERM');
  else process.exit(0);
};
parent.on('message', ({ data }) => {
  if (data?.type === 'heartbeat') lastHeartbeat = Date.now();
  if (data?.type === 'shutdown') shutdown();
});
setInterval(() => {
  if (Date.now() - lastHeartbeat > 20_000) shutdown();
}, 3000).unref();

// Only the coordinator's exact origin receives this credential.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).origin === process.env.BCP_DESKTOP_ORIGIN) {
    request.headers.set('Authorization', `Bearer ${process.env.BCP_DESKTOP_TOKEN}`);
    request.headers.set('X-BCP-Internal-Token', process.env.BCP_INTERNAL_TOKEN);
  }
  return nativeFetch(request);
};

try {
  process.argv = [process.execPath, process.env.BCP_DESKTOP_ENTRY];
  await import(pathToFileURL(process.env.BCP_DESKTOP_ENTRY).href);
} catch (error) {
  parent.postMessage({ type: 'failed', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
