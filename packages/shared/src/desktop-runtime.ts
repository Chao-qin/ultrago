export function runtimePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('port must be an integer between 0 and 65535');
  }
  return port;
}

let active = false;
const activationCallbacks = new Set<() => void>();
const control = typeof process === 'undefined' ? undefined : (process as unknown as { parentPort?: { on(name: string, callback: (event: { data: { type?: string } }) => void): void } }).parentPort;
control?.on('message', ({ data }) => {
  if (data?.type === 'activate') {
    active = true;
    for (const callback of activationCallbacks) callback();
    activationCallbacks.clear();
  }
});

export function desktopRuntimeActive(): boolean {
  return typeof process === 'undefined' || process.env.BCP_DESKTOP !== '1' || active;
}

export function desktopAfterActivation(callback: () => void): () => void {
  if (desktopRuntimeActive()) callback();
  else activationCallbacks.add(callback);
  return () => { activationCallbacks.delete(callback); };
}

export function desktopReady(service: string, endpoints: Record<string, string>): void {
  if (typeof process === 'undefined' || process.env.BCP_DESKTOP !== '1') return;
  const parent = (process as unknown as { parentPort?: { postMessage(message: unknown): void } }).parentPort;
  if (!parent) throw new Error('desktop service requires its coordinator');
  parent.postMessage({ type: 'ready', version: 1, generation: process.env.BCP_DESKTOP_GENERATION, service, endpoints });
}

export function desktopHttpGuard(
  req: { headers: { authorization?: string } },
  res: { statusCode: number; end(body: string): unknown },
  next: () => void,
): void {
  if (typeof process !== 'undefined' && process.env.BCP_DESKTOP === '1' && (
    !process.env.BCP_DESKTOP_TOKEN || req.headers.authorization !== `Bearer ${process.env.BCP_DESKTOP_TOKEN}`
  )) {
    res.statusCode = 401;
    res.end('Unauthorized');
    return;
  }
  next();
}
