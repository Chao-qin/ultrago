import { stripVTControlCharacters } from 'node:util';

export function createAgentConnections(now = Date.now) {
  const entries = new Map();
  return {
    update(input) {
      if (typeof input?.id !== 'string' || input.id.length > 80 || !['connecting', 'connected', 'disconnected', 'error'].includes(input.state)) throw new Error('助手连接状态无效');
      const name = stripVTControlCharacters(String(input.name || 'AI 助手')).slice(0, 100);
      if (name === 'ultrago-connection-check') { entries.delete(input.id); return; }
      const previous = entries.get(input.id);
      entries.set(input.id, {
        id: input.id, name, state: input.state, lastSeen: now(),
        error: stripVTControlCharacters(String(input.error || (input.state === 'connected' ? '' : previous?.error) || '')).slice(0, 1000),
        toolCount: Number.isInteger(input.toolCount) ? input.toolCount : previous?.toolCount,
      });
      if (entries.size > 16) entries.delete(entries.keys().next().value);
    },
    snapshot() {
      return [...entries.values()].filter((entry) => now() - entry.lastSeen < 300_000).map((entry) => ({
        ...entry, state: now() - entry.lastSeen > 35_000 && ['connecting', 'connected'].includes(entry.state) ? 'disconnected' : entry.state,
      })).sort((a, b) => b.lastSeen - a.lastSeen);
    },
  };
}
