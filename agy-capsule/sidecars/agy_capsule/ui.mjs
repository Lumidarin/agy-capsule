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
      highlightActiveModelTip: 'Highlight the quota group matching the current model in the footer and sidebar, and dim non-active model groups.',
      hideUnavailableQuota: 'Hide absent quota windows',
      hideUnavailableQuotaTip: 'In the footer capsule, hide a missing 5h or Weekly window only when the other window has data. A real 0% remains visible. Keep placeholders if both are unknown. Does not change quota values or the full quota panel.',
      showCacheWarnings: 'Cache expiry warning',
      cacheWarningsTip: 'Turn the capsule icon and Cache row yellow at 3m (~1m countdown) and red/crossed out at 4m+, and include reminder notes in the Cache tooltip. Based on local time since last recorded activity; does not change actual server caching.',
      showContextWarnings: 'Context overload warning', showRequestErrors: 'Request failure capsule',
      contextWarningsTip: 'Only the capsule percentage turns yellow at 75% and red at 90%+, including 100%+. Icons and panel rows retain cache-status colors. No automatic popup or warning banner; context overflow is not a separate failure capsule.',
      requestErrorsTip: "Show a third capsule for quota exhaustion, 429, network, authentication, service or unknown failures.",
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
      showSpeed: 'Effective speed', showRequestMetrics: 'Last request',
      speedAnimation: 'Effects',
      speedAnimationTip: "Optional footer effect, off by default. The dot indicates this user turn is running (including tools), not live token streaming. Start each new user message at —; after the first completed request, retain this turn’s latest completed-request speed while later requests run. Update only on another completed request. When the turn stops, stop breathing; retain the color for 15 seconds, then gray. Red: <10 tok/s; yellow: 10–<25; green: ≥25. Requires Effective speed; respects reduced motion. Cache state is unchanged.",
      turnSpeedTip: 'Footer speed: latest completed model request in the turn started by your most recent user message. Show — until this turn has a completed request with valid speed data; never reuse a previous turn’s number. While a later request runs, retain the last completed result from this turn. Not live speed or a whole-turn average. Formula: (response/tool-call tokens + thinking tokens) ÷ (AGY-recorded TTFT + streaming duration), excluding tool execution. Exact AGY timer boundaries remain unverified.',
      saveFailed: 'Could not save. Please try again.',
      newChat: 'New conversation', cached: 'cached', lastTurn: 'Last turn', ago: 'ago',
      cachedInput: 'Cached input', lastActivity: 'Last recorded activity', cacheWarning: 'Approaching the 4m reminder threshold', cacheCold: '4m threshold reached; cache may be cold',
      context: 'Context details', quota: 'Model quotas',
      contextUsed: 'Used', contextLimit: 'Limit', contextRemaining: 'Remaining', uncachedInput: 'Uncached input', ofLimit: '{pct} of context limit', resetAt: 'Resets', resetUnknown: 'Reset time not reported', quotaRemaining: 'remaining',
      contextScope: 'Current request input context (excludes its new output).',
      turn0Tip: 'Starting context baseline for this cycle (system prompt and carried history).',
      readTip: 'Added context input (user messages, read files, and tool outputs).',
      writeTip: 'Prior model replies and tool calls kept in current context (excludes latest reply).',
      thinkTip: 'Prior model thinking kept in current context (excludes latest reply).',
      output: "Total output", reply: 'Response / tool calls', thinking: 'Thinking',
      requestTip: 'Last request', requestScopeTip: 'Timing and output speed from the latest completed model request.',
      totalTime: "Request duration", streamTime: 'Stream', generationSpeed: 'Effective speed', firstTokenWait: "First-token wait",
      speedTip: "Effective speed = total output ÷ request duration (TTFT + stream).",
      outputTip: "Output of latest request",
      ttftTip: "First-token wait to total duration of the latest request.",
      totalTimeTip: "Request duration (TTFT + stream); excludes tool execution.",
      appearanceSection: 'Appearance', featuresSection: 'Features',
      speedPairTip: 'Capsule speed: last completed request in the current turn (— until ready). Effects: breathing dot while running; holds speed color 15s after stopping (≥25 green, 10–25 yellow, <10 red).',
      requestSectionTip: 'Shows Last request (TTFT–total duration and effective speed of the latest recorded call) in panels. Independent of capsule speed.',
      turnSectionTip: 'Aggregates requests, elapsed wall time, write, and thinking tokens from your latest user message to completion.',
      panelLayout: 'Panel height', naturalLayout: 'Natural', matchedLayout: 'Matched',
      panelLayoutTip: 'Natural: shared spacing rules, height follows content. Matched: align the two footer panels by adding space to the shorter one. Does not stretch the sidebar or the failure panel.',
      density: 'Panel spacing', compact: 'Compact', standard: 'Standard', spacious: 'Spacious',
      densityTip: 'Use a shared spacing scale for context rows, quota rows, headings and section gaps. Applies to footer panels and sidebar statistics, not the settings controls.',
      quotaIndicator: 'Quota indicator', ring: 'Ring', bar: 'Bar',
      quotaIndicatorTip: 'Choose a ring or a horizontal bar for remaining quota. Applies to footer and sidebar; percentages and quota calculations stay the same.',
      labelCase: 'Label casing', lowercase: 'Lowercase', titlecase: 'Title case',
      resetFormat: 'Reset countdown', compactTime: 'Compact', localizedTime: 'Localized', localizedTimeSample: '4 hr 55 min',
      resetDay: '{n} d', resetHour: '{n} hr', resetMinute: '{n} min', resetMinuteOnly: '{n} min', resetJoin: ' ',
    },
    'zh-CN': {
      cache: '缓存', turn0: '首轮', read: '读取', think: '思考', write: '写入',
      used: '已用', fiveHours: '5小时', weekly: '每周', soon: '即将重置', active: '当前',
      settings: '显示设置', language: "显示语言",
      sidebarStats: '统计', sidebarSettings: '设置', sidebarNavigation: 'Sidebar 页面',
      settingsLanguage: '设置语言', highlightActiveModel: '突出当前模型',
      highlightActiveModelTip: '在底栏配额面板与侧边栏中高亮当前所选模型对应的配额组，并弱化其他非当前模型组。',
      hideUnavailableQuota: '隐藏不存在的配额窗口',
      hideUnavailableQuotaTip: '仅影响底栏胶囊：只有 Weekly 数据时隐藏空的 5h，只有 5h 数据时隐藏空的 Weekly。真实 0% 仍显示，两项都未知时保留占位；不改额度数值和完整配额面板。',
      showCacheWarnings: '缓存过期预警',
      cacheWarningsTip: '距最近记录满 3 分钟将胶囊图标与 Cache 行标黄（显示 ~1m 倒计时），满 4 分钟标红并划掉命中率，同时在 Cache 悬浮说明中附加提醒。仅基于本地时间估算，不影响服务端实际缓存。',
      showContextWarnings: '上下文过载预警', showRequestErrors: '请求失败胶囊',
      contextWarningsTip: '仅胶囊百分比在占用达到 75% 时标黄、90% 及以上标红，100%+ 同样处理。图标和面板行保留缓存状态配色。不自动弹窗、不加警告条；上下文超限不使用独立失败胶囊。',
      requestErrorsTip: "第三个胶囊统一显示额度耗尽、429 限流、断连、验证异常、服务繁忙及未知原因请求失败。",
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
      showSpeed: '有效速度', showRequestMetrics: '最近请求',
      speedAnimation: '动效',
      speedAnimationTip: "底栏可选效果，默认关闭。圆点呼吸表示本轮正在运行（可能包含工具执行），不表示实时流式速度。新用户消息开始时显示 —；首个请求完成后，保留本轮最近一次已完成请求的速度，后续请求运行时不清空，完成后才更新。本轮停止后不再呼吸，保色 15 秒再变灰。低于 10 tok/s 红色，10 至低于 25 黄色，25 及以上绿色。需开启“有效速度”；遵循减少动态效果偏好，不改变 Cache 状态。",
      turnSpeedTip: '底栏速度：从你最近一条用户消息开始，本轮最近一次已完成模型请求的有效速度。首个请求完成且取得有效速度数据前显示 —，不沿用上一轮数字；后续请求运行时保留本轮已有结果，完成后再更新。不是实时速度，也不是整轮平均速度。计算为（回复／工具调用指令 + 思考 token）÷（AGY 记录的 TTFT + 流式耗时），不含工具执行；AGY 的具体计时边界尚未确认。',
      saveFailed: '保存失败，请重试。',
      newChat: '新对话', cached: '缓存', lastTurn: '上一轮', ago: '前',
      cachedInput: '缓存输入', lastActivity: '最近记录距今', cacheWarning: '接近 4 分钟提醒阈值', cacheCold: '已达 4 分钟阈值，缓存可能已冷却',
      context: '上下文明细', quota: '模型配额',
      contextUsed: '已用', contextLimit: '上限', contextRemaining: '剩余', uncachedInput: '非缓存输入', ofLimit: '占上限 {pct}', resetAt: '重置时间', resetUnknown: '未提供重置时间', quotaRemaining: '剩余',
      contextScope: '最近一次请求的输入上下文（不含刚生成的输出）。',
      turn0Tip: '当前周期起始输入基线，包含系统提示词与初始历史。',
      readTip: '对话中新增的输入内容，包括用户消息、读取的文件与工具返回结果。',
      writeTip: '留在当前上下文中的累计回复与工具调用（不含最近一次生成）。',
      thinkTip: '留在当前上下文中的累计思考输出（不含最近一次生成）。',
      output: "总输出", reply: '回复/调用', thinking: '思考',
      requestTip: '最近请求', requestScopeTip: '最近一次已完成模型请求的耗时与输出速度。',
      totalTime: "请求耗时", streamTime: '流式耗时', generationSpeed: '有效速度', firstTokenWait: "首 token 等待",
      speedTip: "有效速度 = 总输出 ÷ 单次请求总耗时（首字等待 + 流式输出）。",
      outputTip: "最近一次请求输出",
      ttftTip: "首字等待耗时 – 单次请求总耗时（已包含首字等待）。",
      totalTimeTip: "请求总耗时（首字等待 + 流式输出，不含工具执行）。",
      appearanceSection: '外观', featuresSection: '功能',
      speedPairTip: '底栏速度：本轮最近一次已完成请求的速度（未完成显示 —）。动效：运行中圆点呼吸，结束后保色 15 秒再变灰（≥25 绿、10–25 黄、<10 红）。',
      requestSectionTip: '在面板展示最近一次请求的 TTFT–总耗时与有效速度，与底栏胶囊独立。',
      turnSectionTip: '从最近一条用户消息到结束，按整轮累计请求数、耗时、写入与思考。',
      panelLayout: '面板高度', naturalLayout: '自然高度', matchedLayout: '对齐高度',
      panelLayoutTip: '自然高度：共用间距规则，高度由内容决定。对齐高度：给较短面板增加留白，使底栏上下文与额度两个面板等高。不拉伸 sidebar 或失败面板。',
      density: '面板间距', compact: '紧凑', standard: '标准', spacious: '舒展',
      densityTip: '上下文行、配额行、标题与分组采用同一套间距尺度。同步影响底栏面板与 sidebar 统计区，不改变设置卡片本身。',
      quotaIndicator: '额度图形', ring: '圆环', bar: '进度条',
      quotaIndicatorTip: '用圆环或横向进度条展示剩余额度，同步影响底栏与 sidebar；百分比和额度计算不变。',
      labelCase: '面板大小写', lowercase: '全小写', titlecase: '首字母大写',
      resetFormat: '重置倒计时', compactTime: '简写', localizedTime: '本地化', localizedTimeSample: '4小时55分',
      resetDay: '{n}天', resetHour: '{n}小时', resetMinute: '{n}分', resetMinuteOnly: '{n}分钟', resetJoin: '',
    },
    'zh-TW': {
      cache: '快取', turn0: '首輪', read: '讀取', think: '思考', write: '寫入',
      used: '已用', fiveHours: '5小時', weekly: '每週', soon: '即將重設', active: '目前',
      settings: '顯示設定', language: "顯示語言",
      sidebarStats: '統計', sidebarSettings: '設定', sidebarNavigation: 'Sidebar 頁面',
      settingsLanguage: '設定語言', highlightActiveModel: '突出目前模型',
      highlightActiveModelTip: '在底欄配額面板與側邊欄中高亮目前所選模型對應的配額組，並弱化其他非目前模型組。',
      hideUnavailableQuota: '隱藏不存在的配額視窗',
      hideUnavailableQuotaTip: '僅影響底欄膠囊：只有 Weekly 資料時隱藏空的 5h，只有 5h 資料時隱藏空的 Weekly。真實 0% 仍顯示，兩項都未知時保留佔位；不改額度數值和完整配額面板。',
      showCacheWarnings: '快取過期預警',
      cacheWarningsTip: '距最近記錄滿 3 分鐘將膠囊圖示與 Cache 列標黃（顯示 ~1m 倒數），滿 4 分鐘標紅並劃掉命中率，同時於 Cache 懸浮說明附加提醒。僅依本機時間估算，不影響服務端實際快取。',
      showContextWarnings: '上下文過載預警', showRequestErrors: '請求失敗膠囊',
      contextWarningsTip: '僅膠囊百分比在佔用達到 75% 時標黃、90% 及以上標紅，100%+ 同樣處理。圖示和面板列保留快取狀態配色。不自動彈窗、不加警告條；上下文超限不使用獨立失敗膠囊。',
      requestErrorsTip: "第三個膠囊統一顯示額度耗盡、429 限流、斷連、驗證異常、服務繁忙及未知原因請求失敗。",
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
      showSpeed: '有效速度', showRequestMetrics: '最近請求',
      speedAnimation: '動效',
      speedAnimationTip: "底欄可選效果，預設關閉。圓點呼吸表示本輪正在執行（可能包含工具執行），不表示即時串流速度。新使用者訊息開始時顯示 —；首個請求完成後，保留本輪最近一次已完成請求的速度，後續請求執行時不清空，完成後才更新。本輪停止後不再呼吸，保色 15 秒再變灰。低於 10 tok/s 紅色，10 至低於 25 黃色，25 及以上綠色。需開啟「有效速度」；遵循減少動態效果偏好，不改變 Cache 狀態。",
      turnSpeedTip: '底欄速度：從你最近一條使用者訊息開始，本輪最近一次已完成模型請求的有效速度。首個請求完成且取得有效速度資料前顯示 —，不沿用上一輪數字；後續請求執行時保留本輪已有結果，完成後再更新。不是即時速度，也不是整輪平均速度。計算為（回覆／工具呼叫指令 + 思考 token）÷（AGY 記錄的 TTFT + 串流耗時），不含工具執行；AGY 的具體計時邊界尚未確認。',
      saveFailed: '儲存失敗，請重試。',
      newChat: '新對話', cached: '快取', lastTurn: '上一輪', ago: '前',
      cachedInput: '快取輸入', lastActivity: '最近記錄距今', cacheWarning: '接近 4 分鐘提醒閾值', cacheCold: '已達 4 分鐘閾值，快取可能已冷卻',
      context: '上下文明細', quota: '模型配額',
      contextUsed: '已用', contextLimit: '上限', contextRemaining: '剩餘', uncachedInput: '非快取輸入', ofLimit: '佔上限 {pct}', resetAt: '重設時間', resetUnknown: '未提供重設時間', quotaRemaining: '剩餘',
      contextScope: '最近一次請求的輸入上下文（不含剛產生的輸出）。',
      turn0Tip: '目前週期起始輸入基線，包含系統提示詞與初始歷史。',
      readTip: '對話中新增的輸入內容，包括使用者訊息、讀取的檔案與工具回傳結果。',
      writeTip: '留在目前上下文中的累計回覆與工具呼叫（不含最近一次生成）。',
      thinkTip: '留在目前上下文中的累計思考輸出（不含最近一次生成）。',
      output: "總輸出", reply: '回覆/呼叫', thinking: '思考',
      requestTip: '最近請求', requestScopeTip: '最近一次已完成模型請求的耗時與輸出速度。',
      totalTime: "請求耗時", streamTime: '串流耗時', generationSpeed: '有效速度', firstTokenWait: "首 token 等待",
      speedTip: "有效速度 = 總輸出 ÷ 單次請求總耗時（首字等待 + 串流輸出）。",
      outputTip: "最近一次請求輸出",
      ttftTip: "首字等待耗時 – 單次請求總耗時（已包含首字等待）。",
      totalTimeTip: "請求總耗時（首字等待 + 串流輸出，不含工具執行）。",
      appearanceSection: '外觀', featuresSection: '功能',
      speedPairTip: '底欄速度：本輪最近一次已完成請求的速度（未完成顯示 —）。動效：執行中圓點呼吸，結束後保色 15 秒再變灰（≥25 綠、10–25 黃、<10 紅）。',
      requestSectionTip: '於面板展示最近一次請求的 TTFT–總耗時與有效速度，與底欄膠囊獨立。',
      turnSectionTip: '從最近一條使用者訊息到結束，依整輪累計請求數、耗時、寫入與思考。',
      panelLayout: '面板高度', naturalLayout: '自然高度', matchedLayout: '對齊高度',
      panelLayoutTip: '自然高度：共用間距規則，高度由內容決定。對齊高度：為較短面板增加留白，使底欄上下文與額度兩個面板等高。不拉伸 sidebar 或失敗面板。',
      density: '面板間距', compact: '緊湊', standard: '標準', spacious: '舒展',
      densityTip: '上下文列、配額列、標題與分組採用同一套間距尺度。同步影響底欄面板與 sidebar 統計區，不改變設定卡片本身。',
      quotaIndicator: '額度圖形', ring: '圓環', bar: '進度條',
      quotaIndicatorTip: '用圓環或橫向進度條展示剩餘額度，同步影響底欄與 sidebar；百分比和額度計算不變。',
      labelCase: '面板大小寫', lowercase: '全小寫', titlecase: '首字母大寫',
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
    return { panelLayout: prefs.panelLayout || 'natural', density: prefs.density || 'compact', quotaIndicator: prefs.quotaIndicator || 'ring', labelCase: prefs.labelCase || 'lowercase', resetFormat: prefs.resetFormat === 'localized' ? 'localized' : 'compact' };
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
  return { version: 56, dictionaries, locale, systemLocale, apply, appearance, formatReset, escapeHtml, formatTokens, cacheTooltip, cacheView, contextTooltips, renderContextTooltips, quotaTooltip, applyQuotaTooltips, alertView, renderAlerts, generationText, generationMarkup, renderGeneration, ...turnMethods };
}

export const getPresentationScript = () => `if (globalThis.__agyCapsulePresentation?.version !== 56) globalThis.__agyCapsulePresentation = (${createPresentation.toString()})(${createTurnPresentation.toString()});`;
