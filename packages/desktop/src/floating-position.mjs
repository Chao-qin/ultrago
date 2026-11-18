const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

export function normalizeDock(value) {
  if (!['left', 'right', 'top', 'bottom'].includes(value?.edge) || !Number.isFinite(value?.offset)) return { edge: 'left', offset: .42 };
  return { edge: value.edge, offset: clamp(value.offset, 0, 1) };
}

export function nearestDock(center, width, height) {
  const distances = [['left', center.x], ['right', width - center.x], ['top', center.y], ['bottom', height - center.y]];
  const edge = distances.reduce((best, next) => next[1] < best[1] ? next : best)[0];
  const vertical = edge === 'left' || edge === 'right';
  return normalizeDock({ edge, offset: ((vertical ? center.y : center.x) - 38) / Math.max(1, (vertical ? height : width) - 76) });
}

export function floatingBounds(position, width, height, expanded, draggingCenter) {
  const dock = normalizeDock(position);
  const x = dock.edge === 'left' ? 0 : dock.edge === 'right' ? width - 76 : dock.offset * (width - 76);
  const y = dock.edge === 'top' ? 0 : dock.edge === 'bottom' ? height - 76 : dock.offset * (height - 76);
  const anchorX = clamp(draggingCenter ? draggingCenter.x - 38 : x, 0, width - 76);
  const anchorY = clamp(draggingCenter ? draggingCenter.y - 38 : y, 0, height - 76);
  const viewWidth = expanded ? 272 : 76;
  const viewHeight = expanded ? 372 : 76;
  const menuAbove = expanded && anchorY + viewHeight > height;
  const viewX = clamp(anchorX, 0, width - viewWidth);
  const viewY = clamp(menuAbove ? anchorY - (viewHeight - 76) : anchorY, 0, height - viewHeight);
  return {
    bounds: { x: Math.round(viewX), y: Math.round(viewY), width: viewWidth, height: viewHeight },
    triggerX: Math.round(anchorX - viewX + 14), triggerY: Math.round(anchorY - viewY + 14),
    menuAbove, edge: dock.edge,
  };
}
