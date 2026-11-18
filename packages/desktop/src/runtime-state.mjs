export function acceptReady(message, service, generation) {
  if (!message || message.type !== 'ready' || message.version !== 1 || message.service !== service || message.generation !== generation) return null;
  const required = service === 'backend' ? ['ws', 'mcp', 'internal'] : [service];
  const endpoints = message.endpoints;
  if (!endpoints || Object.keys(endpoints).length !== required.length) return null;
  for (const key of required) {
    try {
      const url = new URL(endpoints[key]);
      if (url.hostname !== '127.0.0.1' || url.protocol !== (key === 'ws' ? 'ws:' : 'http:') || Number(url.port) <= 0 || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    } catch { return null; }
  }
  return { ...endpoints };
}

export function cleanEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && (
    /^(SystemRoot|WINDIR|PATH|Path|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|HOME|LANG|LC_ALL|DISPLAY|XAUTHORITY)$/i.test(key)
  )));
}

export function selectedBrowser(browsers, instanceId) {
  return browsers.find((b) => b.kind === 'chrome' && b.instanceId === instanceId && b.ready) || null;
}
