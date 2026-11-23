const vscode = require('vscode');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { createCliQuotaReader } = require('./cli_quota.cjs');
const { existsSync } = require('node:fs');

let stopRuntime;
exports.deactivate = () => stopRuntime?.();

exports.activate = async function activate(context) {
  const [{ activeId, windowId, conversationPath, conversationIds, modelQuotas, workspaceChat },
    { readConversationSnapshot, readConversationUsage }, { createSqliteSnapshotCache },
    { createUsageHistory }, { createPresentation }, { sidebarProvider }] = await Promise.all([
    import('./host.mjs'), import('../agy-capsule/sidecars/agy_capsule/conversation_db.mjs'), import('../agy-capsule/sidecars/agy_capsule/sqlite_cache.mjs'),
    import('../agy-capsule/sidecars/agy_capsule/usage_history.mjs'), import('../agy-capsule/sidecars/agy_capsule/ui.mjs'), import('./sidebar.mjs'),
  ]);
  const [{ ideComposerSession }, { startDeckInjector, createQuotaSnapshot }, { createSettingsStore }] = await Promise.all([
    import('./composer.mjs'), import('../agy-capsule/sidecars/agy_capsule/deck_injector.mjs'),
    import('../agy-capsule/sidecars/agy_capsule/settings.mjs'),
  ]);
  const [{ resolveDataRoots, diagnoseConversation }, { createIdeCloudFallback },
    { readComposerBilling, userBillingMode, quotaAvailability }] = await Promise.all([
    import('./data_roots.mjs'), import('./cloud.mjs'), import('./billing.mjs')]);
  const readPanelChat = workspaceChat(context.storageUri?.fsPath);
  const rootsFor = native => resolveDataRoots({ native, dataDirectory:
    vscode.workspace.getConfiguration('agyCapsule').inspect('dataDirectory')?.globalValue });
  let roots = rootsFor(false), composerRoots = roots, dir = roots.directory;
  const cache = createSqliteSnapshotCache(readConversationSnapshot);
  const ui = createPresentation();
  const file = join(context.globalStorageUri.fsPath, 'settings.json');
  const store = createSettingsStore(file);
  if (!existsSync(file)) {
    const config = vscode.workspace.getConfiguration('agyCapsule');
    store.update({ ...createSettingsStore().read(), showUsageActivity: true, showModelUsage: true,
      showTurnMetrics: true, modelEffortPicker: true, showEffortBar: true,
      showSpeed: config.get('showSpeed', true), showCacheHitInFooter: config.get('showCacheHit', false) });
  }
  const histories = new Map();
  const historyFor = directory => {
    if (!histories.has(directory)) histories.set(directory, createUsageHistory({ directories: [directory], readRequests: readConversationUsage }));
    return histories.get(directory);
  };
  const win = windowId(context.logUri.fsPath);
  const language = vscode.env.language.toLowerCase();
  const zh = language.startsWith('zh');
  const t = (english, chinese) => zh ? chinese : english;
  const labels = ui.dictionaries[zh ? (language === 'zh-tw' ? 'zh-TW' : 'zh-CN') : 'en'];
  const item = vscode.window.createStatusBarItem('agyCapsule', vscode.StatusBarAlignment.Right, 55);
  item.name = 'agy-capsule';
  item.command = 'agyCapsule.details';
  const subscriptions = context.subscriptions;
  const line = (label, description, tooltip) => ({ label, description, tooltip });
  const fmt = ui.formatTokens;
  const percent = q => q.percent + '%';
  let pinned = context.workspaceState.get('agyCapsule.pinned', ''), id = '', rows = [], quotas = [];
  let footer, activeTopic, quotaTopic, lastQuota, signature, disposed = false, accountMode = 'unknown';
  function readUserStatus() {
    const value = quotaTopic?.getState()?.userStatusSentinelKey?.value;
    if (lastQuota !== value) { lastQuota = value; quotas = modelQuotas(value); accountMode = userBillingMode(value); }
    return accountMode;
  }
  let poolCache = createQuotaSnapshot();
  const statusOnly = () => vscode.workspace.getConfiguration('agyCapsule').get('location', 'composer') === 'statusBar';
  let cloud, cliSample = null, cliReader, revision = 0, retiring = Promise.resolve();
  const resetCloud = () => createIdeCloudFallback({ hasLocal: id => {
    const file = composerRoots.directory && conversationPath(composerRoots.directory, id);
    return !!file && existsSync(file);
  } });
  cloud = resetCloud();
  subscriptions.push({ dispose() { cliReader?.dispose(); } });
  async function refreshCliQuota() {
    if (!cliReader) {
      const cwd = vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
      cliReader = createCliQuotaReader({ appRoot: vscode.env.appRoot, cwd: cwd || homedir() });
    }
    const reader = cliReader, result = await reader.refresh();
    if (cliReader !== reader || disposed) return { status: 'error', reason: 'canceled' };
    if (result.status === 'ok') cliSample = result;
    return result;
  }
  function updateLocation() {
    if (statusOnly()) item.show(); else item.hide();
  }
  function configureFooter() {
    updateLocation();
    const seq = ++revision, previous = footer;
    footer = undefined;
    poolCache = createQuotaSnapshot();
    cloud = resetCloud();
    if (previous) retiring = Promise.all([retiring, previous.stop()]).catch(() => {});
    void retiring.then(() => { if (seq === revision && !disposed && !statusOnly()) startFooter(); });
  }
  function startFooter() {
    const session = ideComposerSession(context.logUri.fsPath,
      () => (vscode.workspace.workspaceFolders || []).map(f => f.uri.toString()));
    const fallback = cloud;
    const inspect = (chat, _exact, child, estimate) => {
      const path = composerRoots.directory && conversationPath(composerRoots.directory, chat);
      const prefs = store.read();
      const data = (path && cache.read(path, prefs.showTurnMetrics)) ?? fallback.read(chat, prefs.showTurnMetrics, child);
      if (child && (child === 'side' ? !data : !data?.subagent)) return null;
      // Composer always follows its own chat, even when Explorer pins a historical chat.
      const validEstimate = estimate && !data?.subagent && !(data?.contextRequestIndex > estimate.generatorMetadataIndex);
      return { ...data, ...(validEstimate && { contextEstimate: estimate }),
        prefs, ...(child === 'side' && { subagent: { model: '', side: true } }),
        useComposerQuota: true,
      };
    };
    const instance = startDeckInjector(inspect, { ...session, instanceTs: Date.now(), readBillingMode: readComposerBilling,
      needsCloudTelemetry: fallback.needsCloudTelemetry, onCloudTelemetry: fallback.onCloudTelemetry,
      onStatus: state => { if (footer === instance && state !== 'ok') maintenance.observeCdp(state); },
      onMounted: mounted => { if (footer === instance && mounted) maintenance.observeCdp('ok'); },
      onQuota(sample) { if (footer === instance) poolCache.observe(sample); },
      sideChatEnabled: () => store.read().showSideChatCapsules,
      onEffortSettingsPatch: patch => store.update(patch),
      onSuperseded() { /* Retire this injector, never the shared extension host. */ },
    });
    footer = instance;
  }
  function selectChat() {
    const panelChat = readPanelChat();
    const windowChat = activeId(activeTopic?.getState(), win);
    roots = rootsFor(!!windowChat || !panelChat);
    dir = roots.directory;
    id = pinned || windowChat || panelChat?.id || '';
  }
  const panel = sidebarProvider(context.extension.packageJSON.version, {
    '/api/context': () => {
      selectChat();
      const prefs = store.read(), diag = diagnoseConversation(roots, id), path = diag.path;
      const local = path && cache.read(path, prefs.showTurnMetrics);
      const remote = !local && !path && dir === composerRoots.directory && cloud.read(id, prefs.showTurnMetrics);
      const data = local || remote;
      const estimate = footer?.contextEstimate(id);
      const pools = poolCache.read();
      const mode = pools?.billingMode && pools.billingMode !== 'unknown' ? pools.billingMode :
        readUserStatus();
      const paygo = !pools?.stale && quotaAvailability(pools?.groups, mode) === 'paygo';
      const cli = !pools?.groups.length && !paygo && cliSample && Date.now() - cliSample.at < 120_000 ? cliSample : null;
      return { ...data, conversationId: id, prefs, quotaGroups: pools?.groups.length ? pools.groups : cli?.groups ?? [],
        quotaStaleAt: !cli && pools?.stale ? pools.at : null, cloudPaygo: paygo,
        ideInfo: { paygo, cliAt: cli?.at, unavailable: cli?.unavailable,
          canReadCli: !paygo && !pools?.groups.length, cloud: !!remote,
          diagnostic: remote && ['uninitialized','waiting-for-data'].includes(diag.state) ? 'cloud' : diag.state, root: roots.root,
          windows: process.platform === 'win32' },
        ...(estimate && !(data?.contextRequestIndex > estimate.generatorMetadataIndex) && { contextEstimate: estimate }),
        health: path ? cache.health(path) : null, deckCdp: footer?.status() ?? 'off',
        availableModels: footer?.models(id) ?? [] };
    },
    '/api/usage': async () => {
      selectChat();
      const prefs = store.read();
      if (!prefs.showUsageActivity && !prefs.showModelUsage) return { enabled: false };
      return dir ? { enabled: true, ...await historyFor(dir).read({ activeId: id }) } : { enabled: true, days: [], unread: 1 };
    },
    '/api/ide/cli-quota': refreshCliQuota,
    '/api/ide/check': () => dispatch('agyCapsule.checkUpdates'),
    '/api/ide/install': () => dispatch('agyCapsule.installVsix'),
    '/api/ide/repair': () => dispatch('agyCapsule.repairShortcut'),
    '/api/ide/data-directory': async () => { await vscode.commands.executeCommand('workbench.action.openSettings', 'agyCapsule.dataDirectory'); return {}; },
    '/api/settings': patch => { const saved = store.update(patch); refresh(); return saved; },
  });
  function refresh() {
    if (disposed || !statusOnly()) return;
    selectChat();
    readUserStatus();
    const path = dir && conversationPath(dir, id);
    const prefs = store.read();
    const data = path && cache.read(path, prefs.showTurnMetrics);
    const status = ['$(pulse) Capsule'];
    rows = [];
    if (id) rows.push(line(pinned ? t('Pinned chat', '已固定对话') : t('Current chat', '当前对话'), id.slice(0, 8), id));
    const contextView = data && ui.contextBreakdown(data);
    if (contextView?.ctx > 0) {
      const c = contextView, cacheView = ui.cacheView(data, prefs);
      status.push(c.maxCtx ? c.usedPct : fmt(c.ctx));
      rows.push(line(t('Context', '上下文'), c.usedFrac, c.maxCtx ? c.usedPct : undefined),
        line(t('Prompt cache hit', '缓存命中'), cacheView.text, fmt(data.cachedIn) + ' cached tokens'),
        line(t('Estimated cache state', '预计缓存状态'), cacheView.status),
        line(t('First prompt / read / think / write', '首轮 / 读取 / 思考 / 写入'), [c.turn0, c.read, c.think, c.out].map(fmt).join(' / ')));
      if (prefs.showCacheHitInFooter) status.push('$(database) ' + cacheView.text);
    } else {
      rows.push(line(id ? t('Waiting for measured usage', '等待读到用量记录') :
        t('Open an IDE chat or select one from the view menu', '打开 IDE 对话，或用视图菜单选择一条')));
    }
    if (data) {
      const speed = data.turnSpeed?.generation?.tps;
      if (Number.isFinite(speed) && prefs.showSpeed) status.push(speed.toFixed(1) + ' tok/s');
      const g = data.generation;
      if (g.tps != null) rows.push(line(t('Latest request', '最近请求'), g.tps.toFixed(1) + ' tok/s',
        'TTFT ' + g.ttft.toFixed(1) + ' s · ' + g.duration.toFixed(1) + ' s'));
      const turn = data.turnMetrics;
      if (turn) {
        rows.push(line(t('Turn', '本轮'), turn.state + (turn.duration == null ? '' : ' · ' + turn.duration.toFixed(1) + ' s')),
          line(t('Requests / think / write', '请求数 / 思考 / 写入'), [turn.requestCount, turn.thinking, turn.write].map(fmt).join(' / ')));
      }
      const alert = ui.alertView(data, prefs, labels, Date.now(), data.turnSpeed?.hasActiveStep);
      if (alert.visible) { status.push('$(warning) ' + alert.label); rows.push(line(alert.heading, alert.detail, alert.diagnostic)); }
    }
    if (quotas.length) {
      const lowest = quotas.reduce((a, b) => a.percent <= b.percent ? a : b);
      status.push(t('min ', '最低 ') + percent(lowest));
      rows.push({ label: t('Remaining model quota', '模型剩余额度'), description: String(quotas.length),
        children: quotas.map(q => line(q.label, percent(q), q.reset ? t('Resets: ', '重置：') + new Date(q.reset).toLocaleString() : undefined)) });
    }
    const next = JSON.stringify([rows, status]);
    if (signature !== next) {
      signature = next;
      item.text = status.join('  ');
      item.tooltip = ['agy-capsule', ...rows.slice(0, 7).map(row => [row.label, row.description].filter(Boolean).join(': ')),
        t('Click for details', '点击查看详情')].join('\n');
      updateLocation();
    }
  }
  async function watch(topic, set) {
    try {
      const subscription = await vscode.antigravityUnifiedStateSync?.subscribe(topic);
      if (disposed || !subscription) return;
      set(subscription);
      subscriptions.push(subscription.onDidChange(refresh));
      refresh();
    } catch { /* Hosts without this IDE feed still support explicitly selected local chats. */ }
  }
  const maintenance = require('./maintenance.cjs').createMaintenance({ vscode, context, getPrefs: () => store.read() });
  // Native notifications/dialogs can remain open: acknowledge the webview click immediately.
  function dispatch(command) {
    void Promise.resolve(vscode.commands.executeCommand(command)).catch(() => vscode.window.showWarningMessage(
      t('Could not complete the IDE action.', '未能完成 IDE 操作。')));
    return { status: 'opened' };
  }
  const checkIfEnabled = () => { void maintenance.checkUpdates().catch(() => {}); };
  const firstCheck = setTimeout(checkIfEnabled, 10_000);
  const updateTimer = setInterval(checkIfEnabled, 6 * 60 * 60_000);
  subscriptions.push({ dispose() { clearTimeout(firstCheck); clearInterval(updateTimer); } },
    vscode.commands.registerCommand('agyCapsule.refreshCliQuota', async () => {
      await vscode.commands.executeCommand('agyCapsule.stats.focus');
      const result = await refreshCliQuota();
      if (result.status !== 'ok') void vscode.window.showWarningMessage(
        t('CLI quota unavailable: ', '未能读取 CLI 额度：') + result.reason);
      return result;
    }),
    vscode.commands.registerCommand('agyCapsule.checkUpdates', () => maintenance.checkUpdates({ manual: true })),
    vscode.commands.registerCommand('agyCapsule.installVsix', () => maintenance.installVsix()),
    vscode.commands.registerCommand('agyCapsule.repairShortcut', () => maintenance.repairShortcuts()));
  subscriptions.push(maintenance, vscode.workspace.onDidChangeWorkspaceFolders(() => {
    cliReader?.dispose(); cliReader = undefined; cliSample = null;
    configureFooter(); refresh();
  }));
  subscriptions.push(item, vscode.window.registerWebviewViewProvider('agyCapsule.stats', panel),
    vscode.commands.registerCommand('agyCapsule.details', () => vscode.commands.executeCommand('agyCapsule.stats.focus')),
    vscode.commands.registerCommand('agyCapsule.select', async () => {
      selectChat();
      const ids = dir ? await conversationIds(dir) : [];
      const pick = await vscode.window.showQuickPick([{ label: t('Follow this IDE window', '跟随当前 IDE 窗口'), id: '' },
        ...ids.map(value => ({ label: value, id: value }))], { title: t('agy-capsule: Monitor conversation', 'agy-capsule：监控对话'),
        placeHolder: t('Select a chat to pin its measurements', '选择一条对话以固定显示它的统计') });
      if (!pick) return;
      pinned = pick.id;
      await context.workspaceState.update('agyCapsule.pinned', pinned || undefined);
      refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      const cfg = vscode.workspace.getConfiguration('agyCapsule');
      if (e.affectsConfiguration('agyCapsule.showSpeed')) store.update({ showSpeed: cfg.get('showSpeed', true) });
      if (e.affectsConfiguration('agyCapsule.showCacheHit')) store.update({ showCacheHitInFooter: cfg.get('showCacheHit', false) });
      if (e.affectsConfiguration('agyCapsule.dataDirectory')) {
        composerRoots = rootsFor(false); histories.clear(); pinned = ''; void context.workspaceState.update('agyCapsule.pinned', undefined);
      }
      if (e.affectsConfiguration('agyCapsule.location') || e.affectsConfiguration('agyCapsule.dataDirectory')) configureFooter();
      if (e.affectsConfiguration('agyCapsule')) refresh();
    }),
    vscode.window.onDidChangeWindowState(e => { if (e.focused) refresh(); }));
  const timer = setInterval(() => { if (vscode.window.state.focused) refresh(); }, 2000);
  stopRuntime = () => {
    disposed = true; revision++; clearInterval(timer);
    const current = footer; footer = undefined;
    return Promise.all([retiring, current?.stop()]);
  };
  subscriptions.push({ dispose() { void stopRuntime(); } });
  refresh();
  configureFooter();
  void watch('uss-activeCascadeIds', s => { activeTopic = s; });
  void watch('uss-userStatus', s => { quotaTopic = s; });
};
