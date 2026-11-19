const bridge = window.desktop;
const $ = (id) => document.getElementById(id);
let current = {};
let editingModel = false;
let displayedPhase;
let checkingMcp = false;
let mcpCheckGeneration = 0;
let activeStep = 0;
let returnStep = 0;
let stepInitialized = false;
const stepIds = ['environment', 'browser', 'model', 'experience', 'agents'];
const primarySteps = [0, 1, 3];
const optional = (step) => step === 2 || step === 4;

function showStep(index, focus = true) {
  activeStep = Math.max(0, Math.min(4, index));
  const available = current.phase === 'ready' ? current.browserReady ? 3 : 1 : 0;
  if (!optional(activeStep) && activeStep > available) activeStep = available;
  if (!optional(activeStep)) returnStep = activeStep;
  sessionStorage.setItem('setupStep', String(activeStep));
  renderWizard();
  if (focus) $(stepIds[activeStep]).querySelector('h2').focus({ preventScroll: true });
}

function renderWizard() {
  const ready = current.phase === 'ready';
  const available = ready ? current.browserReady ? 3 : 1 : 0;
  const done = { 0: ready, 1: ready && current.browserReady };
  stepIds.forEach((id, index) => { $(id).hidden = index !== activeStep; });
  document.querySelectorAll('.stepper [data-step-target]').forEach((button, index) => {
    const step = Number(button.dataset.stepTarget);
    button.disabled = step > available;
    button.classList.toggle('complete', !!done[step] && step !== activeStep);
    button.querySelector('.step-dot').textContent = done[step] && step !== activeStep ? '✓' : index + 1;
    if (step === (optional(activeStep) ? returnStep : activeStep)) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.setup-tools [data-step-target]').forEach((button) => {
    button.disabled = Number(button.dataset.stepTarget) === 2 && !!current.busy;
    button.setAttribute('aria-pressed', String(Number(button.dataset.stepTarget) === activeStep));
  });
  $('previous-step').disabled = activeStep === 0;
  $('previous-step').textContent = optional(activeStep) ? '← 返回' : '← 上一步';
  $('next-step').hidden = optional(activeStep) || activeStep === 3;
  $('workbench').hidden = activeStep !== 3;
  $('next-step').disabled = !!current.busy || activeStep === 0 && !ready || activeStep === 1 && !current.browserReady;
  $('next-step').textContent = activeStep === 0 ? '连接浏览器 →' : '开始使用 →';
  $('step-help').textContent = activeStep === 2 && editingModel ? '配置尚未保存' : activeStep === 3 ? '示例可跳过，随时进入工作台。' : '';
  $('model-summary').textContent = current.modelMode === 'cloud' ? '云 API' : '未启用';
}
const phaseNames = { waiting: '等待准备', checking: '检查中', initializing: '初始化中', starting: '启动中', registering: '检查模板', ready: '工作台已启动', failed: '准备失败' };
const services = { backend: '浏览器服务', console: '工作台', llm: '云 API 网关', migrate: '数据库初始化', desktop: '客户端' };

function renderModelMode(mode) {
  const skip = mode === 'skip';
  $('cloud-fields').hidden = skip;
  $('cloud-fields').querySelectorAll('input').forEach((input) => { input.disabled = skip; });
  $('model-hint').textContent = skip
    ? '不使用模型，直接运行基础模板。'
    : '填写你自己的服务地址、模型和 API Key。';
  if (editingModel) $('model-status').textContent = `未保存 · ${skip ? '稍后设置' : '云 API'}`;
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
  document.querySelector('.stepper').hidden = !!resuming;
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
  $('model-status').textContent = state.modelMode === 'cloud' ? state.modelConfigured ? `云 API · ${state.model || ''}` : '等待配置' : '未启用';
  $('model-status').title = $('model-status').textContent;
  if (!editingModel) {
    const mode = state.modelMode === 'cloud' ? 'cloud' : 'skip';
    document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
    renderModelMode(mode);
    if (state.modelConfigured) { $('api-model').value = state.model || ''; $('api-url').value = state.modelUrl || ''; }
  } else {
    renderModelMode(document.querySelector('input[name="mode"]:checked').value);
  }
  $('demo').disabled = !!state.busy || !state.browserReady || state.phase !== 'ready';
  document.querySelectorAll('[data-action="workbench"]').forEach((button) => { button.disabled = !!state.busy || !state.browserReady || state.phase !== 'ready'; });
  $('agent-check').disabled = checkingMcp || !!state.busy || !state.browserReady || state.phase !== 'ready';
  $('agent-status').textContent = state.phase === 'ready' && state.browserReady ? '可接入助手' : '请先准备并连接浏览器';
  const connections = state.connections;
  const assistants = connections?.assistants || [];
  const online = assistants.filter((client) => client.state === 'connected');
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
    const saved = Number(sessionStorage.getItem('setupStep') || 0);
    activeStep = Number.isInteger(saved) && saved >= 0 && saved <= 4 ? saved : 0;
  }
  const available = state.phase === 'ready' ? state.browserReady ? 3 : 1 : 0;
  if (!optional(activeStep) && activeStep > available) activeStep = available;
  if (state.setupCompleted && state.phase === 'ready' && previousPhase !== 'ready' && activeStep === 0) activeStep = state.browserReady ? 3 : 1;
  // Confirming (or auto-confirming) the browser moves straight on; a page reload keeps the remembered step.
  if (previousPhase && !previouslyConnected && state.browserReady && activeStep === 1) activeStep = 3;
  if (!optional(activeStep)) returnStep = activeStep;
  if (state.openPanel === 'agents') activeStep = 4;
  renderWizard();
}

async function action(name, input) {
  if (name !== 'state') $('error').hidden = true;
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
$('chrome-shortcut').addEventListener('click', async () => {
  $('error').hidden = true;
  try {
    if (!bridge) throw new Error('此页面需要在 Electron 客户端内打开。');
    const { shortcut } = await bridge.action('chromeShortcut');
    $('chrome-shortcut-status').textContent = `已创建：${shortcut}`;
  } catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
});
document.querySelectorAll('[data-step-target]').forEach((button) => button.addEventListener('click', () => showStep(Number(button.dataset.stepTarget))));
$('previous-step').addEventListener('click', () => showStep(optional(activeStep) ? returnStep : primarySteps[Math.max(0, primarySteps.indexOf(activeStep) - 1)]));
$('next-step').addEventListener('click', () => showStep(primarySteps[primarySteps.indexOf(activeStep) + 1] ?? 3));
document.querySelectorAll('input[name="mode"]').forEach((radio) => radio.addEventListener('change', () => {
  editingModel = true;
  renderModelMode(document.querySelector('input[name="mode"]:checked').value);
  renderWizard();
}));
$('cloud-form').addEventListener('input', () => { editingModel = true; renderModelMode(document.querySelector('input[name="mode"]:checked').value); renderWizard(); });
$('cloud-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = { mode: document.querySelector('input[name="mode"]:checked').value, url: $('api-url').value, model: $('api-model').value, key: $('api-key').value };
  $('api-key').value = '';
  void action('saveModel', input).then((saved) => { if (saved) { editingModel = false; render(current); if (current.phase !== 'ready') showStep(0); } });
});
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
  $('agent-summary').textContent = agentDetectError ? `检测助手失败：${agentDetectError}。可以在接入面板重新检测，或复制配置手动接入。`
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
}
