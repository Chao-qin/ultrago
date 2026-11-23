const bridge = window.desktop;
const $ = (id) => document.getElementById(id);
let current = {};
let editingModel = false;
let displayedPhase;
let checkingMcp = false;
let mcpCheckGeneration = 0;
let activeStep = 0;
let stepInitialized = false;
// One fixed order. Model and assistants can be skipped but still sit in line, so nobody has to find them.
// Preferences sit outside the line: they are settings rather than a step, and saving them needs no running service.
const stepIds = ['environment', 'browser', 'model', 'agents', 'experience', 'preferences'];
const stepNames = ['准备工作台', '连接 Chrome', 'AI 模型', '接入 AI 助手', '开始使用'];
const LAST = 4;
const PREFERENCES = 5;
const optional = (step) => step === 2 || step === 3;
const reachable = (state) => state.phase === 'ready' ? state.browserReady ? LAST : 1 : 0;
// A failed preparation can be caused by the model settings, so the model step stays open to fix them.
// Preferences open before the first preparation; a returning user whose services stopped is sent back to restart them.
const canOpen = (step, state) => step === PREFERENCES ? !state.setupCompleted || state.phase === 'ready'
  : step <= reachable(state) || step === 2 && state.phase === 'failed';
const onlineAssistants = (state) => (state.connections?.assistants || []).filter((client) => client.state === 'connected');
const modelReady = (state) => state.modelMode === 'local' ? !!state.localModel?.configured : state.modelMode === 'cloud' && !!state.modelConfigured;
function stepDone(step, state) {
  if (step === 0) return state.phase === 'ready';
  if (step === 1) return state.phase === 'ready' && !!state.browserReady;
  if (step === 2) return modelReady(state);
  if (step === 3) return onlineAssistants(state).length > 0;
  return false;
}

function showStep(index, focus = true) {
  const step = Math.max(0, Math.min(PREFERENCES, index));
  activeStep = canOpen(step, current) ? step : Math.min(step, reachable(current));
  sessionStorage.setItem('setupStep', String(activeStep));
  renderWizard();
  if (activeStep === 2) void refreshLocalModel();
  if (focus) $(stepIds[activeStep]).querySelector('h2').focus({ preventScroll: true });
}

function renderWizard() {
  const ready = current.phase === 'ready';
  const available = reachable(current);
  const failed = current.phase === 'failed';
  stepIds.forEach((id, index) => { $(id).hidden = index !== activeStep; });
  // The required step still to do is the one the user is waiting on; it stands out wherever they are.
  const pending = !ready ? 0 : current.browserReady ? -1 : 1;
  document.querySelectorAll('.checklist [data-step-target]').forEach((button) => {
    const step = Number(button.dataset.stepTarget);
    const done = stepDone(step, current) && step !== activeStep;
    button.disabled = !canOpen(step, current);
    button.classList.toggle('complete', done);
    button.classList.toggle('failed', step === 0 && failed);
    button.classList.toggle('attention', step === pending && !failed);
    button.querySelector('.step-dot').textContent = done ? '✓' : step === PREFERENCES ? '⋯' : step + 1;
    const status = button.querySelector('.step-status');
    status.textContent = status.title = stepStatus(step, current);
    if (step === activeStep) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });
  $('checklist-title').textContent = failed ? '工作台没能启动' : !ready ? '先准备工作台' : !stepDone(1, current) ? '还差一步就能开始' : '一切就绪';
  $('checklist-sub').textContent = failed ? '先看看日志，修好后重试；模型设置也可以先去检查。'
    : !stepDone(1, current) ? '必需两项完成后即可运行任务，增强项可以以后再设。' : '随时回来改任何一项，进入工作台即可开始。';
  const next = activeStep + 1;
  // Preferences are not a step: nothing comes before or after them.
  document.querySelector('.wizard-footer').hidden = activeStep === PREFERENCES;
  $('previous-step').hidden = activeStep === 0;
  $('next-step').hidden = activeStep >= LAST;
  $('next-step').disabled = !!current.busy || next > available;
  $('next-step').textContent = optional(activeStep) && !stepDone(activeStep, current) ? `跳过，下一步：${stepNames[next]} →` : `下一步：${stepNames[next]} →`;
  $('workbench').hidden = activeStep !== LAST;
  // Entering the workbench never waits for the last step: once the services run it is one click away on every step.
  $('header-workbench').hidden = !ready || activeStep === LAST;
  $('header-workbench').title = current.browserReady ? '' : 'Chrome 尚未连接：可以查看数据和报告，任务要连接后才能运行。';
  $('step-help').textContent = activeStep === 0 ? (ready ? '' : '准备完成后进入下一步。')
    : activeStep === 1 ? (current.browserReady ? '' : '确认 Chrome 后进入下一步。')
    : activeStep === 2 && editingModel ? '设置尚未保存，跳过将不使用这次的修改。'
    : optional(activeStep) ? '可跳过，之后随时从步骤清单回来设置。'
    : current.browserReady ? '示例可跳过，直接进入工作台即可开始。' : '';
}

/** One line per checklist item, so a skipped or pending setting is visible from every step. */
function stepStatus(step, state) {
  if (step === 0) return state.phase === 'ready' ? '已启动' : phaseNames[state.phase] || '等待准备';
  if (step === 1) return stepDone(1, state) ? '已连接' : state.phase === 'ready' ? '等待确认 Chrome' : '准备完成后连接';
  if (step === 2) return modelReady(state) ? modelLabel(state) : '未设置：任务卡在验证码时不会提醒';
  if (step === 3) {
    const online = onlineAssistants(state);
    return online.length ? online.map((client) => client.name).join('、') : '未接入：助手还不能使用这台电脑的浏览器';
  }
  if (step === LAST) return state.browserReady ? '可以运行示例' : 'Chrome 连接后可运行示例';
  return `页面脚本${state.allowEval === false ? '关' : '开'} · 本机脚本${state.allowLocalEval === false ? '关' : '开'}${state.allowCloudCaptcha === true ? ' · 云端识别验证码开' : ''}`;
}
const phaseNames = { waiting: '等待准备', checking: '检查中', initializing: '初始化中', starting: '启动中', registering: '检查模板', ready: '工作台已启动', failed: '准备失败' };
const services = { backend: '浏览器服务', console: '工作台', llm: '模型网关', migrate: '数据库初始化', desktop: '客户端' };

const selectedMode = () => document.querySelector('input[name="mode"]:checked').value;
const formatSize = (bytes) => `${(bytes / 1024 ** 3).toFixed(bytes >= 1024 ** 3 ? 1 : 2)} GB`;

function renderModelMode(mode) {
  const local = current.localModel || {};
  const localReady = !!local.running && !!local.hasModel;
  $('cloud-fields').hidden = mode !== 'cloud';
  $('cloud-fields').querySelectorAll('input').forEach((input) => { input.disabled = mode !== 'cloud'; });
  $('local-setup').hidden = mode !== 'local';
  $('model-hint').textContent = mode === 'skip' ? '不使用模型：任务卡在验证码时不会提醒，其他功能照常使用。'
    : mode === 'cloud' ? (current.allowCloudCaptcha === true ? '已在「权限与偏好」允许云端识别验证码：保存后，验证码截图也会发到这里填写的地址。' : '填写你自己的服务地址、模型和 API Key。')
    : localReady ? (current.modelMode === 'local' && !editingModel ? '本机模型已启用。' : '本机模型已就绪，点击下方按钮启用。') : '完成上面两项后即可启用。';
  $('model-save').textContent = mode === 'local' ? '使用本机模型' : mode === 'cloud' ? '保存云 API' : '保存：不使用模型';
  // Nothing to save when the choice is the saved one; a cloud form can still be resubmitted to change its key.
  $('model-save').hidden = !editingModel && mode === current.modelMode && mode !== 'cloud';
  $('model-save').disabled = !!current.busy || mode === 'local' && !localReady;
  if (editingModel) $('model-status').textContent = `未保存 · ${({ local: '本机模型', cloud: '云 API', skip: '暂不设置' })[mode]}`;
  renderLocalModel(local);
}

/** The two things a local model needs, each with the one action that moves it forward. */
function renderLocalModel(local) {
  const pull = local.pull;
  const ollamaDone = !!local.running;
  $('check-ollama').classList.toggle('complete', ollamaDone);
  $('check-ollama').querySelector('.check-dot').textContent = ollamaDone ? '✓' : '1';
  $('ollama-state').textContent = !local.checked ? '正在检测…'
    : local.running ? `已安装并在运行${local.version && local.version !== 'unknown' ? `（版本 ${local.version}）` : ''}。`
    : local.installed ? '已安装，但还没有运行。点击启动，或从开始菜单打开 Ollama。'
    : '这台电脑还没有 Ollama。下载安装后回到这里，会自动检测到。';
  $('ollama-download').hidden = !local.checked || local.installed;
  $('ollama-start').hidden = !local.installed || local.running || !local.executable;
  const modelDone = !!local.hasModel;
  $('check-model').classList.toggle('complete', modelDone);
  $('check-model').querySelector('.check-dot').textContent = modelDone ? '✓' : '2';
  const downloading = pull?.status === 'running';
  $('pull-progress').hidden = !downloading;
  if (downloading) { $('pull-progress').max = pull.total || 1; $('pull-progress').value = pull.completed || 0; }
  $('pull-state').textContent = modelDone ? '已下载。'
    : downloading ? (pull.total ? `正在下载 ${formatSize(pull.completed)} / ${formatSize(pull.total)}（${Math.floor(pull.completed / pull.total * 100)}%），可以先去做别的步骤。` : '正在连接下载源…')
    : pull?.status === 'failed' ? `下载没有完成：${pull.error}。点击重新下载，已下载的部分会保留。`
    : local.running ? '约 3.4 GB，下载时显示实际大小。只在你点击后开始下载。' : '先完成第 1 项。';
  $('pull-start').hidden = modelDone || downloading;
  $('pull-start').disabled = !local.running;
  $('pull-start').textContent = pull?.status === 'failed' ? '重新下载' : '下载模型';
  $('pull-cancel').hidden = !downloading;
  $('local-redetect-row').hidden = !!local.running;
}

let localCheck;
/** Re-checks Ollama while the local option is open and not finished, so installing it in another window is noticed. */
async function refreshLocalModel() {
  if (!bridge || localCheck) return;
  localCheck = action('detectLocalModel', undefined, true);
  try { await localCheck; } finally { localCheck = undefined; }
}
function renderPreparation(state) {
  const completed = state.preparationStep ?? ({ checking: 0, initializing: 1, starting: 2, registering: 3, ready: 4 }[state.phase] || 0);
  $('prepare-progress').value = completed;
  $('prepare-count').textContent = `${completed} / 4`;
  $('prepare-title').textContent = state.phase === 'ready' ? '工作台准备完成' : state.phase === 'failed' ? '准备已停止' : state.busy ? '正在准备工作台' : '等待开始准备';
  $('preparation-progress').classList.toggle('failed', state.phase === 'failed');
  [...$('prepare-stages').children].forEach((item, index) => {
    item.classList.toggle('complete', index < completed);
    item.classList.toggle('active', index === completed && !!state.busy && state.phase !== 'failed');
    if (index === completed && state.busy && state.phase !== 'failed') item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
  $('prepare-next').textContent = state.phase === 'ready'
    ? state.browserReady ? 'Chrome 已连接，可进入工作台。' : '下一步：连接 Chrome。'
    : state.phase === 'failed' ? '准备已停止，可重试或查看诊断。' : state.detail || '点击准备工作台，开始检查本地环境。';
}

function renderClock() {
  const state = current;
  const elapsed = Math.max(0, Math.floor((Date.now() - (state.phaseStartedAt || Date.now())) / 1000));
  $('prepare-elapsed').hidden = !state.busy && state.phase !== 'failed';
  $('prepare-elapsed').textContent = state.phase === 'failed'
    ? '准备已停止，请查看上方错误及下方日志；修复后可点击“重试准备”。'
    : `已等待 ${elapsed} 秒${state.phase === 'initializing' ? ' · 初始化最长 120 秒' : ''}`;
}

function modelLabel(state) {
  if (state.modelMode === 'local') return state.localModel?.configured ? `本机 · ${state.localModel.model}` : '等待配置';
  if (state.modelMode === 'cloud') return state.modelConfigured ? `云 API · ${state.model || ''}` : '等待配置';
  return '未设置';
}

function render(state) {
  const previousPhase = current.phase;
  const previouslyConnected = current.browserReady;
  if (current.generation !== state.generation || current.phase !== state.phase || current.browserId !== state.browserId || current.browserReady !== state.browserReady) {
    mcpCheckGeneration++;
    checkingMcp = false;
    $('agent-check-result').textContent = '';
  }
  current = state;
  const resuming = state.setupCompleted && state.busy && !['ready', 'failed'].includes(state.phase);
  document.querySelector('.sidebar').hidden = !!resuming;
  $('environment-title').textContent = resuming ? '正在恢复工作台' : '准备工作台';
  $('overall').textContent = state.phase === 'ready' && !state.browserReady ? '下一步 · 连接 Chrome' : phaseNames[state.phase] || '等待准备';
  $('overall').classList.toggle('ok', state.phase === 'ready');
  if (state.phase === 'failed') { $('error').textContent = state.detail || '工作台准备失败，请查看日志。'; $('error').hidden = false; }
  else if (previousPhase === 'failed') $('error').hidden = true;
  $('prepare').disabled = !!state.busy;
  $('prepare').classList.toggle('secondary', state.phase === 'ready');
  $('prepare').textContent = state.phase === 'failed' ? '重试准备' : state.phase === 'ready' ? '恢复本地服务' : '准备工作台';
  $('browser-status').textContent = state.browserReady ? '已确认连接' : state.browserId ? '所选浏览器离线' : '等待确认';
  $('browser-status').classList.toggle('ok', !!state.browserReady);
  const browsers = (state.browsers || []).filter((b) => b.kind === 'chrome' && b.ready);
  const selection = $('browser-select').value || state.browserId;
  $('browser-select').replaceChildren(...(browsers.length ? browsers.map((browser, index) => {
    const option = document.createElement('option'); option.value = browser.instanceId; option.title = browser.instanceId;
    option.textContent = browsers.length === 1 ? 'Chrome（已连接）' : `Chrome ${index + 1}${browser.connectedAt ? ` · 连接于 ${new Date(browser.connectedAt).toLocaleTimeString()}` : ''}`;
    return option;
  }) : [new Option('尚无已连接浏览器', '')]));
  if (browsers.some((b) => b.instanceId === selection)) $('browser-select').value = selection;
  $('select-browser').disabled = !!state.busy || browsers.length === 0;
  if (!previouslyConnected && state.browserReady) $('install-guide').open = false;
  $('bridge-repair').hidden = !state.bridgeError;
  $('bridge-status').textContent = state.bridgeError || '';
  $('repair-bridge').disabled = !!state.bridgeBusy || !!state.busy;
  $('model-status').textContent = modelLabel(state);
  $('model-status').classList.toggle('ok', modelReady(state));
  $('model-status').title = $('model-status').textContent;
  if (!editingModel) {
    const mode = ['cloud', 'local'].includes(state.modelMode) ? state.modelMode : 'skip';
    document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
    renderModelMode(mode);
    if (state.modelConfigured) { $('api-model').value = state.model || ''; $('api-url').value = state.modelUrl || ''; }
  } else {
    renderModelMode(selectedMode());
  }
  $('demo').disabled = !!state.busy || !state.browserReady || state.phase !== 'ready';
  document.querySelectorAll('[data-action="workbench"]').forEach((button) => { button.disabled = !!state.busy || state.phase !== 'ready'; });
  $('agent-check').disabled = checkingMcp || !!state.busy || !state.browserReady || state.phase !== 'ready';
  $('agent-status').textContent = state.phase === 'ready' && state.browserReady ? '可接入助手' : '请先准备并连接浏览器';
  const connections = state.connections;
  const assistants = connections?.assistants || [];
  const online = onlineAssistants(state);
  const summary = [
    ['本地服务', connections?.serviceReady ? '已就绪' : '未就绪'],
    ['Chrome', state.browserReady ? `已确认 · ${(state.browserId || '').slice(0, 8)}` : '未确认连接'],
    ['MCP 助手', online.length ? online.map((client) => `${client.name}${client.toolCount ? ` · ${client.toolCount} 工具` : ' · 已握手'}`).join('、') : assistants.some((client) => client.state === 'connecting') ? '正在握手' : '尚无助手连接'],
  ];
  $('connection-summary').replaceChildren(...summary.flatMap(([label, value]) => { const term = document.createElement('dt'); term.textContent = label; const detail = document.createElement('dd'); detail.textContent = value; return [term, detail]; }));
  const connectionError = connections?.lastError;
  $('connection-error').hidden = !connectionError;
  $('connection-error').textContent = connectionError || '';
  $('directory').textContent = state.dataDirectory || '';
  $('allow-eval').checked = state.allowEval !== false;
  $('allow-local-eval').checked = state.allowLocalEval !== false;
  $('allow-cloud-captcha').checked = state.allowCloudCaptcha === true;
  // Say where the screenshot would go, so the switch is never flipped blind.
  $('cloud-captcha-target').textContent = state.modelMode === 'local' ? '当前用的是本机模型，截图不会离开这台电脑。'
    : state.modelMode === 'cloud' && state.modelConfigured ? `开启后截图会发到：${state.modelUrl}（模型 ${state.model}）`
    : '当前没有启用云 API：开启后也没有可用的模型，验证码提醒仍不生效。';
  $('screenshot-dir-value').textContent = `截图保存位置：${state.screenshotDir || '系统临时目录'}（另可随时写入系统临时目录）`;
  $('screenshot-dir-clear').hidden = !state.screenshotDir;
  $('logs').textContent = (state.logs || []).map((entry) => `${entry.time ? new Date(entry.time).toLocaleTimeString() : ''} [${services[entry.service] || entry.service}] ${entry.text}`).join('\n') || '尚无准备日志。';
  $('log-location').textContent = state.logError || (state.logFile ? `日志文件：${state.logFile}` : '准备日志会显示在这里。');
  if (displayedPhase !== state.phase && state.phase === 'failed') { $('preparation-log').open = true; activeStep = 0; }
  else if (displayedPhase === 'failed' && state.phase !== 'failed') $('preparation-log').open = false;
  $('log-summary').textContent = state.phase === 'failed' ? '失败原因与诊断日志' : '诊断日志';
  displayedPhase = state.phase;
  renderPreparation(state);
  renderClock();
  const run = state.demo;
  $('demo-progress').hidden = !run;
  $('result').hidden = !run || ['pending', 'running'].includes(run.status);
  if (run) {
    $('demo-status').textContent = ({ running: '运行中', pending: '等待运行', success: '体验完成', failed: '运行失败', escalated: '需要处理' })[run.status] || run.status;
    $('progress').max = run.totalSteps || 2;
    $('progress').value = run.ranSteps || 0;
    $('current-goal').textContent = run.currentGoal || (run.status === 'success' ? '已读取示例商品清单。' : run.error || '请查看任务结果。');
    let content = run.content;
    if (content?.raw) { try { content = JSON.parse(content.raw); } catch { content = { text: content.raw }; } }
    $('result').textContent = run.error || content?.value?.text || content?.text || (run.status === 'success' ? '读取完成。你可以查看示例窗口中的商品清单。' : '任务需要处理，请查看当前步骤。');
  }
  if (!stepInitialized) {
    stepInitialized = true;
    // Without a remembered step, open on the first one still to do rather than on a finished one.
    const saved = Number(sessionStorage.getItem('setupStep') ?? NaN);
    activeStep = Number.isInteger(saved) && saved >= 0 && saved <= PREFERENCES ? saved
      : state.phase !== 'ready' ? 0 : !state.browserReady ? 1 : state.setupCompleted ? LAST : 2;
  }
  if (state.setupCompleted && state.phase === 'ready' && previousPhase !== 'ready' && activeStep === 0) activeStep = state.browserReady ? LAST : 1;
  // Confirming (or auto-confirming) the browser moves on to the next step in line; a page reload keeps the remembered step.
  if (previousPhase && !previouslyConnected && state.browserReady && activeStep === 1) activeStep = state.setupCompleted ? LAST : 2;
  if (state.openPanel === 'agents') activeStep = 3;
  if (!canOpen(activeStep, state)) activeStep = Math.min(activeStep, reachable(state));
  renderWizard();
}

async function action(name, input, background = name === 'state') {
  // Background checks must not clear an error the user has not read yet.
  if (!background) $('error').hidden = true;
  try {
    if (!bridge) throw new Error('此页面需要在 Electron 客户端内打开。');
    const result = await bridge.action(name, input);
    if (result?.phase) render(result);
    else if (typeof result === 'string' && result) throw new Error(result);
    return true;
  } catch (error) { $('error').textContent = error.message; $('error').hidden = false; return false; }
}
document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => void action(button.dataset.action, button.dataset.input)));
$('select-browser').addEventListener('click', () => void action('selectBrowser', $('browser-select').value));
$('extension-copy').addEventListener('click', async () => {
  $('extension-copy-status').textContent = '';
  try {
    if (!bridge) throw new Error('此页面需要在 Electron 客户端内打开。');
    const folder = await bridge.action('copyExtensionFolder');
    $('extension-copy-status').textContent = `已复制：${folder}`;
  } catch (error) { $('extension-copy-status').textContent = error.message; }
});
$('chrome-shortcut').addEventListener('click', async () => {
  $('error').hidden = true;
  try {
    if (!bridge) throw new Error('此页面需要在 Electron 客户端内打开。');
    const { shortcut } = await bridge.action('chromeShortcut');
    $('chrome-shortcut-status').textContent = `已创建：${shortcut}`;
  } catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
});
document.querySelectorAll('[data-step-target]').forEach((button) => button.addEventListener('click', () => showStep(Number(button.dataset.stepTarget))));
$('previous-step').addEventListener('click', () => showStep(activeStep - 1));
$('next-step').addEventListener('click', () => {
  // Skipping drops an unsaved model edit, as the help line says; the saved setting stays.
  if (activeStep === 2 && editingModel) { editingModel = false; render(current); }
  showStep(activeStep + 1);
});
document.querySelectorAll('input[name="mode"]').forEach((radio) => radio.addEventListener('change', () => {
  editingModel = true;
  renderModelMode(selectedMode());
  renderWizard();
  if (selectedMode() === 'local') void refreshLocalModel();
}));
$('model-form').addEventListener('input', () => { editingModel = true; renderModelMode(selectedMode()); renderWizard(); });
$('model-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = { mode: selectedMode(), url: $('api-url').value, model: $('api-model').value, key: $('api-key').value };
  $('api-key').value = '';
  void action('saveModel', input).then((saved) => { if (saved) { editingModel = false; render(current); if (current.phase !== 'ready') showStep(0); } });
});
$('local-redetect').addEventListener('click', () => void refreshLocalModel());
$('ollama-start').addEventListener('click', () => void action('startLocalModel'));
$('pull-start').addEventListener('click', () => void action('pullLocalModel'));
$('pull-cancel').addEventListener('click', () => void action('cancelLocalPull'));
let guideGeneration = 0;
async function loadAgentGuide() {
  const generation = ++guideGeneration;
  try {
    const guide = await bridge.action('agentGuide', $('agent-select').value);
    if (generation !== guideGeneration) return;
    $('agent-config').textContent = guide.config;
    $('agent-command').textContent = `程序：${guide.executable}　参数：${JSON.stringify(guide.args)}`;
    $('agent-steps').replaceChildren(...guide.steps.map((step) => { const item = document.createElement('li'); item.textContent = step; return item; }));
    $('agent-download').hidden = !guide.download;
    $('agent-check-result').textContent = '';
  } catch (error) { $('agent-config').textContent = `配置生成失败：${error.message}`; }
}
$('agent-select').addEventListener('change', () => void loadAgentGuide());
for (const [id, name] of [['agent-copy', 'copyAgentConfig'], ['agent-docs', 'agentDocs'], ['agent-download', 'agentDownload']]) {
  $(id).addEventListener('click', async () => {
    try {
      await bridge.action(name, $('agent-select').value);
      if (id === 'agent-copy') $('agent-check-result').textContent = '配置已复制。请合并到助手设置中，保留其他服务器。';
    } catch (error) { $('agent-check-result').textContent = error.message; }
  });
}
// Assistants found on this computer. Nothing is connected until the user ticks it and asks; each row then shows
// its own outcome, since one assistant failing says nothing about the others.
const agentAction = {
  link: (name) => `打开 ${name} 的安装确认，由 ${name} 询问后添加`,
  cli: (name) => `用 ${name} 自己的命令加入它的用户配置`,
  config: (name) => `合并写入 ${name} 的配置文件，写入前备份原文件`,
};
let agents = [];
let agentDetectError = '';
let connectingAgents = false;
const selectedAgents = new Set();
const agentOutcomes = new Map();
function renderAgents() {
  $('agent-list').replaceChildren(...agents.map((agent) => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = agent.client;
    box.disabled = !agent.detected || !!agent.blocked || connectingAgents;
    box.checked = agent.detected && selectedAgents.has(agent.client);
    box.addEventListener('change', () => {
      if (box.checked) selectedAgents.add(agent.client); else selectedAgents.delete(agent.client);
      $('agent-connect').disabled = connectingAgents || !selectedAgents.size;
    });
    const title = document.createElement('strong');
    title.textContent = agent.name;
    const how = document.createElement('small');
    how.textContent = agent.blocked || (agent.detected ? `${agentAction[agent.via](agent.name)}（${agent.where}）` : '未检测到');
    const text = document.createElement('span');
    text.append(title, how);
    const outcome = agentOutcomes.get(agent.client);
    if (outcome) {
      const line = document.createElement('small');
      line.className = outcome.ok ? 'agent-outcome' : 'agent-outcome failed';
      line.textContent = outcome.message;
      text.append(line);
    }
    const label = document.createElement('label');
    label.append(box, text);
    const item = document.createElement('li');
    item.append(label);
    return item;
  }));
  const found = agents.filter((agent) => agent.detected && !agent.blocked).map((agent) => agent.name);
  $('agent-summary').textContent = agentDetectError ? `检测助手失败：${agentDetectError}。可以点击重新检测，或在下方复制配置手动接入。`
    : found.length ? `检测到 ${found.join('、')}，勾选后即可接入。` : '没有检测到常用助手，也可以复制配置手动接入其他助手。';
  $('agent-connect').disabled = connectingAgents || !selectedAgents.size;
}
async function loadAgents() {
  try {
    agents = await bridge.action('detectAgents');
    agentDetectError = '';
    for (const client of selectedAgents) if (!agents.some((agent) => agent.client === client && agent.detected && !agent.blocked)) selectedAgents.delete(client);
  } catch (error) { agentDetectError = error.message; $('agent-connect-result').textContent = `检测助手失败：${error.message}`; }
  renderAgents();
}
$('agent-redetect').addEventListener('click', () => void loadAgents());
$('agent-connect').addEventListener('click', async () => {
  connectingAgents = true;
  $('agent-connect-result').textContent = '正在接入所选助手…';
  renderAgents();
  try {
    const results = await bridge.action('connectAgents', [...selectedAgents]);
    for (const result of results) agentOutcomes.set(result.client, result);
    const failed = results.filter((result) => !result.ok).length;
    selectedAgents.clear();
    $('agent-connect-result').textContent = failed
      ? `${failed} 个助手没有接入成功，原因见对应条目。`
      : '已处理所选助手，按条目里的提示完成即可。助手连上后，上方实时连接状态会显示它的名字。';
  } catch (error) { $('agent-connect-result').textContent = error.message; }
  finally { connectingAgents = false; renderAgents(); }
});
$('allow-eval').addEventListener('change', () => void action('policy', { allowEval: $('allow-eval').checked }));
$('allow-local-eval').addEventListener('change', () => void action('policy', { allowLocalEval: $('allow-local-eval').checked }));
$('allow-cloud-captcha').addEventListener('change', () => void action('policy', { allowCloudCaptcha: $('allow-cloud-captcha').checked }));
$('screenshot-dir').addEventListener('click', () => void action('chooseScreenshotDir'));
$('screenshot-dir-clear').addEventListener('click', () => void action('policy', { screenshotDir: null }));
$('autostart').addEventListener('change', async () => {
  const wanted = $('autostart').checked;
  try { $('autostart').checked = await bridge.action('autostart', wanted) === true; }
  catch (error) { $('autostart').checked = !wanted; $('error').textContent = error.message; $('error').hidden = false; }
});
$('agent-check').addEventListener('click', async () => {
  if (checkingMcp) return;
  checkingMcp = true;
  const generation = ++mcpCheckGeneration;
  $('agent-check').disabled = true;
  $('agent-check-result').textContent = '正在启动 stdio 进程，检查握手与工具列表…';
  try {
    const result = await bridge.action('checkMcp');
    if (generation !== mcpCheckGeneration) return;
    $('agent-check-result').textContent = `启动链路已通过，提供 ${result.toolCount} 个工具。上方实时状态显示助手是否实际连接；自检不会连接你的助手或操作浏览器。`;
  } catch (error) { if (generation === mcpCheckGeneration) $('agent-check-result').textContent = `连接检查失败：${error.message}`; }
  finally {
    if (generation === mcpCheckGeneration) {
      checkingMcp = false;
      $('agent-check').disabled = !!current.busy || !current.browserReady || current.phase !== 'ready';
    }
  }
});
bridge?.subscribe(render);
setInterval(renderClock, 1000);
if (!bridge) void action('state');
else {
  void loadAgentGuide();
  void loadAgents();
  void bridge.action('autostartState').then((enabled) => { $('autostart').checked = enabled === true; }, () => { $('autostart').disabled = true; });
  void action('state');
  setInterval(() => { if (!document.hidden && !current.busy) void action('state'); }, 2500);
  setInterval(() => {
    const local = current.localModel || {};
    const pending = !(local.running && local.hasModel) && local.pull?.status !== 'running';
    if (!document.hidden && activeStep === 2 && selectedMode() === 'local' && pending) void refreshLocalModel();
  }, 3000);
}
