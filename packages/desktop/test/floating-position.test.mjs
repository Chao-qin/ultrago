import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floatingBounds, nearestDock, normalizeDock } from '../src/floating-position.mjs';

test('drag release snaps to the nearest of all four window edges', () => {
  for (const [edge, center] of [['left', { x: 40, y: 300 }], ['right', { x: 1000, y: 300 }], ['top', { x: 500, y: 20 }], ['bottom', { x: 500, y: 700 }]]) {
    assert.equal(nearestDock(center, 1040, 740).edge, edge);
  }
  assert.deepEqual(normalizeDock({ edge: 'right', offset: 5 }), { edge: 'right', offset: 1 });
  assert.deepEqual(normalizeDock({ edge: 'unknown', offset: 0 }), { edge: 'left', offset: .42 });
});

test('button and expanded menu stay inside the window after docking or resizing', () => {
  for (const [width, height] of [[1140, 820], [780, 610]]) for (const edge of ['left', 'right', 'top', 'bottom']) for (const offset of [0, .4, 1]) for (const expanded of [true, false]) {
    const { bounds, triggerX, triggerY } = floatingBounds({ edge, offset }, width, height, expanded);
    assert.ok(bounds.x >= 0 && bounds.y >= 0);
    assert.ok(bounds.x + bounds.width <= width && bounds.y + bounds.height <= height);
    assert.ok(triggerX >= 0 && triggerY >= 0 && triggerX + 48 <= bounds.width && triggerY + 48 <= bounds.height);
    const closed = floatingBounds({ edge, offset }, width, height, false);
    assert.ok(Math.abs(bounds.x + triggerX - closed.bounds.x - closed.triggerX) <= 1, '菜单展开不移动按钮');
    assert.ok(Math.abs(bounds.y + triggerY - closed.bounds.y - closed.triggerY) <= 1);
  }
});
