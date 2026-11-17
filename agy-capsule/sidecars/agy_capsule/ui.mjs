// Shared presentation only. Token counts and breakdown arithmetic stay unchanged.
import { createTurnPresentation } from './turn_ui.mjs';

export function createPresentation(turnFactory = createTurnPresentation) {
  const dictionaries = {
    en: {
      cache: 'Cache', turn0: 'Turn0', read: 'Read', think: 'Think', write: 'Write',
      used: 'used', fiveHours: '5 Hours', weekly: 'Weekly', soon: 'soon', active: 'Active',
      settings: 'Display settings', language: "Display language",
      sidebarStats: 'Statistics', sidebarSettings: 'Settings', sidebarNavigation: 'Sidebar view',
      settingsLanguage: 'Settings language', highlightActiveModel: 'Highlight active model',
      hideUnavailableQuota: 'Hide absent quota windows',
      showCacheWarnings: 'Cache expiry alert',
      showContextWarnings: 'Context overload alert', showRequestErrors: 'Request failure capsule',
      highContextTip: 'Context usage is high. Consider compacting or starting a new chat.',
      overflowContextTip: 'Latest request exceeded the model context limit.',
      requestFailure: 'Request failure', retryAfter: 'Server-reported retry wait:',
      error_quota_exhausted: 'Quota exhausted', error_rate_limited: 'Rate limited', error_network_error: 'Disconnected', error_auth_error: 'Authentication error', error_service_unavailable: 'Service busy', error_unknown: 'Unknown reason',
      detail_quota_exhausted: 'The request reported quota exhaustion. Switch to an available model or wait for its quota reset.',
      detail_rate_limited: 'The request was rate limited. Wait and retry.',
      detail_network_error: 'The request connection failed or timed out. Check the connection and retry.',
      detail_auth_error: 'The request failed authentication or permission checks. Check sign-in and account access.',
      detail_service_unavailable: 'The model service is temporarily unavailable. Retry later or switch models.',
      detail_unknown: 'The model request failed, but the reported information does not identify a known cause.',
      showSpeed: 'Generation speed', showRequestMetrics: 'Last request',
      speedAnimation: 'Effects',
      saveFailed: 'Could not save. Please try again.',
      newChat: 'New conversation', cached: 'cached',
      cachedInput: 'Cached input', lastActivity: 'Last recorded activity', cacheWarning: 'Approaching the 4m reminder threshold', cacheCold: '4m threshold reached; cache may be cold',
      context: 'Context details', quota: 'Model quotas',
      contextUsed: 'Used', contextLimit: 'Limit', contextRemaining: 'Remaining', uncachedInput: 'Uncached input', ofLimit: '{pct} of context limit', resetAt: 'Resets', resetUnknown: 'Reset time not reported',
      contextScope: 'Current request input context (excludes its new output).',
      turn0Tip: 'Starting context baseline for this cycle (system prompt and carried history).',
      readTip: 'Added context input (user messages, read files, and tool outputs).',
      writeTip: 'Prior model replies and tool calls kept in current context (excludes latest reply).',
      thinkTip: 'Prior model thinking kept in current context (excludes latest reply).',
      output: "Total output", reply: 'Response / tool calls', thinking: 'Thinking',
      totalTime: "Request duration", streamTime: 'Stream',
      speedTip: "Generation speed = total output ÷ request duration (TTFT + stream).",
      outputTip: "Output of latest request",
      ttftTip: "First-token wait to total duration of the latest request.",
      totalTimeTip: "Request duration (TTFT + stream); excludes tool execution.",
      appearanceSection: 'Appearance', featuresSection: 'Features',
      speedPairTip: 'Capsule speed: last completed request in the current turn (— until ready). Effects: breathing dot while running; holds speed color 15s after stopping (≥25 green, 10–25 yellow, <10 red).',
      requestSectionTip: 'Shows Last request (TTFT–total duration and generation speed of the latest recorded call) in panels. Independent of capsule speed.',
      turnSectionTip: 'Aggregates requests, elapsed wall time, write, and thinking tokens from your latest user message to completion.',
      panelLayout: 'Panel height', naturalLayout: 'Natural', matchedLayout: 'Matched',
      density: 'Panel spacing', compact: 'Compact', standard: 'Standard', spacious: 'Spacious',
      quotaIndicator: 'Quota indicator', ring: 'Ring', bar: 'Bar',
      labelCase: 'Label casing', lowercase: 'Lowercase', titlecase: 'Title case',
      contextLayout: 'Context breakdown', turnLayout: 'Turn metrics style', layoutColumns: 'Columns', layoutRows: 'Rows', contextMarker: 'Context marker', turnMarker: 'Turn marker', showContextBreakdown: 'Context breakdown', markerSquare: 'Square', markerDot: 'Dot',
      columnLabel: 'Names in columns', columnValue: 'Values in columns', columnPercent: 'Percentages in columns', fieldName: 'Name', fieldValue: 'Value', fieldPercent: '%', fieldDragTip: 'Drag to reorder; the switch hides or shows this line.',
      resetFormat: 'Reset countdown', compactTime: 'Compact', localizedTime: 'Localized', localizedTimeSample: '4 hr 55 min',
      resetDay: '{n} d', resetHour: '{n} hr', resetMinute: '{n} min', resetMinuteOnly: '{n} min', resetJoin: ' ',
    },
    'zh-CN': {
      cache: '缓存', turn0: '首轮', read: '读取', think: '思考', write: '写入',
      used: '已用', fiveHours: '5小时', weekly: '每周', soon: '即将重置', active: '当前',
      settings: '显示设置', language: "显示语言",
      sidebarStats: '统计', sidebarSettings: '设置', sidebarNavigation: 'Sidebar 页面',
      settingsLanguage: '设置语言', highlightActiveModel: '突出当前模型',
      hideUnavailableQuota: '隐藏不存在的配额窗口',
      showCacheWarnings: '缓存过期提醒',
      showContextWarnings: '上下文过载提醒', showRequestErrors: '请求失败胶囊',
      highContextTip: '上下文占用较高，建议压缩或开启新对话。',
      overflowContextTip: '最近一次请求已超出上下文上限。',
      requestFailure: '请求失败', retryAfter: '服务端报告的重试等待：',
      error_quota_exhausted: '额度耗尽', error_rate_limited: '429 限流', error_network_error: '断连', error_auth_error: '验证异常', error_service_unavailable: '服务繁忙', error_unknown: '未知原因',
      detail_quota_exhausted: '请求报告额度耗尽。可切换其他可用模型，或等待额度重置。',
      detail_rate_limited: '本次模型请求受到频率限制，请稍后重试。',
      detail_network_error: '本次模型请求连接失败或超时，请检查连接后重试。',
      detail_auth_error: '本次请求未通过验证或权限检查，请检查登录状态和账号权限。',
      detail_service_unavailable: '模型服务暂不可用，可稍后重试或切换其他模型。',
      detail_unknown: '本次模型请求失败，但报告的信息不足以识别已知原因。',
      showSpeed: '生成速度', showRequestMetrics: '最近请求',
      speedAnimation: '动效',
      saveFailed: '保存失败，请重试。',
      newChat: '新对话', cached: '缓存',
      cachedInput: '缓存输入', lastActivity: '最近记录距今', cacheWarning: '接近 4 分钟提醒阈值', cacheCold: '已达 4 分钟阈值，缓存可能已冷却',
      context: '上下文明细', quota: '模型配额',
      contextUsed: '已用', contextLimit: '上限', contextRemaining: '剩余', uncachedInput: '非缓存输入', ofLimit: '占上限 {pct}', resetAt: '重置时间', resetUnknown: '未提供重置时间',
      contextScope: '最近一次请求的输入上下文（不含刚生成的输出）。',
      turn0Tip: '当前周期起始输入基线，包含系统提示词与初始历史。',
      readTip: '对话中新增的输入内容，包括用户消息、读取的文件与工具返回结果。',
      writeTip: '留在当前上下文中的累计回复与工具调用（不含最近一次生成）。',
      thinkTip: '留在当前上下文中的累计思考输出（不含最近一次生成）。',
      output: "总输出", reply: '回复/调用', thinking: '思考',
      totalTime: "请求耗时", streamTime: '流式耗时',
      speedTip: "生成速度 = 总输出 ÷ 单次请求总耗时（首字等待 + 流式输出）。",
      outputTip: "最近一次请求输出",
      ttftTip: "首字等待耗时 – 单次请求总耗时（已包含首字等待）。",
      totalTimeTip: "请求总耗时（首字等待 + 流式输出，不含工具执行）。",
      appearanceSection: '外观', featuresSection: '功能',
      speedPairTip: '底栏速度：本轮最近一次已完成请求的速度（未完成显示 —）。动效：运行中圆点呼吸，结束后保色 15 秒再变灰（≥25 绿、10–25 黄、<10 红）。',
      requestSectionTip: '在面板展示最近一次请求的 TTFT–总耗时与生成速度，与底栏胶囊独立。',
      turnSectionTip: '从最近一条用户消息到结束，按整轮累计请求数、耗时、写入与思考。',
      panelLayout: '面板高度', naturalLayout: '自然高度', matchedLayout: '对齐高度',
      density: '面板间距', compact: '紧凑', standard: '标准', spacious: '舒展',
      quotaIndicator: '额度图形', ring: '圆环', bar: '进度条',
      labelCase: '面板大小写', lowercase: '全小写', titlecase: '首字母大写',
      contextLayout: '上下文明细', turnLayout: '本轮统计样式', layoutColumns: '竖线', layoutRows: '横条', contextMarker: '上下文标记', turnMarker: '本轮标记', showContextBreakdown: '上下文明细', markerSquare: '方块', markerDot: '圆点',
      columnLabel: '竖线显示名称', columnValue: '竖线显示数值', columnPercent: '竖线显示百分比', fieldName: '名称', fieldValue: '数值', fieldPercent: '百分比', fieldDragTip: '拖动调整顺序，开关控制这一行显示或隐藏。',
      resetFormat: '重置倒计时', compactTime: '简写', localizedTime: '本地化', localizedTimeSample: '4小时55分',
      resetDay: '{n}天', resetHour: '{n}小时', resetMinute: '{n}分', resetMinuteOnly: '{n}分钟', resetJoin: '',
    },
    'zh-TW': {
      cache: '快取', turn0: '首輪', read: '讀取', think: '思考', write: '寫入',
      used: '已用', fiveHours: '5小時', weekly: '每週', soon: '即將重設', active: '目前',
      settings: '顯示設定', language: "顯示語言",
      sidebarStats: '統計', sidebarSettings: '設定', sidebarNavigation: 'Sidebar 頁面',
      settingsLanguage: '設定語言', highlightActiveModel: '突出目前模型',
      hideUnavailableQuota: '隱藏不存在的配額視窗',
      showCacheWarnings: '快取過期提醒',
      showContextWarnings: '上下文過載提醒', showRequestErrors: '請求失敗膠囊',
      highContextTip: '上下文佔用較高，建議壓縮或開啟新對話。',
      overflowContextTip: '最近一次請求已超出上下文上限。',
      requestFailure: '請求失敗', retryAfter: '服務端回報的重試等待：',
      error_quota_exhausted: '額度耗盡', error_rate_limited: '429 限流', error_network_error: '斷連', error_auth_error: '驗證異常', error_service_unavailable: '服務繁忙', error_unknown: '未知原因',
      detail_quota_exhausted: '請求回報額度耗盡。可切換其他可用模型，或等待額度重設。',
      detail_rate_limited: '本次模型請求受到頻率限制，請稍後重試。',
      detail_network_error: '本次模型請求連線失敗或逾時，請檢查連線後重試。',
      detail_auth_error: '本次請求未通過驗證或權限檢查，請檢查登入狀態和帳號權限。',
      detail_service_unavailable: '模型服務暫不可用，可稍後重試或切換其他模型。',
      detail_unknown: '本次模型請求失敗，但回報的資訊不足以識別已知原因。',
      showSpeed: '生成速度', showRequestMetrics: '最近請求',
      speedAnimation: '動效',
      saveFailed: '儲存失敗，請重試。',
      newChat: '新對話', cached: '快取',
      cachedInput: '快取輸入', lastActivity: '最近記錄距今', cacheWarning: '接近 4 分鐘提醒閾值', cacheCold: '已達 4 分鐘閾值，快取可能已冷卻',
      context: '上下文明細', quota: '模型配額',
      contextUsed: '已用', contextLimit: '上限', contextRemaining: '剩餘', uncachedInput: '非快取輸入', ofLimit: '佔上限 {pct}', resetAt: '重設時間', resetUnknown: '未提供重設時間',
      contextScope: '最近一次請求的輸入上下文（不含剛產生的輸出）。',
      turn0Tip: '目前週期起始輸入基線，包含系統提示詞與初始歷史。',
      readTip: '對話中新增的輸入內容，包括使用者訊息、讀取的檔案與工具回傳結果。',
      writeTip: '留在目前上下文中的累計回覆與工具呼叫（不含最近一次生成）。',
      thinkTip: '留在目前上下文中的累計思考輸出（不含最近一次生成）。',
      output: "總輸出", reply: '回覆/呼叫', thinking: '思考',
      totalTime: "請求耗時", streamTime: '串流耗時',
      speedTip: "生成速度 = 總輸出 ÷ 單次請求總耗時（首字等待 + 串流輸出）。",
      outputTip: "最近一次請求輸出",
      ttftTip: "首字等待耗時 – 單次請求總耗時（已包含首字等待）。",
      totalTimeTip: "請求總耗時（首字等待 + 串流輸出，不含工具執行）。",
      appearanceSection: '外觀', featuresSection: '功能',
      speedPairTip: '底欄速度：本輪最近一次已完成請求的速度（未完成顯示 —）。動效：執行中圓點呼吸，結束後保色 15 秒再變灰（≥25 綠、10–25 黃、<10 紅）。',
      requestSectionTip: '於面板展示最近一次請求的 TTFT–總耗時與生成速度，與底欄膠囊獨立。',
      turnSectionTip: '從最近一條使用者訊息到結束，依整輪累計請求數、耗時、寫入與思考。',
      panelLayout: '面板高度', naturalLayout: '自然高度', matchedLayout: '對齊高度',
      density: '面板間距', compact: '緊湊', standard: '標準', spacious: '舒展',
      quotaIndicator: '額度圖形', ring: '圓環', bar: '進度條',
      labelCase: '面板大小寫', lowercase: '全小寫', titlecase: '首字母大寫',
      contextLayout: '上下文明細', turnLayout: '本輪統計樣式', layoutColumns: '豎線', layoutRows: '橫條', contextMarker: '上下文標記', turnMarker: '本輪標記', showContextBreakdown: '上下文明細', markerSquare: '方塊', markerDot: '圓點',
      columnLabel: '豎線顯示名稱', columnValue: '豎線顯示數值', columnPercent: '豎線顯示百分比', fieldName: '名稱', fieldValue: '數值', fieldPercent: '百分比', fieldDragTip: '拖動調整順序，開關控制這一行顯示或隱藏。',
      resetFormat: '重設倒數', compactTime: '簡寫', localizedTime: '在地化', localizedTimeSample: '4小時55分',
      resetDay: '{n}天', resetHour: '{n}小時', resetMinute: '{n}分', resetMinuteOnly: '{n}分鐘', resetJoin: '',
    },
  };
  function locale(prefs = {}, candidates = []) {
    if (dictionaries[prefs.language]) return prefs.language;
    for (const raw of candidates) {
      const value = String(raw || '').toLowerCase().replace(/_/g, '-');
      if (!value) continue;
      if (value.startsWith('zh')) return /hant|tw|hk|mo/.test(value) ? 'zh-TW' : 'zh-CN';
      if (value.startsWith('en')) return 'en';
    }
    return 'en';
  }
  function systemLocale(prefs) {
    return locale(prefs, [navigator.language, ...(navigator.languages || [])]);
  }
  function formatTokens(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const n = Math.max(0, Number(value));
    if (n < 1000) return String(Math.round(n));
    const k = Math.round(n / 100) / 10;
    if (k < 100) return k.toFixed(1) + 'K';
    const kInt = Math.round(n / 1000);
    if (kInt < 1000) return kInt + 'K';
    const m = Math.round(n / 100000) / 10;
    return m >= 100 ? Math.round(n / 1000000) + 'M' : m.toFixed(1) + 'M';
  }
  const { dictionaries: turnDictionaries, ...turnMethods } = turnFactory(formatTokens);
  for (const language of Object.keys(dictionaries)) Object.assign(dictionaries[language], turnDictionaries[language]);
  function cacheTooltip(data = {}, t = dictionaries.en, nowMs = Date.now(), prefs = {}) {
    const context = Number(data.contextTokens) || 0;
    if (context <= 0) return `0 / 0 ${t.cached} · ${t.newChat}`;
    const timestamp = Number(data.lastStepEpochMs);
    const seconds = Number.isFinite(timestamp) && timestamp > 0 ? Math.max(0, Math.floor((nowMs - timestamp) / 1000)) : null;
    const minutes = seconds === null ? null : Math.floor(seconds / 60);
    const age = minutes === null ? '—' : minutes < 1 ? '<1m' : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
    const warn = prefs?.showCacheWarnings !== false && seconds !== null;
    const state = !warn ? '' : seconds >= 240 ? t.cacheCold : seconds >= 180 ? t.cacheWarning : '';
    return `${t.cachedInput}: ${formatTokens(data.cachedIn ?? 0)} / ${formatTokens(context)} tokens · ${t.lastActivity}: ${age}${state ? ' · ' + state : ''}`;
  }
  function cacheView(data = {}, prefs = {}, nowMs = Date.now()) {
    const ctx = data.contextTokens || 0;
    const cached = data.cachedIn || 0;
    const hitPct = ctx > 0 ? Math.round((cached / ctx) * 100) : 0;
    const warn = prefs?.showCacheWarnings !== false;
    const idleSec = warn && ctx > 0 && data.lastStepEpochMs ? Math.max(0, Math.floor((nowMs - data.lastStepEpochMs) / 1000)) : 0;
    if (idleSec >= 240) {
      return {
        status: 'cold',
        iconSvg: '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#e06c75" stroke-width="2" stroke-linecap="round"><line x1="2.2" y1="2.2" x2="9.8" y2="9.8"/><line x1="9.8" y1="2.2" x2="2.2" y2="9.8"/></svg>',
        valColor: '', valDeco: 'line-through', valOp: '0.5', text: hitPct + '%', countdown: '',
        ctxIconColor: 'rgba(208, 122, 128, 0.88)',
      };
    }
    if (idleSec >= 180) {
      const remMin = Math.max(1, Math.ceil((240 - idleSec) / 60));
      return {
        status: 'warning',
        iconSvg: '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#d4940a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="4.8"/><polyline points="6 3.5 6 6 7.8 7.2"/></svg>',
        valColor: '#d4940a', valDeco: 'none', valOp: '1', text: hitPct + '%', countdown: '~' + remMin + 'm',
        ctxIconColor: 'rgba(206, 168, 92, 0.88)',
      };
    }
    return {
      status: 'fresh',
      iconSvg: '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 6.5 4.8 9.2 10 3"/></svg>',
      valColor: '', valDeco: 'none', valOp: '1', text: hitPct + '%', countdown: '',
      ctxIconColor: '',
    };
  }
  function contextTooltips(data = {}, t = dictionaries.en) {
    const context = data.contextTokens || 0;
    const limit = data.maxContextTokens || 0;
    const cached = data.cachedIn || 0;
    const turn0 = data.turn0Tokens || 0;
    const write = data.totalOutputTokens || 0;
    const think = data.totalThinkingTokens || 0;
    const read = Math.max(0, context - turn0 - write - think);
    const row = (key, value) => `${t[key]}: ${formatTokens(value)} tokens${limit > 0 ? ` · ${t.ofLimit.replace('{pct}', Math.round(value / limit * 100) + '%')}` : ''}\n${t[key + 'Tip']}`;
    return {
      overview: `${t.contextScope}\n${t.contextUsed} ${formatTokens(context)} / ${t.contextLimit} ${limit > 0 ? formatTokens(limit) : '—'} · ${t.contextRemaining} ${limit > 0 ? formatTokens(Math.max(0, limit - context)) : '—'}\n${t.cachedInput} ${formatTokens(cached)} · ${t.uncachedInput} ${formatTokens(data.uncachedIn ?? Math.max(0, context - cached))}`,
      turn0: row('turn0', turn0), read: row('read', read), write: row('write', write), think: row('think', think),
    };
  }
  function renderContextTooltips(root, data, t) {
    const tips = contextTooltips(data, t);
    for (const node of root.querySelectorAll('[data-context-tip]')) node.title = tips[node.dataset.contextTip];
  }
  function quotaTooltip(data, t = dictionaries.en) {
    const date = data.resetTime ? new Date(data.resetTime) : null;
    const pad = n => String(n).padStart(2, '0');
    return date && Number.isFinite(date.getTime())
      ? `${t.resetAt} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`
      : t.resetUnknown;
  }
  function applyQuotaTooltips(root, t) {
    for (const row of root.querySelectorAll('[data-quota-tooltip]')) row.title = quotaTooltip(JSON.parse(row.dataset.quotaTooltip), t);
  }
  function alertView(data = {}, prefs = {}, t = dictionaries.en) {
    const kind = data.requestError?.kind || 'none';
    const ratio = data.maxContextTokens > 0 ? (data.contextTokens || 0) / data.maxContextTokens : 0;
    const contextTone = prefs.showContextWarnings === false ? '' : kind === 'context_overflow' || ratio >= .9 ? 'error' : ratio >= .75 ? 'warning' : '';
    const contextTip = !contextTone ? '' : kind === 'context_overflow' ? t.overflowContextTip : t.highContextTip;
    const visible = prefs.showRequestErrors !== false && ['quota_exhausted', 'rate_limited', 'network_error', 'auth_error', 'service_unavailable', 'unknown'].includes(kind);
    const label = visible ? t['error_' + kind] : '';
    const wait = data.requestError?.retryAfterSec;
    const detail = visible ? t['detail_' + kind] + (kind === 'rate_limited' && typeof wait === 'number' ? ` ${t.retryAfter} ${wait}s` : '') : '';
    const diagnostic = visible ? data.requestError?.diagnostic || '' : '';
    return { contextTone, contextTip, visible, label, detail, diagnostic };
  }
  function renderAlerts(root, data, prefs, t) {
    const view = alertView(data, prefs, t);
    root.dataset.contextTone = view.contextTone;
    if (view.contextTip) for (const node of root.querySelectorAll('[data-context-tip="overview"]')) node.title += '\n' + view.contextTip;
    for (const node of root.querySelectorAll('[data-request-error]')) {
      node.textContent = view[node.dataset.requestError];
    }
    const group = root.querySelector('[data-el="grpError"]');
    if (group) {
      group.hidden = !view.visible;
      group.querySelector('.dk-pill').setAttribute('aria-label', `${t.requestFailure}: ${view.label}`);
      group.querySelector('.dk-pill').title = [view.label, view.detail, view.diagnostic].filter(Boolean).join('\n');
    }
    return view;
  }
  function generationText(g = {}, t = dictionaries.en) {
    const seconds = n => n !== null && n !== undefined && Number.isFinite(n) ? n.toFixed(1) + 's' : '—';
    const split = g.reply !== null && g.reply !== undefined && g.thinking !== null && g.thinking !== undefined
      ? `${t.reply} ${formatTokens(g.reply)} + ${t.thinking} ${formatTokens(g.thinking)}` : '';
    const ttft = seconds(g.ttft);
    const totalTime = seconds(g.duration);
    const timing = ttft !== '—' && totalTime !== '—' ? `${ttft}–${totalTime}` : ttft;
    const outputLine = g.output !== null && g.output !== undefined
      ? `\n${t.outputTip}: ${formatTokens(g.output)} tokens${split ? ` (${split})` : ''}`
      : '';
    const timingTitle = `${t.ttftTip}\nTTFT ${ttft} · ${t.streamTime} ${seconds(g.streaming)} · ${t.totalTime} ${totalTime}`;
    const totalTimeTitle = `${t.totalTimeTip}\nTTFT ${ttft} · ${t.streamTime} ${seconds(g.streaming)} · ${t.totalTime} ${totalTime}`;
    return {
      speed: g.tps !== null && g.tps !== undefined ? g.tps.toFixed(1) + ' tok/s' : '—',
      output: formatTokens(g.output),
      ttft,
      totalTime,
      timing,
      speedTitle: `${t.speedTip}${outputLine}`,
      outputTitle: `${t.outputTip}: ${formatTokens(g.output)} tokens${split ? ` (${split})` : ''}`,
      ttftTitle: t.ttftTip,
      totalTimeTitle,
      timingTitle,
    };
  }
  function generationMarkup() {
    return `<div data-generation-group="request"><div class="generation-grid"><div class="generation-row" data-generation-row="timing"><span>TTFT</span><span data-generation="timing">—</span></div><div class="generation-row" data-generation-row="speed"><span data-generation="speed">—</span></div></div></div>`;
  }
  function renderGeneration(root, generation, labels, prefs = {}) {
    const view = generationText(generation || {}, labels);
    for (const key of ['timing', 'speed']) {
      for (const node of root.querySelectorAll(`[data-generation="${key}"]`)) {
        node.hidden = false;
        if (node.textContent !== view[key]) node.textContent = view[key];
        if (node.title !== view[key + 'Title']) node.title = view[key + 'Title'];
      }
      for (const row of root.querySelectorAll(`[data-generation-row="${key}"]`)) {
        row.hidden = false;
        row.title = view[key + 'Title'];
      }
    }
    for (const block of root.querySelectorAll('[data-generation-block]')) block.hidden = prefs.showRequestMetrics === false || !generation || generation.requestIndex == null;
    return view;
  }
  function appearance(prefs = {}) {
    return { panelLayout: prefs.panelLayout || 'natural', density: prefs.density || 'compact', quotaIndicator: prefs.quotaIndicator || 'ring', labelCase: prefs.labelCase || 'lowercase', resetFormat: prefs.resetFormat === 'localized' ? 'localized' : 'compact', contextLayout: prefs.contextLayout === 'rows' ? 'rows' : 'columns', turnLayout: prefs.turnLayout === 'rows' ? 'rows' : 'columns', contextMarker: prefs.contextMarker === 'dot' ? 'dot' : 'square', turnMarker: prefs.turnMarker === 'dot' ? 'dot' : 'square', showContextBreakdown: String(prefs.showContextBreakdown !== false), columnLabel: String(prefs.columnLabel !== false), columnValue: String(prefs.columnValue !== false), columnPercent: String(prefs.columnPercent === true) };
  }
  function formatReset(isoStr, prefs = {}, now = Date.now()) {
    if (!isoStr) return '';
    const diffMs = new Date(isoStr).getTime() - now;
    if (!Number.isFinite(diffMs)) return '';
    const t = dictionaries[systemLocale(prefs)] || dictionaries.en;
    if (diffMs <= 0) return t.soon;
    const totalMin = Math.floor(diffMs / 60000);
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (appearance(prefs).resetFormat === 'localized') {
      const unit = (key, n) => t[key].replace('{n}', n);
      if (d > 0) return unit('resetDay', d) + t.resetJoin + unit('resetHour', h);
      if (h > 0) return unit('resetHour', h) + t.resetJoin + unit('resetMinute', m);
      return unit('resetMinuteOnly', Math.max(1, m));
    }
    if (d > 0) return d + 'd ' + String(h).padStart(2, '0') + 'h';
    if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    return Math.max(1, m) + 'm';
  }
  function apply(root, prefs = {}) {
    root.style.colorScheme = '';
    for (const key of ['--background', '--foreground', '--card', '--muted-foreground', '--secondary', '--secondary-foreground', '--border']) {
      if (root.style.getPropertyValue(key) !== '') root.style.removeProperty(key);
    }
    const visual = appearance(prefs);
    for (const [key, value] of Object.entries(visual)) root.dataset[key] = value;
    const fieldOrder = String(prefs.columnOrder || 'label,value,percent').split(',');
    for (const field of ['label', 'value', 'percent']) root.style.setProperty('--agy-order-' + field, String(Math.max(0, fieldOrder.indexOf(field))));
    const scale = { compact: [4, 6, 8, 10], standard: [6, 8, 10, 12], spacious: [8, 11, 12, 14] }[visual.density] || [4, 6, 8, 10];
    for (const [index, key] of ['--agy-row-gap', '--agy-section-gap', '--agy-pad-y', '--agy-pad-x'].entries()) root.style.setProperty(key, scale[index] + 'px');
    root.dataset.highlightActiveModel = prefs.highlightActiveModel === true ? 'true' : 'false';
    const language = systemLocale(prefs);
    root.dataset.language = language;
    const t = dictionaries[language];
    const settingsLanguage = dictionaries[prefs.settingsLanguage] ? prefs.settingsLanguage : 'zh-CN';
    const settings = root.querySelector('.settings');
    if (settings) settings.lang = settingsLanguage;
    for (const node of root.querySelectorAll('[data-i18n]')) {
      const dict = node.closest('.settings') ? dictionaries[settingsLanguage] : t;
      const value = dict[node.dataset.i18n];
      if (value && node.textContent !== value) node.textContent = value;
    }
    for (const node of root.querySelectorAll('[data-stats-i18n]')) {
      const value = t[node.dataset.statsI18n];
      if (value && node.textContent !== value) node.textContent = value;
    }
    applyQuotaTooltips(root, t);
    return t;
  }
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return { version: 61, dictionaries, locale, systemLocale, apply, appearance, formatReset, escapeHtml, formatTokens, cacheTooltip, cacheView, contextTooltips, renderContextTooltips, quotaTooltip, applyQuotaTooltips, alertView, renderAlerts, generationText, generationMarkup, renderGeneration, ...turnMethods };
}

export const getPresentationScript = () => `if (globalThis.__agyCapsulePresentation?.version !== 61) globalThis.__agyCapsulePresentation = (${createPresentation.toString()})(${createTurnPresentation.toString()});`;
