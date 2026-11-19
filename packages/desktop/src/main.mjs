import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, session, utilityProcess, safeStorage, dialog } from 'electron';
import { chromeShortcutSpec, macChromeLauncher, writeMacChromeLauncher } from './chrome-shortcut.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork as forkNode } from 'node:child_process';
import { Coordinator } from './coordinator.mjs';
import { applicationPaths } from './paths.mjs';
import { agentSetup, checkMcpStdio, connectAgent, detectAgents } from './agent-setup.mjs';
import { createShellControls } from './shell-controls.mjs';
import { OLLAMA_DOWNLOAD } from './local-model.mjs';

if (process.argv.includes('--mcp-stdio')) {
  app.whenReady().then(async () => {
    const { runMcpBridge } = await import('./mcp-bridge.mjs');
    await runMcpBridge(join(app.getPath('appData'), 'UltraGoDesktop', 'runtime.json'));
  }).catch((error) => { process.stderr.write(`${error.message}\n`); app.quit(); });
} else {
app.setName('UltraGoDesktop');
if (process.platform === 'win32') app.setAppUserModelId('com.ultrago.desktop');
app.setPath('userData', join(app.getPath('appData'), 'UltraGoDesktop'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window;
  let coordinator;
  let polling;
  let shellControls;
  let tray;
  let trayNoticeShown = false;
  let closing = false;
  let cleanupComplete = false;
  let resumePending = false;
  // Windows login items are matched by their arguments; this one also marks a launch that starts in the tray.
  const LOGIN_ARGS = ['--launch-at-login'];
  // openAtLogin ignores the Task Manager / Settings switch; executableWillLaunchAtLogin honours it. That property and
  // login arguments exist only on Windows: macOS reports the login item itself and whether this launch came from it.
  const mac = process.platform === 'darwin';
  const launchesAtLogin = () => { const item = app.getLoginItemSettings({ args: LOGIN_ARGS }); return item.openAtLogin && (mac || item.executableWillLaunchAtLogin); };
  // On macOS this is read once the app is ready, below.
  let launchedAtLogin = !mac && process.argv.includes(LOGIN_ARGS[0]);
  let hiddenSinceLogin = launchedAtLogin;
  const setupUrl = new URL('../ui/index.html', import.meta.url);
  const showSetup = () => { resumePending = false; return window.loadURL(setupUrl.href); };
  const showWindow = () => {
    if (closing || !window || window.isDestroyed()) return;
    hiddenSinceLogin = false;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  };
  const hideToTray = () => {
    if (closing || !tray || tray.isDestroyed()) return;
    window.hide();
    if (process.platform === 'win32' && !trayNoticeShown) {
      trayNoticeShown = true;
      try { tray.displayBalloon({ title: 'UltraGo 已收起到托盘', content: '已启动的本地服务和 MCP 将继续运行。单击托盘图标打开窗口，右键菜单可退出应用。', noSound: true }); }
      catch (error) { process.stderr.write(`托盘提示未显示：${error.message}\n`); }
    }
  };
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);

  app.whenReady().then(async () => {
    if (mac) hiddenSinceLogin = launchedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin === true;
    Menu.setApplicationMenu(null);
    const iconPath = app.isPackaged ? join(process.resourcesPath, 'branding/app-icon.png') : fileURLToPath(new URL('../ui/app-icon.png', import.meta.url));
    window = new BrowserWindow({
      title: 'UltraGo · 内测版', width: 1140, height: 820, minWidth: 780, minHeight: 640, show: !launchedAtLogin,
      icon: iconPath,
      backgroundColor: '#f6f7fb',
      webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    window.setMenu(null);
    const zoom = (delta) => window.webContents.setZoomFactor(Math.max(.5, Math.min(2, window.webContents.getZoomFactor() + delta)));
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || (!input.control && !input.meta) || input.alt) return;
      const key = input.key.toLowerCase();
      const commands = {
        a: () => window.webContents.selectAll(), c: () => window.webContents.copy(), x: () => window.webContents.cut(),
        v: () => window.webContents.paste(), z: () => input.shift ? window.webContents.redo() : window.webContents.undo(), y: () => window.webContents.redo(),
        '+': () => zoom(.1), '=': () => zoom(.1), '-': () => zoom(-.1), '0': () => window.webContents.setZoomFactor(1),
      };
      if (Object.hasOwn(commands, key)) { event.preventDefault(); commands[key](); }
    });
    try {
      const image = nativeImage.createFromPath(iconPath);
      if (image.isEmpty()) throw new Error('托盘图标无法读取');
      const smallIcon = image.resize({ width: 16, height: 16 });
      smallIcon.addRepresentation({ scaleFactor: 2, buffer: image.resize({ width: 32, height: 32 }).toPNG() });
      tray = new Tray(smallIcon);
      tray.setToolTip('UltraGo · 单击打开，右键退出');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开主窗口', click: showWindow },
        { type: 'separator' },
        { label: '退出应用（停止本地服务）', click: () => app.quit() },
      ]));
      tray.on('click', showWindow);
      tray.on('double-click', showWindow);
      tray.on('balloon-click', showWindow);
    } catch (error) {
      tray?.destroy(); tray = undefined;
      process.stderr.write(`系统托盘不可用，将保留普通窗口行为：${error.message}\n`);
    }
    window.on('minimize', hideToTray);
    window.on('close', (event) => {
      if (closing || !tray || tray.isDestroyed()) return;
      event.preventDefault(); hideToTray();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== setupUrl.href && (!coordinator?.ingress || new URL(url).origin !== coordinator.ingress.origin)) event.preventDefault();
    });
    let actions;
    let initializationError;
    let finishInitialization;
    const initialized = new Promise((resolve) => { finishInitialization = resolve; });
    ipcMain.handle('desktop:action', async (event, name, input) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== setupUrl.href) throw new Error('操作来源无效');
      await initialized;
      if (initializationError) throw initializationError;
      if (!Object.hasOwn(actions, name)) throw new Error('操作来源无效');
      return actions[name](input);
    });
    shellControls = await createShellControls(window, {
      setup: showSetup,
      workbench: async () => { await initialized; if (initializationError) throw initializationError; return actions.workbench(); },
      tray: () => { if (!tray || tray.isDestroyed()) throw new Error('系统托盘不可用，请使用窗口最小化。'); hideToTray(); },
      quit: () => app.quit(), zoomIn: () => zoom(.1), zoomOut: () => zoom(-.1), zoomReset: () => window.webContents.setZoomFactor(1),
      canTray: () => !!tray && !tray.isDestroyed(),
      canWorkbench: () => coordinator?.phase === 'ready',
      savePosition: async (position) => { await initialized; if (initializationError) throw initializationError; return coordinator.saveShellPosition(position); },
    }, setupUrl.href);
    await showSetup();
    try {
      const paths = applicationPaths(app.getPath('userData'), process.resourcesPath, app.isPackaged);
      coordinator = new Coordinator({ paths, fork: utilityProcess.fork, safeStorage,
        openConnections: async () => { await showSetup(); window.webContents.send('desktop:state', { ...coordinator.snapshot(), openPanel: 'agents' }); },
        forkJob: (entry, args, options) => forkNode(entry, args, {
          ...options, execPath: process.execPath,
          execArgv: ['--require', fileURLToPath(new URL('./job-guard.cjs', import.meta.url))],
          env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        }),
      });
      await coordinator.load();
      shellControls.restorePosition(coordinator.settings.shellPosition);
      resumePending = !!coordinator.settings.setupCompleted;
      // A login launch stays in the tray only when there is a tray and nothing left to set up.
      if (launchedAtLogin && !(tray && resumePending)) showWindow();
      coordinator.on('change', () => {
        shellControls?.update();
        if (!window.isDestroyed()) window.setTitle(`UltraGo · ${coordinator.snapshot().browserReady ? '已连接' : coordinator.phase === 'ready' ? '等待浏览器连接' : '准备与连接'}`);
        if (!window.isDestroyed() && window.webContents.getURL() === setupUrl.href) window.webContents.send('desktop:state', coordinator.snapshot());
        else if (!window.isDestroyed() && coordinator.phase === 'failed') void showSetup().catch((error) => process.stderr.write(`准备页打开失败：${error.message}\n`));
        // A restore that fails right after a login launch must not stay invisible in the tray.
        if (hiddenSinceLogin && coordinator.phase === 'failed') showWindow();
      });
      session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        if (new URL(details.url).origin === coordinator.ingress.origin && details.webContentsId === window.webContents.id) {
          details.requestHeaders.Authorization = `Bearer ${coordinator.token}`;
        }
        callback({ requestHeaders: details.requestHeaders });
      });
      const guide = (client = 'generic') => agentSetup(client, app.isPackaged ? paths.native : process.execPath, app.isPackaged ? ['--mcp-stdio'] : [app.getAppPath(), '--mcp-stdio']);
      actions = {
        state: () => coordinator.refreshBrowsers(),
        prepare: async () => { await coordinator.prepare(); return coordinator.snapshot(); },
        selectBrowser: async (input) => { await coordinator.chooseBrowser(input); return coordinator.snapshot(); },
        saveModel: async (input) => { await coordinator.saveModel(input); return coordinator.snapshot(); },
        detectLocalModel: async () => { await coordinator.detectLocalModel(); return coordinator.snapshot(); },
        startLocalModel: async () => { await coordinator.startLocalModel(); return coordinator.snapshot(); },
        pullLocalModel: async () => { await coordinator.pullLocalModel(); return coordinator.snapshot(); },
        cancelLocalPull: () => { coordinator.cancelLocalPull(); return coordinator.snapshot(); },
        ollamaDownload: () => shell.openExternal(OLLAMA_DOWNLOAD),
        demo: async () => { await coordinator.runDemo(); return coordinator.snapshot(); },
        repairBridge: async () => { await coordinator.prepareBridge(); return coordinator.snapshot(); },
        extensionFolder: () => shell.openPath(paths.extension),
        // Chrome's “加载已解压的扩展程序” dialog needs the folder typed in, so offer the path itself as well.
        copyExtensionFolder: async () => {
          const { clipboard } = await import('electron');
          await clipboard.writeText(paths.extension);
          return paths.extension;
        },
        extensions: () => shell.openExternal('https://support.google.com/chrome_webstore/answer/2664769?hl=zh-Hans'),
        chromeDownload: () => shell.openExternal('https://www.google.com/chrome/'),
        chromeShortcut: async () => {
          if (mac) {
            const launcher = macChromeLauncher({ home: app.getPath('home'), desktopDir: app.getPath('desktop') });
            if (!launcher) throw new Error('没有找到已安装的 Chrome，请先把 Chrome 安装到「应用程序」。');
            await writeMacChromeLauncher(launcher);
            return { shortcut: launcher.path };
          }
          if (process.platform !== 'win32') throw new Error('只有 Windows 和 macOS 能在这里创建快捷方式；其他系统请按说明带参数启动 Chrome。');
          const spec = chromeShortcutSpec({ env: process.env, desktopDir: app.getPath('desktop') });
          if (!spec) throw new Error('没有找到已安装的 Chrome，请先安装 Chrome。');
          if (!shell.writeShortcutLink(spec.path, 'create', spec.options)) throw new Error(`无法在桌面创建快捷方式：${spec.path}`);
          return { shortcut: spec.path };
        },
        dataFolder: () => shell.openPath(paths.userData),
        logFolder: () => shell.openPath(join(paths.userData, 'logs')),
        copyDiagnostics: async () => {
          const { clipboard } = await import('electron');
          await clipboard.writeText(coordinator.diagnosticsText());
        },
        mcpConfig: async () => {
          const { clipboard } = await import('electron');
          await clipboard.writeText(guide().config);
        },
        agentGuide: (client) => guide(client),
        copyAgentConfig: async (client) => {
          const { clipboard } = await import('electron');
          await clipboard.writeText(guide(client).config);
        },
        detectAgents: () => detectAgents({
          appData: app.getPath('appData'), localAppData: process.env.LOCALAPPDATA, env: process.env, platform: process.platform,
          protocolHandler: (protocol) => app.getApplicationNameForProtocol(protocol),
        }),
        // Only the assistants the user ticked, one at a time so each row reports its own outcome.
        connectAgents: async (clients) => {
          if (!Array.isArray(clients) || !clients.length) throw new Error('请先勾选要接入的助手。');
          const { executable, args } = guide();
          const results = [];
          for (const client of clients) {
            try {
              results.push({ client, ok: true, message: await connectAgent(client, executable, args, {
                openExternal: (url) => shell.openExternal(url), appData: app.getPath('appData'), localAppData: process.env.LOCALAPPDATA,
                env: process.env, platform: process.platform,
              }) });
            } catch (error) { results.push({ client, ok: false, message: error.message }); }
          }
          return results;
        },
        autostart: (enabled) => {
          if (!app.isPackaged) throw new Error('开发模式不支持开机启动，请在安装版中设置。');
          app.setLoginItemSettings({ openAtLogin: enabled === true, args: LOGIN_ARGS });
          return launchesAtLogin();
        },
        autostartState: () => app.isPackaged && launchesAtLogin(),
        policy: async (input) => { await coordinator.savePolicy(input); return coordinator.snapshot(); },
        chooseScreenshotDir: async () => {
          const { canceled, filePaths } = await dialog.showOpenDialog(window, { title: '选择截图保存目录', properties: ['openDirectory', 'createDirectory'] });
          if (!canceled && filePaths[0]) await coordinator.savePolicy({ screenshotDir: filePaths[0] });
          return coordinator.snapshot();
        },
        agentDocs: (client) => shell.openExternal(guide(client).docs),
        agentDownload: (client) => {
          const url = guide(client).download;
          if (!url) throw new Error('请选择一种助手，或使用你已有的 MCP 客户端。');
          return shell.openExternal(url);
        },
        checkMcp: () => {
          if (coordinator.phase !== 'ready' || !coordinator.snapshot().browserReady) throw new Error('请先准备工作台并确认浏览器连接。');
          return checkMcpStdio(app.isPackaged ? { command: paths.native, args: ['--mcp-stdio'] } : { command: process.execPath, args: [fileURLToPath(new URL('./mcp-entry.cjs', import.meta.url)), paths.descriptor], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        },
        workbench: async (destination) => {
          await coordinator.refreshBrowsers();
          // Chrome is not required: records and reports are readable without it, and a run without one says so itself.
          if (coordinator.phase !== 'ready' || !coordinator.supervisor?.endpoints.console) throw new Error('请先完成工作台准备。');
          coordinator.supervisor.activate();
          await window.loadURL(coordinator.ingress.origin + (destination === 'books' ? '/#/books' : ''));
          await coordinator.completeSetup();
          resumePending = false;
        },
      };
      finishInitialization();
      shellControls.update();
      window.webContents.send('desktop:state', coordinator.snapshot());
      const refresh = async () => {
        if (coordinator.busy || closing) return;
        await coordinator.refreshBrowsers();
        if (resumePending && coordinator.phase === 'ready' && coordinator.snapshot().browserReady) {
          resumePending = false;
          await actions.workbench();
        }
      };
      const reportRestoreFailure = (error) => { resumePending = false; coordinator.update('failed', `工作台恢复失败：${error.message}`); };
      polling = setInterval(() => { void refresh().catch(reportRestoreFailure); }, 2500);
      if (resumePending) void coordinator.prepare().then(refresh).catch(reportRestoreFailure);
    } catch (error) {
      initializationError = error;
      showWindow();
      finishInitialization();
      window.webContents.send('desktop:state', { phase: 'failed', detail: `客户端资源未准备：${error.message}`, services: [], browsers: [] });
    }
  }).catch((error) => { process.stderr.write(`${error.message}\n`); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (cleanupComplete) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    clearInterval(polling);
    void Promise.resolve(coordinator?.close()).catch((error) => process.stderr.write(`退出清理失败：${error.message}\n`)).finally(() => { shellControls?.dispose(); cleanupComplete = true; app.quit(); });
  });
  app.on('will-quit', () => { if (tray && !tray.isDestroyed()) tray.destroy(); });
}
}
