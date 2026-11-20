// Sidebar usage history: token activity summary and heatmap.
// Kept self-contained so the sidebar script can embed it directly beside presentation helpers.
export function createUsagePresentation(formatTokens, escapeHtml) {
  const dictionaries = {
    en: {
      usageActivity: 'Token activity',
      usageScopeTip: 'Local conversations in this product folder: uncached input, cache reads, cache writes and output. Totals include cache reads (no direct conversion to quota), exclude deleted chats and are not a bill. Days follow local time; weeks start Monday.',
      usageDaily: 'Daily', usageWeekly: 'Weekly',
      usageToday: 'Today', usageThisWeek: 'This week', usageThisMonth: 'This month', usageAllTime: 'All time',
      usageAllTimeNote: 'Current local conversations only (deleted chats are excluded).',
      usageUncached: 'Uncached', usageCacheRead: 'Cache read', usageCacheWrite: 'Cache write', usageOutput: 'Output',
      usageLess: 'Less', usageMore: 'More', usageRequests: '{n} request(s)', usageSince: 'Since {date}',
      usageLoading: 'Reading local conversations…', usageEmpty: 'No usage recorded yet.', usageUnread: '{n} conversation file(s) could not be read.',
    },
    'zh-CN': {
      usageActivity: 'Token 活动',
      usageScopeTip: '汇总当前产品目录的本机对话：非缓存输入、缓存读取、缓存写入和输出。合计包含缓存读取（与额度消耗无直接换算），不含已删对话，不等于账单。按本机时区划分日期，每周从周一开始。',
      usageDaily: '每日', usageWeekly: '每周',
      usageToday: '今日', usageThisWeek: '本周', usageThisMonth: '本月', usageAllTime: '累计',
      usageAllTimeNote: '仅统计现存本机对话（删除对话后数字会相应减少）。',
      usageUncached: '非缓存输入', usageCacheRead: '缓存读取', usageCacheWrite: '缓存写入', usageOutput: '输出',
      usageLess: '少', usageMore: '多', usageRequests: '{n} 次请求', usageSince: '始于 {date}',
      usageLoading: '正在读取本机对话…', usageEmpty: '暂无用量记录。', usageUnread: '{n} 个对话文件未能读取。',
    },
    'zh-TW': {
      usageActivity: 'Token 活動',
      usageScopeTip: '彙總目前產品目錄的本機對話：非快取輸入、快取讀取、快取寫入和輸出。合計包含快取讀取（與額度消耗無直接換算），不含已刪對話，不等於帳單。依本機時區劃分日期，每週從週一開始。',
      usageDaily: '每日', usageWeekly: '每週',
      usageToday: '今日', usageThisWeek: '本週', usageThisMonth: '本月', usageAllTime: '累計',
      usageAllTimeNote: '僅統計現存本機對話（刪除對話後數字會相應減少）。',
      usageUncached: '非快取輸入', usageCacheRead: '快取讀取', usageCacheWrite: '快取寫入', usageOutput: '輸出',
      usageLess: '少', usageMore: '多', usageRequests: '{n} 次請求', usageSince: '始於 {date}',
      usageLoading: '正在讀取本機對話…', usageEmpty: '尚無用量記錄。', usageUnread: '{n} 個對話檔案未能讀取。',
    },
  };
  const WEEKS = 53;
  const COUNTERS = ['uncached', 'cacheRead', 'cacheWrite', 'output'];
  const pad = value => String(value).padStart(2, '0');
  // Calendar days are moved around as UTC dates, so a daylight-saving change never shifts one.
  const toDate = day => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
  const toDay = date => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const addDays = (day, count) => {
    const date = toDate(day);
    date.setUTCDate(date.getUTCDate() + count);
    return toDay(date);
  };
  const weekStart = day => addDays(day, -((toDate(day).getUTCDay() + 6) % 7)); // weeks start on Monday
  function localDay(epochMs = Date.now()) {
    const date = new Date(epochMs);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  const emptyParts = () => ({ requests: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  const addParts = (target, source = {}) => {
    target.requests += source.requests || 0;
    for (const key of COUNTERS) target[key] += source[key] || 0;
  };
  const tokensOf = (bucket = {}) => (bucket.uncached || 0) + (bucket.cacheRead || 0) + (bucket.cacheWrite || 0) + (bucket.output || 0);
  const exact = value => Number(value || 0).toLocaleString('en-US');
  const requestsText = (count, t) => t.usageRequests.replace('{n}', exact(count));
  const breakdownLine = (bucket, t) => `${t.usageUncached} ${exact(bucket.uncached)} · ${t.usageCacheRead} ${exact(bucket.cacheRead)} · ${t.usageCacheWrite} ${exact(bucket.cacheWrite)} · ${t.usageOutput} ${exact(bucket.output)}`;

  function usageTotals(data = {}, today = localDay()) {
    const week = weekStart(today);
    const month = today.slice(0, 7);
    const parts = { today: emptyParts(), week: emptyParts(), month: emptyParts(), all: emptyParts() };
    if (data.undated) addParts(parts.all, data.undated);
    let since = '';
    for (const day of data.days || []) {
      addParts(parts.all, day);
      since ||= day.date;
      if (day.date > today) continue;
      if (day.date === today) addParts(parts.today, day);
      if (day.date >= week) addParts(parts.week, day);
      if (day.date.slice(0, 7) === month) addParts(parts.month, day);
    }
    return {
      today: tokensOf(parts.today),
      week: tokensOf(parts.week),
      month: tokensOf(parts.month),
      all: tokensOf(parts.all),
      requests: parts.all.requests,
      since,
      parts,
    };
  }
  // Four steps on a square-root scale, so that one heavy day does not flatten all the others.
  const heatLevel = (tokens, max) => (tokens > 0 && max > 0 ? Math.max(1, Math.ceil(Math.sqrt(tokens / max) * 4)) : 0);
  // The last weeks as columns, oldest first; the weekly view has one cell per column.
  function activityView(data = {}, { today = localDay(), scale = 'day', weeks = WEEKS } = {}) {
    const byDate = new Map((data.days || []).map(day => [day.date, day]));
    const first = addDays(weekStart(today), -7 * (weeks - 1));
    const columns = [];
    let max = 0;
    for (let week = 0; week < weeks; week++) {
      const from = addDays(first, week * 7);
      const days = Array.from({ length: 7 }, (_, offset) => {
        const date = addDays(from, offset);
        const day = byDate.get(date);
        return {
          from: date, to: date,
          tokens: tokensOf(day),
          requests: day?.requests || 0,
          uncached: day?.uncached || 0,
          cacheRead: day?.cacheRead || 0,
          cacheWrite: day?.cacheWrite || 0,
          output: day?.output || 0,
          future: date > today,
        };
      });
      const sum = key => days.reduce((total, day) => total + day[key], 0);
      const cells = scale === 'week'
        ? [{
          from, to: addDays(from, 6),
          tokens: sum('tokens'), requests: sum('requests'),
          uncached: sum('uncached'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), output: sum('output'),
          future: false,
        }]
        : days;
      for (const cell of cells) max = Math.max(max, cell.tokens);
      // A column is labelled with a month when its week is the first to start in it.
      columns.push({ month: week > 0 && from.slice(0, 7) !== addDays(from, -7).slice(0, 7) ? from.slice(0, 7) : '', cells });
    }
    for (const column of columns) for (const cell of column.cells) cell.level = heatLevel(cell.tokens, max);
    return { scale: scale === 'week' ? 'week' : 'day', columns };
  }
  function activityHtml(data, { today = localDay(), scale = 'day', language = 'en' } = {}) {
    const t = dictionaries[language] || dictionaries.en;
    const head = `<div class="usage-head"><span class="usage-title" title="${escapeHtml(t.usageScopeTip)}">${escapeHtml(t.usageActivity)}</span><span class="usage-seg" role="group">`
      + [['day', t.usageDaily], ['week', t.usageWeekly]].map(([value, label]) => `<button type="button" data-usage-scale="${value}" aria-pressed="${value === scale}">${escapeHtml(label)}</button>`).join('')
      + '</span></div>';
    if (!data) return head + `<div class="usage-note">${escapeHtml(t.usageLoading)}</div>`;
    // Totals are incomplete while a conversation could not be read; say so instead of hiding it.
    const unread = data.unread > 0 ? `<div class="usage-note">${escapeHtml(t.usageUnread.replace('{n}', exact(data.unread)))}</div>` : '';
    const totals = usageTotals(data, today);
    if (!totals.requests) return head + `<div class="usage-note">${escapeHtml(t.usageEmpty)}</div>` + unread;
    const view = activityView(data, { today, scale });
    const monthName = new Intl.DateTimeFormat(language, { month: 'short', timeZone: 'UTC' });
    const totalTip = (value, part, extra = '') => {
      const lines = value > 0
        ? [`${exact(value)} tokens · ${requestsText(part.requests, t)}`, breakdownLine(part, t)]
        : ['0 tokens'];
      if (extra) lines.push(extra);
      return lines.join('\n');
    };
    const total = (key, value, part, extra = '') => `<div class="usage-total" title="${escapeHtml(totalTip(value, part, extra))}"><span>${escapeHtml(t[key])}</span><b>${formatTokens(value)}</b></div>`;
    const span = item => (item.from === item.to ? item.from : `${item.from} – ${item.to}`);
    const cellTip = item => (item.tokens
      ? `${span(item)} · ${exact(item.tokens)} tokens · ${requestsText(item.requests, t)}\n${breakdownLine(item, t)}`
      : span(item));
    const cell = item => (item.future ? '<i class="usage-cell" data-future></i>'
      : `<i class="usage-cell" data-level="${item.level}" title="${escapeHtml(cellTip(item))}"></i>`);
    const since = [totals.since && t.usageSince.replace('{date}', totals.since), requestsText(totals.requests, t)].filter(Boolean).join(' · ');
    return head
      + `<div class="usage-totals">${total('usageToday', totals.today, totals.parts.today)}${total('usageThisWeek', totals.week, totals.parts.week)}${total('usageThisMonth', totals.month, totals.parts.month)}${total('usageAllTime', totals.all, totals.parts.all, t.usageAllTimeNote)}</div>`
      + `<div class="usage-heat" data-scale="${view.scale}" role="img" aria-label="${escapeHtml(t.usageActivity)}">`
      + view.columns.map(column => `<div class="usage-heat-col">${column.month ? `<span class="usage-heat-month">${escapeHtml(monthName.format(toDate(column.month + '-01')))}</span>` : ''}${column.cells.map(cell).join('')}</div>`).join('')
      + '</div>'
      + `<div class="usage-foot"><span>${escapeHtml(since)}</span><span class="usage-legend">${escapeHtml(t.usageLess)}${[0, 1, 2, 3, 4].map(level => `<i class="usage-cell" data-level="${level}"></i>`).join('')}${escapeHtml(t.usageMore)}</span></div>`
      + unread;
  }
  return { dictionaries, localDay, usageTotals, activityView, activityHtml };
}
