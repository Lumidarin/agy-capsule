import { randomBytes } from 'node:crypto';
import { createSidebarHtml } from '../agy-capsule/sidecars/agy_capsule/sidebar_ui.mjs';

// Reuse the App's panel protocol without starting an HTTP server in the IDE.
function bridge() {
  const api = acquireVsCodeApi(), pending = new Map();
  let serial = 0, current;
  const el = id => document.getElementById(id);
  const text = (lang, en, cn, tw = cn) => lang === 'zh-TW' ? tw : lang?.startsWith('zh') ? cn : en;
  function paint(data) {
    const d = data.ideInfo;
    if (!d || !el('ide-maintenance')) return;
    current = data;
    const lang = data.prefs.language, sl = data.prefs.settingsLanguage;
    const tr = (...args) => text(lang, ...args);
    const labels = {
      'cli-quota': ['Refresh CLI account quota', '读取 CLI 当前账号额度', '讀取 CLI 目前帳號額度'],
      check: ['Check IDE updates', '检查插件更新', '檢查插件更新'],
      install: ['Install VSIX…', '本地安装VSIX', '本機安裝VSIX'],
      repair: ['Repair IDE shortcut', '修复 IDE 快捷方式', '修復 IDE 捷徑'],
      updates: data.prefs.notifyUpdates ? ['Update alerts: on', '更新提醒：开', '更新提醒：開'] : ['Update alerts: off', '更新提醒：关', '更新提醒：關'],
      'data-directory': ['Data directory…', '设置对话记录的读取位置', '設定對話記錄的讀取位置'],
    };
    for (const btn of document.querySelectorAll('[data-ide-action]')) {
      const action = btn.dataset.ideAction;
      const label = text(btn.closest('#sidebar-settings') ? sl : lang, ...labels[action]);
      if (btn.textContent !== label) btn.textContent = label;
      if (action === 'repair') btn.hidden = !d.windows;
      if (action === 'cli-quota') btn.hidden = !d.canReadCli;
      if (action === 'updates') btn.setAttribute('aria-pressed', String(data.prefs.notifyUpdates));
    }
    const box = el('ide-quota-tools'), source = el('ide-quota-source');
    box.hidden = !(d.cliAt || d.paygo || d.canReadCli);
    let note = d.paygo ? tr('Vertex AI · pay-as-you-go (no subscription quota pool)', 'Vertex AI 按量计费，无套餐额度池。', 'Vertex AI 按量計費，無方案額度池。') :
      d.cliAt ? tr('Source: current CLI account · ', '来源：CLI 当前账号 · ', '來源：CLI 目前帳號 · ') + new Date(d.cliAt).toLocaleTimeString(lang) :
      d.canReadCli ? tr('IDE quota unavailable. A manual read uses the CLI account, which may differ.', '暂未取得 IDE 额度。手动读取使用 CLI 当前账号，可能与 IDE 不同。', '暫未取得 IDE 額度。手動讀取使用 CLI 目前帳號，可能與 IDE 不同。') : '';
    for (const b of d.unavailable || []) note += ' · ' + b.displayName + ' ' + b.window + tr(': no numeric value reported', '：CLI 未返回数值', '：CLI 未傳回數值');
    if (source.textContent !== note) source.textContent = note;
    const diagnostics = {
      'cloud': ['Live conversation data · not included in local usage history.', '当前显示云端会话数据，不计入本机历史用量。', '目前顯示雲端對話資料，不計入本機用量記錄。'],
      'invalid-path': ['Use an absolute product data directory.', '请填写产品数据根目录的绝对路径。', '請填寫產品資料根目錄的絕對路徑。'],
      'root-missing': ['Configured data directory not found.', '找不到指定的数据根目录。', '找不到指定的資料根目錄。'],
      'uninitialized': ['Conversation directory not initialized.', '该位置尚未建立 conversations 目录。', '此位置尚未建立 conversations 目錄。'],
      'not-directory': ['Expected a directory, not a file.', '配置的位置不是目录。', '設定的位置不是目錄。'],
      'unreadable': ['Cannot read conversation storage.', '没有读到该会话存储目录。', '無法讀取對話儲存目錄。'],
      'not-a-file': ['Conversation record is not a file.', '会话记录路径不是文件。', '對話記錄路徑不是檔案。'],
      'invalid-conversation': ['Invalid conversation ID.', '会话 ID 无效。', '對話 ID 無效。'],
      'new-conversation': ['No conversation selected yet.', '当前还没有选中对话。', '目前尚未選取對話。'],
      'waiting-for-data': ['No local record for this conversation yet.', '这条对话还没有本地记录。', '這段對話尚無本機記錄。'],
    };
    const diag = el('ide-diagnostics'), why = diagnostics[d.diagnostic];
    diag.hidden = !why;
    if (why) {
      const problem = !['cloud','new-conversation','waiting-for-data'].includes(d.diagnostic);
      diag.querySelector('button').hidden = !problem;
      const line = tr(...why) + (problem && d.root ? ' ' + d.root : '') +
        (problem && d.cloud ? ' · ' + tr(...diagnostics.cloud) : '');
      if (el('ide-data-note').textContent !== line) el('ide-data-note').textContent = line;
    }
  }
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-ide-action]');
    if (!btn || !e.isTrusted || btn.disabled || !current) return;
    const action = btn.dataset.ideAction, lang = current.prefs.language;
    const cli = action === 'cli-quota', status = el('ide-cli-status');
    if (cli) status.textContent = text(lang, 'Reading CLI quota…', '正在读取 CLI 额度…', '正在讀取 CLI 額度…');
    btn.disabled = true;
    try {
      const path = action === 'updates' ? '/api/settings' : '/api/ide/' + action;
      const res = await window.sidecar.fetch(path, { body: JSON.stringify(action === 'updates' ?
        { notifyUpdates: !current.prefs.notifyUpdates } : {}), signal: AbortSignal.timeout(35000) });
      const result = await res.json();
      if (cli) {
        if (result.status === 'ok') status.textContent = '';
        else if (result.reason === 'interaction-required') status.textContent = text(lang, 'Complete sign-in or workspace trust in your CLI, then retry.', '请先在 CLI 中完成登录或工作区确认，再重试。', '請先在 CLI 中完成登入或工作區確認，再重試。');
        else status.textContent = text(lang, 'Could not read CLI quota: ', 'CLI 额度读取失败：', 'CLI 額度讀取失敗：') + (result.reason || 'unavailable');
      }
    } catch { if (cli) status.textContent = text(lang, 'Read timed out. Retry when ready.', '读取超时，可以重试。', '讀取逾時，可再試一次。'); }
    finally { btn.disabled = false; }
  });
  window.sidecar = {
    conversationId: '',
    fetch(path, init) {
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const signal = init.signal;
        const abort = () => { pending.delete(id); reject(new Error('Sidebar request timed out')); };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        pending.set(id, msg => {
          signal?.removeEventListener('abort', abort);
          if (path === '/api/context' && msg.status === 200) {
            window.sidecar.conversationId = msg.body.conversationId || ''; paint(msg.body);
          }
          resolve(new Response(JSON.stringify(msg.body), { status: msg.status }));
        });
        api.postMessage({ id, path, data: JSON.parse(init.body || '{}') });
      });
    },
  };
  window.addEventListener('message', ({ data }) => {
    const finish = pending.get(data?.id);
    if (finish) { pending.delete(data.id); finish(data); }
  });
}

export function sidebarProvider(version, routes) {
  return { resolveWebviewView(view) {
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    const messages = view.webview.onDidReceiveMessage(async msg => {
      if (!Number.isSafeInteger(msg?.id) || !Object.hasOwn(routes, msg.path)) return;
      let body, status = 200;
      try { body = await routes[msg.path](msg.data); }
      catch { status = 500; body = { error: 'Sidebar request failed' }; }
      await view.webview.postMessage({ id: msg.id, status, body });
    });
    view.onDidDispose(() => messages.dispose());
    view.webview.html = createSidebarHtml({ version, ide: { nonce: randomBytes(18).toString('hex'), bridge } });
  } };
}
