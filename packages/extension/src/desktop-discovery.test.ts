import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopConnection, desktopReloadMarker, reloadForDesktop } from './desktop-discovery';

test('desktop discovery accepts only current loopback connection metadata', () => {
  const connection = { version: 1, generation: 'run-id', backendUrl: 'ws://127.0.0.1:43123', token: 'a'.repeat(64) };
  assert.deepEqual(desktopConnection(connection), connection);
  for (const patch of [{ version: 2 }, { token: 'bcp-dev-token' }, { backendUrl: 'ws://localhost:43123' }, { backendUrl: 'ws://127.0.0.1:0' }, { backendUrl: 'wss://remote.example:43123' }, { backendUrl: 'ws://127.0.0.1:43123/?token=secret' }, { generation: '' }, { extensionVersion: 7 }, { extensionVersion: '0.1.7; reload' }]) {
    assert.equal(desktopConnection({ ...connection, ...patch }), null);
  }
});

test('desktop discovery carries the bundled extension version', () => {
  const connection = { version: 1, generation: 'run-id', backendUrl: 'ws://127.0.0.1:43123', token: 'a'.repeat(64), extensionVersion: '0.1.7' };
  assert.deepEqual(desktopConnection(connection), connection);
});

test('an upgraded desktop reloads the unpacked extension once per version pair', () => {
  assert.equal(desktopReloadMarker(undefined, '0.1.6', undefined), null, '旧客户端不提供版本时不重载');
  assert.equal(desktopReloadMarker('0.1.6', '0.1.6', undefined), null);
  assert.equal(desktopReloadMarker('0.1.7', '0.1.6', undefined), '0.1.6->0.1.7');
  assert.equal(desktopReloadMarker('0.1.7', '0.1.6', '0.1.6->0.1.7'), null, '重载后仍是旧版本（从别的目录加载）时不循环');
  assert.equal(desktopReloadMarker('0.1.8', '0.1.6', '0.1.6->0.1.7'), '0.1.6->0.1.8', '再次升级会重新尝试');
});

test('the reload marker is stored before reloading and blocks the next reload', async () => {
  const stored: Record<string, unknown> = {};
  const events: string[] = [];
  const storage = {
    get: async (key: string) => ({ [key]: stored[key] }),
    set: async (items: Record<string, unknown>) => { events.push(`set:${String(items.bcpDesktopReload)}`); Object.assign(stored, items); },
  };
  const reload = () => { events.push('reload'); };
  assert.equal(await reloadForDesktop('0.1.7', '0.1.6', storage, reload), true);
  assert.deepEqual(events, ['set:0.1.6->0.1.7', 'reload'], '先落盘再重载，否则重载后读不到标记会循环');
  assert.equal(await reloadForDesktop('0.1.7', '0.1.6', storage, reload), false, '重载后仍是旧版本时不再重载');
  assert.equal(await reloadForDesktop('0.1.7', '0.1.7', storage, reload), false);
  assert.deepEqual(events, ['set:0.1.6->0.1.7', 'reload']);
});
