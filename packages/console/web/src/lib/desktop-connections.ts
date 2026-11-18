export interface DesktopConnections {
  serviceReady: boolean;
  browserReady: boolean;
  browserId: string;
  mcpReady: boolean;
  modelMode: string;
  lastError: string;
  assistants: Array<{ id: string; name: string; state: 'connecting' | 'connected' | 'disconnected' | 'error'; error: string; toolCount?: number }>;
}

export async function fetchDesktopConnections(): Promise<DesktopConnections | null> {
  const response = await fetch('/__desktop/status');
  if (response.status === 404) return null;
  if (response.ok && !response.headers.get('content-type')?.includes('application/json')) return null;
  if (!response.ok) throw new Error(`连接状态查询失败（${response.status}）`);
  return response.json();
}

export async function openDesktopConnections(): Promise<void> {
  const response = await fetch('/__desktop/open-connections', { method: 'POST' });
  if (!response.ok) throw new Error(`无法打开客户端连接诊断（${response.status}）`);
}
