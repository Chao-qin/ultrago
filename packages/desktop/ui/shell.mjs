const bridge = window.desktopShell;
const trigger = document.getElementById('shell-trigger');
const menu = document.getElementById('shell-menu');
let timer;
let hovered = false;
let focused = false;
let expanded = false;
let pointer;
let dragged = false;
let dragTask = Promise.resolve();
function showError(error) { document.getElementById('shell-error').textContent = error.message; document.getElementById('shell-error').hidden = false; }
function sendDrag(name, input) { dragTask = dragTask.then(() => bridge.action(name, input)).catch(showError); }
function armIdle() {
  clearTimeout(timer);
  if (!expanded && !hovered && !focused && !pointer) timer = setTimeout(() => document.body.classList.add('idle'), 8000);
}
function wake() { clearTimeout(timer); document.body.classList.remove('idle'); }
async function setExpanded(value, restoreFocus = false) {
  expanded = value;
  menu.hidden = !value;
  trigger.setAttribute('aria-expanded', String(value));
  wake();
  try { await bridge.action('expanded', value); }
  catch (error) { document.getElementById('shell-error').textContent = error.message; document.getElementById('shell-error').hidden = false; }
  if (restoreFocus) trigger.focus();
  armIdle();
}
trigger.addEventListener('click', (event) => { if (!dragged || event.detail === 0) void setExpanded(!expanded); });
trigger.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  pointer = { id: event.pointerId, x: event.screenX, y: event.screenY };
  dragged = false;
  trigger.setPointerCapture(event.pointerId);
  wake();
});
trigger.addEventListener('pointermove', (event) => {
  if (!pointer || pointer.id !== event.pointerId) return;
  if (!dragged && Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) < 6) return;
  if (!dragged) {
    dragged = true;
    expanded = false; menu.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    document.body.classList.add('dragging');
    sendDrag('dragStart', { x: pointer.x, y: pointer.y });
  }
  sendDrag('dragMove', { x: event.screenX, y: event.screenY });
});
function endDrag(event) {
  if (!pointer || pointer.id !== event.pointerId) return;
  pointer = undefined;
  if (dragged) sendDrag('dragEnd');
  document.body.classList.remove('dragging');
  armIdle();
}
trigger.addEventListener('pointerup', endDrag);
trigger.addEventListener('pointercancel', endDrag);
trigger.addEventListener('lostpointercapture', endDrag);
document.addEventListener('pointerenter', () => { hovered = true; wake(); });
document.addEventListener('pointerleave', () => { hovered = false; armIdle(); });
document.addEventListener('focusin', () => { focused = true; wake(); });
window.addEventListener('blur', () => { focused = false; armIdle(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); void setExpanded(false, true); }
});
document.querySelectorAll('[data-shell-action]').forEach((button) => button.addEventListener('click', async () => {
  const error = document.getElementById('shell-error');
  error.hidden = true;
  try { await bridge.action(button.dataset.shellAction); if (!button.dataset.shellAction.startsWith('zoom')) await setExpanded(false); }
  catch (failure) { error.textContent = failure.message; error.hidden = false; }
}));
function applyState(state) {
  if (state.collapse) {
    const wasActive = expanded || focused || hovered;
    expanded = false; focused = false; hovered = false; menu.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (wasActive) armIdle();
    return;
  }
  document.querySelector('[data-shell-action="workbench"]').disabled = !state.canWorkbench;
  document.querySelector('[data-shell-action="tray"]').disabled = !state.canTray;
  if (state.placement) {
    document.body.dataset.edge = state.placement.edge;
    trigger.style.left = state.placement.triggerX + 'px';
    trigger.style.top = state.placement.triggerY + 'px';
    menu.style.top = state.placement.menuAbove ? '8px' : '72px';
  }
}
bridge.subscribe(applyState);
void bridge.action('state').then(applyState).catch(showError);
armIdle();
