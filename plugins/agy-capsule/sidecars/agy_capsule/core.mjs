/**
 * Shared pure core for agy-capsule:
 *   - Node-only binary protobuf decoders & image header parsers
 *   - Isomorphic core (`createCapsuleCore`) shared verbatim with the browser bundle:
 *     i18n (en / zh-CN / zh-TW), generation telemetry summarizer, error classifier,
 *     7-category step analyzer & largest-remainder share convergence, and quota matcher.
 */

export function readVarint(buf, offset) {
  let val = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return [Number(val), i];
    }
    shift += 7n;
    if (shift > 63n) break;
  }
  return [Number(val), i];
}

export function parsePbMap(input) {
  const buf = input ? (Buffer.isBuffer(input) ? input : Buffer.from(input)) : Buffer.alloc(0);
  const fields = new Map();
  let i = 0;
  while (i < buf.length) {
    try {
      const [tag, nextI] = readVarint(buf, i);
      i = nextI;
      const fn = tag >>> 3;
      const wt = tag & 7;
      if (fn === 0) break;
      if (!fields.has(fn)) fields.set(fn, []);
      if (wt === 0) {
        const [val, nI] = readVarint(buf, i);
        i = nI;
        fields.get(fn).push(val);
      } else if (wt === 2) {
        const [len, nI] = readVarint(buf, i);
        i = nI;
        if (len < 0 || i + len > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + len));
        i += len;
      } else if (wt === 5) {
        if (i + 4 > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + 4));
        i += 4;
      } else if (wt === 1) {
        if (i + 8 > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + 8));
        i += 8;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return fields;
}

export function parseGenMetadataRow(idx, data) {
  if (!data) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const top = parsePbMap(buf);
  if (!top.has(1)) return null;
  const m1 = parsePbMap(top.get(1)[0]);
  const usageBuf = m1.has(4) ? m1.get(4)[0] : Buffer.alloc(0);
  const usage = parsePbMap(usageBuf);

  const uncachedIn = usage.has(2) ? Number(usage.get(2)[0]) || 0 : 0;
  const cachedIn = usage.has(5) ? Number(usage.get(5)[0]) || 0 : 0;
  const thinkTokens = usage.has(9) ? Number(usage.get(9)[0]) || 0 : 0;
  const outTokens = usage.has(10) ? Number(usage.get(10)[0]) || 0 : 0;
  const inputTokens = uncachedIn + cachedIn;

  let maxContextTokens = 0;
  if (m1.has(9)) {
    const m9 = parsePbMap(m1.get(9)[0]);
    if (m9.has(10)) {
      const m10 = parsePbMap(m9.get(10)[0]);
      if (m10.has(4)) {
        maxContextTokens = Number(m10.get(4)[0]) || 0;
      }
    }
  }

  let lastStepIndex = -1;
  if (m1.has(20)) {
    for (const kvBuf of m1.get(20)) {
      const kv = parsePbMap(kvBuf);
      const key = kv.has(1) ? Buffer.from(kv.get(1)[0]).toString('utf8') : '';
      if (key === 'last_step_index' && kv.has(2)) {
        const n = Number(Buffer.from(kv.get(2)[0]).toString('utf8'));
        if (Number.isFinite(n)) lastStepIndex = n;
        break;
      }
    }
  }

  return {
    turn: idx,
    uncachedIn,
    cachedIn,
    inputTokens,
    outTokens,
    thinkTokens,
    actualTokens: inputTokens + outTokens,
    maxContextTokens,
    lastStepIndex,
  };
}

export function parseStepTimestampMs(metadata) {
  if (!metadata) return 0;
  const buf = Buffer.isBuffer(metadata) ? metadata : Buffer.from(metadata);
  const sm = parsePbMap(buf);
  if (!sm.has(1)) return 0;
  const tsMap = parsePbMap(sm.get(1)[0]);
  const sec = tsMap.has(1) ? Number(tsMap.get(1)[0]) : 0;
  const nanos = tsMap.has(2) ? Number(tsMap.get(2)[0]) : 0;
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  const ms = sec * 1000 + (Number.isFinite(nanos) ? Math.floor(nanos / 1e6) : 0);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export function findCompactionEpochStart(turns, checkpointStepIndices = []) {
  if (!Array.isArray(turns) || turns.length === 0) return 0;
  let epochStart = 0;
  for (const cpIdx of checkpointStepIndices) {
    const postIdx = turns.findIndex((t) => t.lastStepIndex >= cpIdx);
    if (postIdx >= 0) {
      epochStart = postIdx;
      break;
    }
  }
  for (let i = epochStart + 1; i < turns.length; i++) {
    if (turns[i - 1].inputTokens > 0 && turns[i].inputTokens < turns[i - 1].inputTokens * 0.7) {
      epochStart = i;
    }
  }
  return epochStart;
}

export function getImageDimensions(buf) {
  try {
    if (!buf || buf.length < 10) return { width: null, height: null };
    // PNG
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF
    if (buf.length >= 10 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // BMP
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }
    // WEBP
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') {
        return {
          width: 1 + buf.readUIntLE(24, 3),
          height: 1 + buf.readUIntLE(27, 3),
        };
      }
      if (chunk === 'VP8 ' && buf.length >= 30) {
        return {
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff,
        };
      }
      if (chunk === 'VP8L' && buf.length >= 25) {
        const b0 = buf[21];
        const b1 = buf[22];
        const b2 = buf[23];
        const b3 = buf[24];
        return {
          width: 1 + (((b1 & 0x3f) << 8) | b0),
          height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        };
      }
    }
    // JPEG
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buf[offset + 1];
        if (marker === 0xff) {
          offset++;
          continue;
        }
        if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        const len = buf.readUInt16BE(offset + 2);
        if (len < 2) break;
        offset += 2 + len;
      }
    }
  } catch {}
  return { width: null, height: null };
}

export function calcImageTokens(w, h) {
  if (!w || !h) return [258, 1120];
  if (w <= 384 && h <= 384) return [258, 258];
  const tiles = Math.ceil(w / 768) * Math.ceil(h / 768);
  const tok = tiles * 258;
  return [tok, Math.max(tok, w > 384 || h > 384 ? 1120 : 258)];
}

/**
 * Pure isomorphic capsule core factory.
 * Must stay 100% self-contained with zero references to outer scope so
 * `getBrowserCoreScript()` can embed `createCapsuleCore.toString()` verbatim.
 */
export function createCapsuleCore() {
  const SUPPORTED_LOCALES = ['en', 'zh-CN', 'zh-TW'];

  function cleanLocaleToken(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw
      .trim()
      .replace(/\.[a-z0-9_-]+$/i, '')
      .replace(/@[a-z0-9_-]+$/i, '')
      .replace(/_/g, '-')
      .toLowerCase();
  }

  function isIgnoredLocaleToken(token) {
    return !token || token === 'c' || token === 'posix' || token === 'und' || token === 'auto';
  }

  function normalizeLocale(input, fallback = 'en') {
    const fb = SUPPORTED_LOCALES.includes(fallback) ? fallback : 'en';
    const s = cleanLocaleToken(input);
    if (isIgnoredLocaleToken(s)) return fb;
    if (
      s === 'zh-tw' ||
      s === 'zh-hk' ||
      s === 'zh-mo' ||
      s === 'cht' ||
      s === 'tc' ||
      s === 'tw' ||
      s.startsWith('zh-hant') ||
      (s.startsWith('zh-') && (s.includes('-tw') || s.includes('-hk') || s.includes('-mo') || s.includes('hant')))
    ) {
      return 'zh-TW';
    }
    if (s === 'zh' || s === 'chs' || s === 'sc' || s === 'cn' || s.startsWith('zh-')) {
      return 'zh-CN';
    }
    if (s === 'en' || s === 'english' || s.startsWith('en-')) {
      return 'en';
    }
    return fb;
  }

  function detectLocaleFromCandidates(candidates, fallback = 'en') {
    const fb = SUPPORTED_LOCALES.includes(fallback) ? fallback : 'en';
    if (Array.isArray(candidates)) {
      for (const raw of candidates) {
        const token = cleanLocaleToken(raw);
        if (!isIgnoredLocaleToken(token)) {
          return normalizeLocale(token, fb);
        }
      }
    }
    return fb;
  }

  const I18N = {
    en: {
      langShort: 'EN',
      langName: 'English',
      langTitleAuto: (name) => `Language · Auto (${name}) · Click to switch`,
      langTitlePinned: (name) => `Language · ${name} · Click to switch`,
      themeAuto: (isLight) => `Auto (${isLight ? 'Light' : 'Dark'})`,
      themeLight: 'Light',
      themeDark: 'Dark',
      themeTitle: (mode) => `Theme · ${mode} · Click to switch`,
      refreshTitle: 'Rescan conversation & attachments',
      ctxCapsuleAria: 'Context window, cache & speed monitor',
      quotaCapsuleAria: 'Model quota monitor',
      cacheLabel: 'Cache',
      cacheWarmTip: (c, t, ago) => `Cache hit ${c} / ${t} tokens · Last turn ${ago} ago`,
      cacheWarnTip: (c, t, ago, rem) => `Cache hit ${c} / ${t} tokens · Idle ${ago} (expires in ~${rem}m)`,
      cacheExpiredTag: 'Expired',
      cacheExpiredTip: (c, t, ago) => `Cached ${c} / ${t} tokens · Idle ${ago} (>4m likely cold)`,
      cacheIdleTip: '0 / 0 cached · New conversation',
      usedPctFmt: (pct) => `${pct}% used`,
      noActiveChat: 'No active chat',
      waitingRequestData: 'Waiting for model response',
      tokensNoLimit: 'tokens (limit unavailable)',
      tokensLocalEst: 'tokens (local estimate)',
      approxVal: (v) => `~${v}`,
      leftVal: (v) => `${v} left`,
      approxLeftVal: (v) => `~${v} left`,
      zeroLeft: '0 left',
      overLimit: (lim) => `Over ${lim} limit`,
      overServerLimit: 'Over server capacity limit',
      statusIdle: 'Idle',
      statusOk: 'OK',
      statusHigh: 'High',
      statusTight: 'Tight',
      statusOverflow: 'Overflow',
      statusEst: 'Est.',
      statusRecorded: 'Recorded',
      statusReady: 'Ready',
      statusSyncing: 'Syncing',
      chipCache: (v) => `Cached ${v}`,
      chipInput: (v) => `Fresh in ${v}`,
      chipOutput: (v) => `Out ${v}`,
      hintEst: 'Client estimate; exact billed tokens update on reply',
      hintNoCalls: 'No billed turns yet; showing step breakdown',
      hintSyncing: 'Syncing conversation data…',
      alertHighOccupancy: 'Run /compact or start a new chat',
      alertUnknownFiles: (n) => `${n} ${n === 1 ? 'file' : 'files'} unparsed locally`,
      speedLabel: 'Speed',
      speedLabelTitle: 'Overall = Output ÷ Total time (incl. TTFT)',
      ttftLabel: 'TTFT',
      ttftLabelTitle: 'Time to First Token',
      durationLabel: 'Duration',
      outputLabel: 'Output',
      speedMeasuring: 'Live',
      speedGenerating: 'Generating…',
      speedStreamingTps: (tps) => `Streaming ${tps} tok/s`,
      speedIncludesTtft: 'Includes TTFT',
      speedTtftShare: (pct) => `TTFT ${pct}%`,
      speedTtftDetail: (sec, pct) => `TTFT ${sec}${pct != null ? ` (${pct}%)` : ''}`,
      timingTip: (ttft, st, dur) =>
        [ttft ? `TTFT ${ttft}` : '', st ? `Streaming ${st}` : '', dur ? `Total ${dur}` : ''].filter(Boolean).join(' · '),
      ttftTitle: (s) => `Time to first token: ${s}s`,
      durTitle: (d, st) => `Total ${d}s${st != null ? ` · Streaming ${st}s` : ''}`,
      outTitle: (o, r, thk) => (thk ? `Output ${o} tokens · Reply ${r} + Thinking ${thk}` : `Output ${o} tokens`),
      speed: { fast: 'Fast', smooth: 'Smooth', fair: 'Fair', slow: 'Slow' },
      drawerTitle: 'Context Breakdown',
      stepsCount: (n) => `${n} ${n === 1 ? 'step' : 'steps'}`,
      stepsTitleCompacted: (s, tot, u, a) => `${s} active / ${tot} total steps · ${u} prompts · ${a} replies`,
      stepsTitleNormal: (s, u, a) => `${s} ${s === 1 ? 'step' : 'steps'} · ${u} prompts · ${a} replies`,
      scanning: 'Scanning…',
      pendingScan: 'Pending',
      totalVal: (v, inc) => `Total ${v}${inc ? ' +' : ''}`,
      approxTotalVal: (v, inc) => `~${v}${inc ? ' +' : ''}`,
      unknownShare: 'Unknown',
      rowTipActual: (tok, pct) => `~${tok} tokens (${pct})`,
      rowTipZero: '0 tokens',
      rowTipShare: (pct) => `${pct} of active context`,
      fileJoiner: ', ',
      moreFiles: (n) => ` (${n} files total)`,
      filesLine: (list) => `Files · ${list}`,
      compFootnote: 'Weighted by active context window sections',
      updatedAt: (ts) => `Updated ${ts}`,
      catSystem: 'System',
      catTools: 'Tools',
      catAssistant: 'Model',
      catThinking: 'Think',
      catUser: 'User',
      catSummaries: 'Summary',
      catAttachment: 'Files',
      catFullSystem: 'System Prompt & Tools',
      catFullTools: 'Tool Calls & Outputs',
      catFullAssistant: 'Model Responses',
      catFullThinking: 'Thinking Process',
      catFullUser: 'User Messages',
      catFullSummaries: 'Compacted Summaries',
      catFullAttachment: 'Attachments',
      outCompact: (v) => `Out ${v}`,
      timingCompact: (ttft, dur) => `TTFT ${ttft} · ${dur}`,
      quotaTitle: 'Model Quotas',
      quotaActiveBadge: 'Active',
      quotaFiveHours: '5 Hours',
      quotaWeekly: 'Weekly',
      quotaSoon: 'soon',
      quotaNoData: 'Quota data unavailable',
      quotaRowTip: (pool, win, pct, rst) => `${pool} · ${win} · ${pct} left${rst ? ` (resets ${rst})` : ''}`,
      poolSuffix: ' Quota Pool',
      defaultPool: 'Model Quota Pool',
      quotaSuffix: ' quota',
      defaultQuota: 'Model quota',
      inlineImage: 'Inline image',
      inlineAttachment: 'Inline attachment',
      errors: {
        noneTitle: 'Healthy',
        noneBadge: 'OK',
        overflowTitle: 'Context Limit Exceeded',
        overflowBadge: 'Overflow',
        overflowDetail: (l) => `Over${l ? ` ${l}` : ''} limit · /compact or new chat`,
        quotaTitle: 'Quota Exhausted',
        quotaBadge: 'No Quota',
        quotaDetail: (p, r) => `${p} exhausted${r ? ` (resets ~${r})` : ''}. Switch to another available model`,
        rateTitle: 'Rate Limited',
        rateBadge: 'Rate Limit',
        rateDetail: (s) => `Server rate limit reached (429)${s ? `. Retry in ${s}s` : '. Please retry shortly'}`,
        canceledTitle: 'Canceled',
        canceledBadge: 'Canceled',
        canceledDetail: 'Last generation was canceled; showing most recent valid context',
        authTitle: 'Authentication Error',
        authBadge: 'Auth',
        authDetail: 'Authentication failed or insufficient permissions. Check your sign-in status',
        unavailTitle: 'Service Busy',
        unavailBadge: 'Busy',
        unavailDetail: 'Model server is temporarily overloaded or under maintenance. Please retry later',
        netTitle: 'Network Error',
        netBadge: 'Network',
        netDefault: 'connection failed or timed out',
        netTimeout: 'connection or read timeout',
        netReset: 'connection reset by peer',
        netRefused: 'connection refused',
        netDns: 'DNS lookup failed',
        netEof: 'unexpected EOF',
        netDetail: (reason) => `Network error (${reason}), not a context limit issue`,
        unknownTitle: 'Request Failed',
        unknownBadge: 'Error',
        unknownDetail: (diag) => `Request failed (${diag})`,
      },
    },
    'zh-CN': {
      langShort: '简',
      langName: '简体中文',
      langTitleAuto: (name) => `语言 · 跟随 IDE (${name}) · 点击切换`,
      langTitlePinned: (name) => `语言 · ${name} · 点击切换`,
      themeAuto: (isLight) => `跟随 IDE (当前${isLight ? '浅色' : '深色'})`,
      themeLight: '固定浅色',
      themeDark: '固定深色',
      themeTitle: (mode) => `主题 · ${mode} · 点击切换`,
      refreshTitle: '重新扫描对话与附件',
      ctxCapsuleAria: '上下文窗口、缓存与生成速率监控',
      quotaCapsuleAria: '模型配额监控',
      cacheLabel: '缓存',
      cacheWarmTip: (c, t, ago) => `缓存命中 ${c} / ${t} tokens · 上一轮 ${ago} 前`,
      cacheWarnTip: (c, t, ago, rem) => `缓存命中 ${c} / ${t} tokens · 闲置 ${ago} (约 ${rem}m 后过期)`,
      cacheExpiredTag: '已过期',
      cacheExpiredTip: (c, t, ago) => `缓存记录 ${c} / ${t} tokens · 闲置 ${ago} (逾 4m 可能已失效)`,
      cacheIdleTip: '0 / 0 缓存 · 新对话',
      usedPctFmt: (pct) => `已用 ${pct}%`,
      noActiveChat: '尚未开启对话',
      waitingRequestData: '等待首次模型响应',
      tokensNoLimit: 'tokens (未提供上限)',
      tokensLocalEst: 'tokens (本地估算)',
      approxVal: (v) => `约 ${v}`,
      leftVal: (v) => `剩余 ${v}`,
      approxLeftVal: (v) => `约剩 ${v}`,
      zeroLeft: '剩余 0',
      overLimit: (lim) => `超出 ${lim} 上限`,
      overServerLimit: '超出服务器容量上限',
      statusIdle: '待命',
      statusOk: '正常',
      statusHigh: '偏高',
      statusTight: '吃紧',
      statusOverflow: '超限',
      statusEst: '估算',
      statusRecorded: '已记录',
      statusReady: '就绪',
      statusSyncing: '同步中',
      chipCache: (v) => `缓存读取 ${v}`,
      chipInput: (v) => `新增输入 ${v}`,
      chipOutput: (v) => `本轮输出 ${v}`,
      hintEst: '当前为客户端估算，模型回复后更新精确用量',
      hintNoCalls: '尚无计费轮次，下方显示步骤构成估算',
      hintSyncing: '正在同步对话数据…',
      alertHighOccupancy: '建议 /compact 压缩或开启新对话',
      alertUnknownFiles: (n) => `${n} 个附件未本地解析，实际用量可能略高`,
      speedLabel: '整体速率',
      speedLabelTitle: '整体速率 = 产出 ÷ 总耗时 (含 TTFT)',
      ttftLabel: '首字延迟',
      ttftLabelTitle: '首字响应时间 (TTFT)',
      durationLabel: '总耗时',
      outputLabel: '本轮产出',
      speedMeasuring: '计算中',
      speedGenerating: '生成中…',
      speedStreamingTps: (tps) => `纯流式 ${tps} tok/s`,
      speedIncludesTtft: '含首字延迟计算',
      speedTtftShare: (pct) => `首字占 ${pct}%`,
      speedTtftDetail: (sec, pct) => `TTFT ${sec}${pct != null ? ` (占 ${pct}%)` : ''}`,
      timingTip: (ttft, st, dur) =>
        [ttft ? `首字 (TTFT) ${ttft}` : '', st ? `流式 ${st}` : '', dur ? `总耗时 ${dur}` : ''].filter(Boolean).join(' · '),
      ttftTitle: (s) => `首字延迟 ${s}s`,
      durTitle: (d, st) => `总耗时 ${d}s${st != null ? ` · 流式输出 ${st}s` : ''}`,
      outTitle: (o, r, thk) => (thk ? `本轮产出 ${o} tokens · 回复 ${r} + 思考 ${thk}` : `本轮产出 ${o} tokens`),
      speed: { fast: '极速', smooth: '流畅', fair: '良好', slow: '偏慢' },
      drawerTitle: '当前上下文占比',
      stepsCount: (n) => `${n} 步`,
      stepsTitleCompacted: (s, tot, u, a) => `有效 ${s} 步 / 历史 ${tot} 步 · 提问 ${u} · 回复 ${a}`,
      stepsTitleNormal: (s, u, a) => `共 ${s} 步 · 提问 ${u} · 回复 ${a}`,
      scanning: '计算中…',
      pendingScan: '待扫描',
      totalVal: (v, inc) => `共 ${v}${inc ? ' +' : ''}`,
      approxTotalVal: (v, inc) => `约 ${v}${inc ? ' +' : ''}`,
      unknownShare: '未知占比',
      rowTipActual: (tok, pct) => `约 ${tok} tokens (${pct})`,
      rowTipZero: '0 tokens',
      rowTipShare: (pct) => `占当前上下文 ${pct}`,
      fileJoiner: '、',
      moreFiles: (n) => ` 等 ${n} 个文件`,
      filesLine: (list) => `文件 · ${list}`,
      compFootnote: '按当前有效窗口各区块权重计算',
      updatedAt: (ts) => `${ts} 更新`,
      catSystem: '系统提示',
      catTools: '工具调用',
      catAssistant: '模型回复',
      catThinking: '思考过程',
      catUser: '用户消息',
      catSummaries: '压缩摘要',
      catAttachment: '附件内容',
      catFullSystem: '系统提示与工具定义',
      catFullTools: '工具调用与输出',
      catFullAssistant: '模型回复',
      catFullThinking: '思考过程',
      catFullUser: '用户消息',
      catFullSummaries: '压缩摘要',
      catFullAttachment: '附件内容',
      outCompact: (v) => `产出 ${v}`,
      timingCompact: (ttft, dur) => `首字 ${ttft} · 耗时 ${dur}`,
      quotaTitle: '模型配额',
      quotaActiveBadge: '当前',
      quotaFiveHours: '5 小时',
      quotaWeekly: '每周',
      quotaSoon: '即将',
      quotaNoData: '暂未获取配额数据',
      quotaRowTip: (pool, win, pct, rst) => `${pool} · ${win} · 剩余 ${pct}${rst ? ` (${rst} 重置)` : ''}`,
      poolSuffix: ' 配额池',
      defaultPool: '模型配额池',
      quotaSuffix: ' 配额',
      defaultQuota: '模型配额',
      inlineImage: '内嵌图片',
      inlineAttachment: '内嵌附件',
      errors: {
        noneTitle: '正常',
        noneBadge: '正常',
        overflowTitle: '超出容量上限',
        overflowBadge: '超限',
        overflowDetail: (l) => `超出${l ? ` ${l}` : ''}上限，建议 /compact 或开新对话`,
        quotaTitle: '配额已用尽',
        quotaBadge: '耗尽',
        quotaDetail: (p, r) => `${p}已用尽${r ? `（预计 ${r} 重置）` : ''}，可切换其他可用模型`,
        rateTitle: '请求限流',
        rateBadge: '限流',
        rateDetail: (s) => `触发服务器频率限制（429）${s ? `，请等待 ${s} 秒后重试` : '，请稍候重试'}`,
        canceledTitle: '已取消',
        canceledBadge: '已取消',
        canceledDetail: '上次生成请求已取消，当前显示最近一次有效上下文记录',
        authTitle: '验证异常',
        authBadge: '验证',
        authDetail: '身份验证失败或权限不足，请确认账号登录状态',
        unavailTitle: '服务繁忙',
        unavailBadge: '繁忙',
        unavailDetail: '模型服务器暂时过载或维护中，请稍后重试',
        netTitle: '网络连接异常',
        netBadge: '网络',
        netDefault: '连接失败或超时',
        netTimeout: '连接或读取超时',
        netReset: '连接被远端重置',
        netRefused: '连接被拒绝',
        netDns: 'DNS 解析失败',
        netEof: '连接提前中断 (EOF)',
        netDetail: (reason) => `网络连接发生异常（${reason}），非上下文超限`,
        unknownTitle: '请求失败',
        unknownBadge: '异常',
        unknownDetail: (diag) => `请求未完成（${diag}）`,
      },
    },
    'zh-TW': {
      langShort: '繁',
      langName: '繁體中文',
      langTitleAuto: (name) => `語言 · 跟隨 IDE (${name}) · 點擊切換`,
      langTitlePinned: (name) => `語言 · ${name} · 點擊切換`,
      themeAuto: (isLight) => `跟隨 IDE (目前${isLight ? '淺色' : '深色'})`,
      themeLight: '固定淺色',
      themeDark: '固定深色',
      themeTitle: (mode) => `主題 · ${mode} · 點擊切換`,
      refreshTitle: '重新掃描對話與附件',
      ctxCapsuleAria: '上下文視窗、快取與生成速率監控',
      quotaCapsuleAria: '模型配額監控',
      cacheLabel: '快取',
      cacheWarmTip: (c, t, ago) => `快取命中 ${c} / ${t} tokens · 上一輪 ${ago} 前`,
      cacheWarnTip: (c, t, ago, rem) => `快取命中 ${c} / ${t} tokens · 閒置 ${ago} (約 ${rem}m 後過期)`,
      cacheExpiredTag: '已過期',
      cacheExpiredTip: (c, t, ago) => `快取紀錄 ${c} / ${t} tokens · 閒置 ${ago} (逾 4m 可能已失效)`,
      cacheIdleTip: '0 / 0 快取 · 新對話',
      usedPctFmt: (pct) => `已用 ${pct}%`,
      noActiveChat: '尚未開啟對話',
      waitingRequestData: '等待首次模型回應',
      tokensNoLimit: 'tokens (未提供上限)',
      tokensLocalEst: 'tokens (本機估算)',
      approxVal: (v) => `約 ${v}`,
      leftVal: (v) => `剩餘 ${v}`,
      approxLeftVal: (v) => `約剩 ${v}`,
      zeroLeft: '剩餘 0',
      overLimit: (lim) => `超出 ${lim} 上限`,
      overServerLimit: '超出伺服器容量上限',
      statusIdle: '待命',
      statusOk: '正常',
      statusHigh: '偏高',
      statusTight: '吃緊',
      statusOverflow: '超限',
      statusEst: '估算',
      statusRecorded: '已紀錄',
      statusReady: '就緒',
      statusSyncing: '同步中',
      chipCache: (v) => `快取讀取 ${v}`,
      chipInput: (v) => `新增輸入 ${v}`,
      chipOutput: (v) => `本輪輸出 ${v}`,
      hintEst: '目前為用戶端估算，模型回覆後更新精確用量',
      hintNoCalls: '尚無計費輪次，下方顯示步驟構成估算',
      hintSyncing: '正在同步對話資料…',
      alertHighOccupancy: '建議 /compact 壓縮或開啟新對話',
      alertUnknownFiles: (n) => `${n} 個附件未本機解析，實際用量可能略高`,
      speedLabel: '整體速率',
      speedLabelTitle: '整體速率 = 產出 ÷ 總耗時 (含 TTFT)',
      ttftLabel: '首字延遲',
      ttftLabelTitle: '首字回應時間 (TTFT)',
      durationLabel: '總耗時',
      outputLabel: '本輪產出',
      speedMeasuring: '計算中',
      speedGenerating: '生成中…',
      speedStreamingTps: (tps) => `純串流 ${tps} tok/s`,
      speedIncludesTtft: '含首字延遲計算',
      speedTtftShare: (pct) => `首字佔 ${pct}%`,
      speedTtftDetail: (sec, pct) => `TTFT ${sec}${pct != null ? ` (佔 ${pct}%)` : ''}`,
      timingTip: (ttft, st, dur) =>
        [ttft ? `首字 (TTFT) ${ttft}` : '', st ? `串流 ${st}` : '', dur ? `總耗時 ${dur}` : ''].filter(Boolean).join(' · '),
      ttftTitle: (s) => `首字延遲 ${s}s`,
      durTitle: (d, st) => `總耗時 ${d}s${st != null ? ` · 串流輸出 ${st}s` : ''}`,
      outTitle: (o, r, thk) => (thk ? `本輪產出 ${o} tokens · 回覆 ${r} + 思考 ${thk}` : `本輪產出 ${o} tokens`),
      speed: { fast: '極速', smooth: '流暢', fair: '良好', slow: '偏慢' },
      drawerTitle: '目前上下文占比',
      stepsCount: (n) => `${n} 步`,
      stepsTitleCompacted: (s, tot, u, a) => `有效 ${s} 步 / 歷史 ${tot} 步 · 提問 ${u} · 回覆 ${a}`,
      stepsTitleNormal: (s, u, a) => `共 ${s} 步 · 提問 ${u} · 回覆 ${a}`,
      scanning: '計算中…',
      pendingScan: '待掃描',
      totalVal: (v, inc) => `共 ${v}${inc ? ' +' : ''}`,
      approxTotalVal: (v, inc) => `約 ${v}${inc ? ' +' : ''}`,
      unknownShare: '未知占比',
      rowTipActual: (tok, pct) => `約 ${tok} tokens (${pct})`,
      rowTipZero: '0 tokens',
      rowTipShare: (pct) => `佔目前上下文 ${pct}`,
      fileJoiner: '、',
      moreFiles: (n) => ` 等 ${n} 個檔案`,
      filesLine: (list) => `檔案 · ${list}`,
      compFootnote: '依目前有效視窗各區塊權重計算',
      updatedAt: (ts) => `${ts} 更新`,
      catSystem: '系統提示',
      catTools: '工具呼叫',
      catAssistant: '模型回覆',
      catThinking: '思考過程',
      catUser: '使用者',
      catSummaries: '壓縮摘要',
      catAttachment: '附件內容',
      catFullSystem: '系統提示與工具定義',
      catFullTools: '工具呼叫與輸出',
      catFullAssistant: '模型回覆',
      catFullThinking: '思考過程',
      catFullUser: '使用者訊息',
      catFullSummaries: '壓縮摘要',
      catFullAttachment: '附件內容',
      outCompact: (v) => `產出 ${v}`,
      timingCompact: (ttft, dur) => `首字 ${ttft} · 耗時 ${dur}`,
      quotaTitle: '模型配額',
      quotaActiveBadge: '目前',
      quotaFiveHours: '5 小時',
      quotaWeekly: '每週',
      quotaSoon: '即將',
      quotaNoData: '暫未取得配額資料',
      quotaRowTip: (pool, win, pct, rst) => `${pool} · ${win} · 剩餘 ${pct}${rst ? ` (${rst} 重置)` : ''}`,
      poolSuffix: ' 配額池',
      defaultPool: '模型配額池',
      quotaSuffix: ' 配額',
      defaultQuota: '模型配額',
      inlineImage: '內嵌圖片',
      inlineAttachment: '內嵌附件',
      errors: {
        noneTitle: '正常',
        noneBadge: '正常',
        overflowTitle: '超出容量上限',
        overflowBadge: '超限',
        overflowDetail: (l) => `超出${l ? ` ${l}` : ''}上限，建議 /compact 或開新對話`,
        quotaTitle: '配額已用盡',
        quotaBadge: '耗盡',
        quotaDetail: (p, r) => `${p}已用盡${r ? `（預計 ${r} 重置）` : ''}，可切換其他可用模型`,
        rateTitle: '請求限流',
        rateBadge: '限流',
        rateDetail: (s) => `觸發伺服器頻率限制（429）${s ? `，請等待 ${s} 秒後重試` : '，請稍候重試'}`,
        canceledTitle: '已取消',
        canceledBadge: '已取消',
        canceledDetail: '上次生成請求已取消，目前顯示最近一次有效上下文紀錄',
        authTitle: '驗證異常',
        authBadge: '驗證',
        authDetail: '身分驗證失敗或權限不足，請確認帳號登入狀態',
        unavailTitle: '服務繁忙',
        unavailBadge: '繁忙',
        unavailDetail: '模型伺服器暫時過載或維護中，請稍後重試',
        netTitle: '網路連線異常',
        netBadge: '網路',
        netDefault: '連線失敗或逾時',
        netTimeout: '連線或讀取逾時',
        netReset: '連線被遠端重設',
        netRefused: '連線被拒絕',
        netDns: 'DNS 解析失敗',
        netEof: '連線提前中斷 (EOF)',
        netDetail: (reason) => `網路連線發生異常（${reason}），非上下文超限`,
        unknownTitle: '請求失敗',
        unknownBadge: '異常',
        unknownDetail: (diag) => `請求未完成（${diag}）`,
      },
    },
  };

  function getDict(lang) {
    const resolved = normalizeLocale(lang, 'en');
    return { lang: resolved, dict: I18N[resolved] || I18N.en };
  }

  const numOrNull = (value) =>
    value !== undefined && value !== null && Number.isFinite(Number(value)) && Number(value) >= 0
      ? Number(value)
      : null;

  function parseDurationSec(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    const match = String(value).trim().match(/^([\d.]+)\s*s?$/i);
    if (!match) return null;
    const num = parseFloat(match[1]);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }

  function classifySpeed(tps, lang = 'en') {
    const v = numOrNull(tps);
    if (v === null) return null;
    const { dict } = getDict(lang);
    if (v >= 60) return { level: 'fast', label: dict.speed.fast, tone: 'good' };
    if (v >= 25) return { level: 'smooth', label: dict.speed.smooth, tone: 'good' };
    if (v >= 10) return { level: 'fair', label: dict.speed.fair, tone: 'warn' };
    return { level: 'slow', label: dict.speed.slow, tone: 'danger' };
  }

  function formatModelLabel(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed) return '';
    const placeholder = trimmed.match(/^MODEL_PLACEHOLDER_([A-Z0-9_-]+)$/i);
    if (placeholder) return `Model ${placeholder[1]}`;
    return trimmed
      .replace(
        /\s*\((?:minimal|low|medium|high|max|auto|thinking|extended thinking|(?:minimal|low|medium|high|max)\s+thinking)\)\s*$/i,
        ''
      )
      .trim();
  }

  function getModelPoolKey(raw) {
    if (!raw) return 'unknown';
    const s = String(raw).toLowerCase();
    if (s.includes('argon') || s.includes('gemini-4-argon')) return 'gemini-4-argon';
    if (s.includes('carbon') || s.includes('gemini-4-carbon')) return 'gemini-4-carbon';
    if (s.includes('hydrogen') || s.includes('gemini-4-hydrogen')) return 'gemini-4-hydrogen';
    if (s.includes('flash') || s.includes('gemini-3.8-flash')) return 'gemini-3.8-flash';
    if (s.includes('opus') || s.includes('claude-opus')) return 'claude-opus-5-5';
    if (s.includes('sonnet') || s.includes('claude-sonnet')) return 'claude-sonnet-5-5';
    if (s.includes('gpt-oss')) return 'gpt-oss-120b';
    return s.replace(/[^a-z0-9_-]/g, '');
  }

  function formatResetDateTime(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (Number.isNaN(d.getTime())) return String(isoStr);
      const m = d.getMonth() + 1;
      const day = d.getDate();
      const h = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      return `${m}/${day} ${h}:${min}`;
    } catch {
      return String(isoStr);
    }
  }

  function formatResetShort(isoStr, soonLabel = 'soon', nowMs = Date.now()) {
    if (!isoStr) return '';
    const diffMs = new Date(isoStr).getTime() - nowMs;
    if (!Number.isFinite(diffMs)) return '';
    if (diffMs <= 0) return soonLabel;
    const totalMin = Math.floor(diffMs / 60000);
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${String(Math.max(1, m)).padStart(2, '0')}m`;
  }

  function fmtK(n) {
    const num = Number(n || 0);
    if (!Number.isFinite(num) || num <= 0) return '0';
    const rounded = Math.round(num);
    if (rounded < 1000) return String(rounded);
    if (rounded >= 999950) return (rounded / 1000000).toFixed(1) + 'M';
    return (rounded / 1000).toFixed(1) + 'K';
  }

  function fmtColK(n) {
    const num = Number(n || 0);
    if (!Number.isFinite(num) || num <= 0) return '0.0K';
    if (num >= 999950) return (num / 1000000).toFixed(1) + 'M';
    return (num / 1000).toFixed(1) + 'K';
  }

  function fmtPreciseK(n) {
    const num = Number(n || 0);
    if (!Number.isFinite(num) || num <= 0) return '0';
    const rounded = Math.round(num);
    if (rounded < 1000) return String(rounded);
    if (rounded >= 999950) return (rounded / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    return (rounded / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }

  function resolveModelQuota(modelIdOrName, cascadeModelConfigs, lang = 'en') {
    if (!Array.isArray(cascadeModelConfigs) || !cascadeModelConfigs.length || !modelIdOrName) {
      return null;
    }
    const { dict } = getDict(lang);
    const poolKey = getModelPoolKey(modelIdOrName);
    const targetStr = String(modelIdOrName).toLowerCase();

    let matched = cascadeModelConfigs.find((c) => {
      const mId = String(c.modelId || '').toLowerCase();
      const lbl = String(c.label || '').toLowerCase();
      return mId === targetStr || lbl === targetStr;
    });
    if (!matched && poolKey !== 'unknown') {
      matched = cascadeModelConfigs.find((c) => getModelPoolKey(c.modelId || c.label) === poolKey);
    }
    if (!matched) return null;

    const qi = matched.quotaInfo || {};
    const poolBaseNames = {
      'gemini-4-argon': 'Gemini 4 Argon',
      'gemini-4-carbon': 'Gemini 4 Carbon',
      'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
      'gemini-3.8-flash': 'Gemini 3.8 Flash',
      'claude-opus-5-5': 'Claude Opus 5.5',
      'claude-sonnet-5-5': 'Claude Sonnet 5.5',
      'gpt-oss-120b': 'GPT-OSS 120B',
    };
    const baseName = poolBaseNames[poolKey];
    return {
      modelId: matched.modelId || '',
      label: matched.label || modelIdOrName,
      poolKey,
      poolName: baseName
        ? `${baseName}${dict.poolSuffix}`
        : matched.label
          ? `${matched.label}${dict.poolSuffix}`
          : dict.defaultPool,
      remainingFraction: typeof qi.remainingFraction === 'number' ? qi.remainingFraction : null,
      resetTime: qi.resetTime || null,
    };
  }

  function classifyRequestError(input, options = {}) {
    const { lang, dict } = getDict(options.lang);
    const errDict = dict.errors;
    const error = typeof input === 'string' ? input : String(input?.error || input?.message || '');
    const currentModel = options.currentModel || '';
    const cascadeConfigs = options.cascadeModelConfigs || [];
    const modelQuota = resolveModelQuota(currentModel, cascadeConfigs, lang);

    if (!error) {
      return {
        kind: 'none',
        lang,
        title: errDict.noneTitle,
        badgeText: errDict.noneBadge,
        detail: '',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: modelQuota?.poolName || currentModel || null,
        diagnostic: '',
      };
    }

    let diagnostic = error.replace(/https?:\/\/[^\s"']+/g, '<API>').trim();
    if (diagnostic.length > 120) diagnostic = diagnostic.slice(0, 117) + '...';

    const isDeadlineTimeout = /context deadline exceeded|deadline exceeded|stream idle timeout/i.test(error);
    const overflowMatch =
      !isDeadlineTimeout &&
      error.match(
        /input token count exceeds|context\s*(?:window|length|tokens?|limit|size|capacity)?.{0,35}(?:exceed|too long)|maximum context length|prompt exceeds maximum context length|max_tokens exceeded/i
      );
    if (overflowMatch) {
      const serviceLimit = numOrNull(
        error.match(/(?:allowed|limit(?:\s+of)?|length(?:\s+is|\s+of)?)\s*[:=]?\s*([\d,]+)/i)?.[1]?.replaceAll(',', '')
      );
      return {
        kind: 'context_overflow',
        lang,
        title: errDict.overflowTitle,
        badgeText: errDict.overflowBadge,
        detail: errDict.overflowDetail(serviceLimit ? fmtPreciseK(serviceLimit) : ''),
        serviceLimit,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic,
      };
    }

    const explicitQuotaMatch =
      /(?:quota\s*(?:exceeded|reached|limit|exhausted)|out\s+of\s+quota|exhausted.*(?:capacity|quota)|resource_exhausted.*(?:quota|capacity|billing)|free\s+tier\s+quota|daily\s+quota|weekly\s+quota)/i.test(
        error
      );
    const quotaZeroEvidence = Boolean(
      modelQuota && typeof modelQuota.remainingFraction === 'number' && modelQuota.remainingFraction <= 0.0001
    );

    if (explicitQuotaMatch || quotaZeroEvidence) {
      const formattedReset = modelQuota?.resetTime ? formatResetDateTime(modelQuota.resetTime) : null;
      const poolName =
        modelQuota?.poolName || (currentModel ? `${formatModelLabel(currentModel)}${dict.quotaSuffix}` : dict.defaultQuota);
      return {
        kind: 'quota_exhausted',
        lang,
        title: errDict.quotaTitle,
        badgeText: errDict.quotaBadge,
        detail: errDict.quotaDetail(poolName, formattedReset),
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: modelQuota?.resetTime || null,
        resetTimeFormatted: formattedReset,
        modelOrPool: poolName,
        diagnostic,
      };
    }

    if (/(?:rate\s*limit|too\s*many\s*requests|\b429\b|RateLimitError|RESOURCE_EXHAUSTED.*rate)/i.test(error)) {
      const retryMatch = error.match(/(?:retry\s+in|retry-after|wait)\s*[:=]?\s*([\d.]+)\s*(?:s|sec|seconds)?/i);
      const retryAfterSec = retryMatch ? numOrNull(retryMatch[1]) : null;
      return {
        kind: 'rate_limited',
        lang,
        title: errDict.rateTitle,
        badgeText: errDict.rateBadge,
        detail: errDict.rateDetail(retryAfterSec),
        serviceLimit: null,
        retryAfterSec,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic,
      };
    }

    if (/(?:context canceled by user|user cancelled|request was aborted|AbortError)/i.test(error)) {
      return {
        kind: 'canceled',
        lang,
        title: errDict.canceledTitle,
        badgeText: errDict.canceledBadge,
        detail: errDict.canceledDetail,
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic,
      };
    }

    if (/(?:UNAUTHENTICATED|PERMISSION_DENIED|\b401\b|\b403\b|invalid api key|credentials expired|permission denied)/i.test(error)) {
      return {
        kind: 'auth_error',
        lang,
        title: errDict.authTitle,
        badgeText: errDict.authBadge,
        detail: errDict.authDetail,
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic,
      };
    }

    if (/(?:UNAVAILABLE|\b503\b|\b502\b|\b504\b|server overloaded|high demand|Bad Gateway|Service Unavailable)/i.test(error)) {
      return {
        kind: 'service_unavailable',
        lang,
        title: errDict.unavailTitle,
        badgeText: errDict.unavailBadge,
        detail: errDict.unavailDetail,
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic,
      };
    }

    if (/(?:\bEOF\b|idle timeout|deadline exceeded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|Failed to fetch|NetworkError)/i.test(error)) {
      let cleanNet = errDict.netDefault;
      if (/deadline exceeded|timeout/i.test(error)) cleanNet = errDict.netTimeout;
      else if (/ECONNRESET|socket hang up/i.test(error)) cleanNet = errDict.netReset;
      else if (/ECONNREFUSED/i.test(error)) cleanNet = errDict.netRefused;
      else if (/ENOTFOUND/i.test(error)) cleanNet = errDict.netDns;
      else if (/\bEOF\b/i.test(error)) cleanNet = errDict.netEof;
      return {
        kind: 'network_error',
        lang,
        title: errDict.netTitle,
        badgeText: errDict.netBadge,
        detail: errDict.netDetail(cleanNet),
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic,
      };
    }

    return {
      kind: 'unknown',
      lang,
      title: errDict.unknownTitle,
      badgeText: errDict.unknownBadge,
      detail: errDict.unknownDetail(diagnostic),
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      modelOrPool: currentModel || null,
      diagnostic,
    };
  }

  function summarizeGeneratorMeta(metadata, options = {}) {
    const m = metadata?.chatModel;
    if (!m) return null;
    const lang = normalizeLocale(options.lang, 'en');
    const lastRetry = (m.retryInfos || []).at(-1);
    const error = String(lastRetry?.error || m.error || '');
    const model = m.modelDisplayName || m.responseModel || m.model || options.currentModel || '';

    const classification = error
      ? classifyRequestError(error, {
          lang,
          currentModel: model,
          cascadeModelConfigs: options.cascadeModelConfigs || [],
        })
      : { kind: 'none', lang };

    const exceeded = classification.kind === 'context_overflow';
    const network = classification.kind === 'network_error';
    const serviceLimit = classification.serviceLimit || null;

    const usage = lastRetry ? lastRetry.usage : m.usage;
    const input = numOrNull(usage?.inputTokens);
    const cached = numOrNull(usage?.cacheReadTokens);
    const output = numOrNull(usage?.outputTokens);
    const thinking = numOrNull(usage?.thinkingOutputTokens);
    const responseTokens = numOrNull(usage?.responseOutputTokens);
    const hasInput = (input || 0) + (cached || 0) > 0;

    const prevContext = options.previousValidContext || null;
    let actual = hasInput && !error ? (input || 0) + (cached || 0) + (output || 0) : null;
    if (actual === null && prevContext && prevContext.actual != null && !exceeded) {
      actual = prevContext.actual;
    }

    const context = m.chatStartMetadata?.contextWindowMetadata;
    const estimate = numOrNull(context?.estimatedTokensUsed) || prevContext?.estimate || null;
    const budget = numOrNull(context?.maxContextTokens) || prevContext?.budget || null;

    const ttft = parseDurationSec(m.timeToFirstToken);
    const streamingSec = parseDurationSec(m.streamingDuration);
    const duration = ttft !== null && streamingSec !== null ? ttft + streamingSec : ttft ?? streamingSec ?? null;

    let tps = null;
    if (output && duration && duration > 0.05) {
      tps = Number((output / duration).toFixed(1));
    }
    let streamingTps = null;
    if (output && streamingSec && streamingSec > 0.05) {
      streamingTps = Number((output / streamingSec).toFixed(1));
    }

    const speedTier = classifySpeed(tps, lang);
    const speed =
      tps !== null || duration !== null || output !== null
        ? {
            tps,
            streamingTps,
            level: speedTier?.level || null,
            label: speedTier?.label || null,
            tone: speedTier?.tone || null,
            duration: duration !== null ? Number(duration.toFixed(2)) : null,
            ttft: ttft !== null ? Number(ttft.toFixed(2)) : null,
            streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(2)) : null,
            outputTokens: output ?? 0,
            thinkingTokens: thinking ?? 0,
            responseTokens: responseTokens ?? (output ?? 0),
          }
        : null;

    let status = 'pending';
    if (exceeded) status = 'exceeded';
    else if (network) status = 'network';
    else if (classification.kind === 'quota_exhausted') status = 'quota_exhausted';
    else if (classification.kind === 'rate_limited') status = 'rate_limited';
    else if (classification.kind === 'auth_error') status = 'auth_error';
    else if (classification.kind === 'service_unavailable') status = 'service_unavailable';
    else if (classification.kind === 'canceled') status = 'canceled';
    else if (error) status = 'failed';
    else if (actual !== null) status = 'reported';
    else if (estimate > 0) status = 'estimated';

    const usedVal = actual ?? (estimate > 0 ? estimate : null);
    const percentVal = actual !== null && budget > 0 && !exceeded ? (actual / budget) * 100 : null;

    return {
      used: usedVal,
      actual,
      estimate: estimate > 0 ? estimate : null,
      budget: budget > 0 ? budget : null,
      serviceLimit,
      exceeded,
      network,
      error,
      errorClassification: classification,
      estimated: actual === null,
      freshInput: hasInput && !error ? input || 0 : prevContext?.freshInput ?? null,
      input: hasInput && !error ? (input || 0) + (cached || 0) : prevContext?.input ?? null,
      cached: hasInput && !error ? cached || 0 : prevContext?.cached ?? 0,
      output: output !== null && !error ? output : prevContext?.output ?? null,
      thinking: thinking !== null && !error ? thinking : prevContext?.thinking ?? 0,
      percent: percentVal,
      model,
      modelLabel: formatModelLabel(model),
      status,
      speed,
    };
  }

  const emptyMeasure = () => ({ chars: 0, bytes: 0, tokens: 0, low: 0, high: 0 });

  function addMeasure(a, b) {
    for (const k of ['chars', 'bytes', 'tokens', 'low', 'high']) a[k] = (a[k] || 0) + (b[k] || 0);
    return a;
  }

  function measureText(text) {
    text = String(text || '');
    if (!text) return emptyMeasure();
    let chars = 0;
    let bytes = 0;
    let cjk = 0;
    for (const char of text) {
      const c = char.codePointAt(0);
      chars++;
      bytes += c <= 127 ? 1 : c <= 2047 ? 2 : c <= 65535 ? 3 : 4;
      if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
    }
    const tokens = Math.max(1, Math.round((chars - cjk) / 3.7 + cjk * 1.15));
    return {
      chars,
      bytes,
      tokens,
      low: Math.max(1, Math.floor(tokens * 0.9)),
      high: Math.ceil(tokens * 1.1),
    };
  }

  function computeContextShares(entries) {
    const clean = (entries || []).map((e) => ({
      id: e.id,
      weight: Math.max(0, Number(e.weight) || 0),
    }));
    const totalWeight = clean.reduce((sum, e) => sum + e.weight, 0);
    const shares = {};
    if (totalWeight <= 0) {
      for (const e of clean) {
        shares[e.id] = { weight: 0, ratio: 0, percent: 0, text: '0%' };
      }
      return { totalWeight: 0, shares };
    }

    const tiny = [];
    const major = [];
    for (const e of clean) {
      if (e.weight <= 0) {
        shares[e.id] = { weight: 0, ratio: 0, percent: 0, text: '0%' };
        continue;
      }
      const ratio = e.weight / totalWeight;
      const rawPct = ratio * 100;
      if (rawPct < 0.1) {
        tiny.push({ ...e, ratio, rawPct });
        shares[e.id] = { weight: e.weight, ratio, percent: rawPct, text: '<0.1%' };
      } else {
        const rawTenths = rawPct * 10;
        const baseTenths = Math.max(1, Math.floor(rawTenths));
        major.push({
          ...e,
          ratio,
          rawPct,
          baseTenths,
          frac: rawTenths - Math.floor(rawTenths),
        });
      }
    }

    if (major.length > 0) {
      const tinyTenths = tiny.reduce((sum, x) => sum + x.rawPct * 10, 0);
      const targetTenths = Math.max(major.length, Math.round(1000 - tinyTenths));
      const currentSum = major.reduce((sum, x) => sum + x.baseTenths, 0);
      let diff = targetTenths - currentSum;

      if (diff > 0) {
        const byRemDesc = major.slice().sort((a, b) => b.frac - a.frac);
        for (let i = 0; i < diff; i++) {
          byRemDesc[i % byRemDesc.length].baseTenths += 1;
        }
      } else if (diff < 0) {
        const byRemAsc = major.filter((x) => x.baseTenths > 1).sort((a, b) => a.frac - b.frac);
        let idx = 0;
        while (diff < 0 && byRemAsc.length > 0) {
          const item = byRemAsc[idx % byRemAsc.length];
          if (item.baseTenths > 1) {
            item.baseTenths -= 1;
            diff += 1;
          }
          idx++;
          if (idx > byRemAsc.length * 10) break;
        }
      }

      for (const m of major) {
        const pct = m.baseTenths / 10;
        shares[m.id] = {
          weight: m.weight,
          ratio: m.ratio,
          percent: pct,
          text: m.baseTenths === 1000 ? '100%' : `${pct.toFixed(1)}%`,
        };
      }
    }

    return { totalWeight, shares };
  }

  function analyzeSteps(steps, options = {}) {
    const { dict } = getDict(options.lang);
    const groups = {
      user: emptyMeasure(),
      assistant: emptyMeasure(),
      thinking: emptyMeasure(),
      tools: emptyMeasure(),
      summaries: emptyMeasure(),
    };
    const media = new Map();
    let userMessages = 0;
    let assistantMessages = 0;
    let latestStepError = null;
    let lastUserAt = -1;
    let lastAssistantAt = -1;
    const skip = new Set([
      'metadata',
      'userConfig',
      'lastUserConfig',
      'userAgentSpec',
      'activeUserState',
      'thinkingSignature',
      'thumbnail',
      'inlineData',
      'media',
      'modelUsage',
      'tokenUsage',
      'mendelExperimentIds',
    ]);

    function content(value) {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (!value) return '';
      if (Array.isArray(value)) return value.map(content).join('\n');
      return Object.entries(value)
        .filter(([key]) => !skip.has(key))
        .map(([key, v]) => `${key}: ${content(v)}`)
        .join('\n');
    }

    function attachments(value, source, withinStep = new Set()) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const v of value) attachments(v, source, withinStep);
        return;
      }
      if (value.uri && (value.mimeType || value.inlineData !== undefined)) {
        const key = String(value.uri);
        if (!withinStep.has(key)) {
          withinStep.add(key);
          const prior = media.get(key);
          if (prior) prior.references++;
          else {
            media.set(key, {
              uri: key,
              name: String(value.description || key.split(/[\\/]/).pop()),
              mime: String(value.mimeType || ''),
              references: 1,
              source,
            });
          }
        }
      } else if (value.inlineData && !value.uri) {
        const key = `inline-${media.size}`;
        const rawData = typeof value.inlineData === 'string' ? value.inlineData : value.inlineData.data || '';
        const mime = String(value.mimeType || value.inlineData.mimeType || '');
        if (!withinStep.has(key)) {
          withinStep.add(key);
          media.set(key, {
            uri: `inline:${key}`,
            inlineData: rawData,
            name: String(value.description || (mime.startsWith('image/') ? dict.inlineImage : dict.inlineAttachment)),
            mime,
            references: 1,
            source,
          });
        }
      }
      for (const [key, v] of Object.entries(value)) {
        if (!skip.has(key) || key === 'media') attachments(v, source, withinStep);
      }
    }

    let activeStart = 0;
    for (let i = steps.length - 1; i >= 0; i--) {
      const cp = steps[i]?.checkpoint;
      if (cp && String(cp.sessionSummary || cp.summary || '').trim().length > 0) {
        activeStart = i;
        break;
      }
    }

    for (let i = activeStart; i < steps.length; i++) {
      const s = steps[i];
      if (!s) continue;
      if (s.userInput) {
        userMessages++;
        lastUserAt = i;
        const u = s.userInput;
        const rawUserText = u.userResponse || (u.items || []).map((item) => item.text || '').join('\n');
        const summaryMatch = rawUserText.match(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/i);
        if (summaryMatch) {
          addMeasure(groups.summaries, measureText(summaryMatch[0]));
          const rest = rawUserText.replace(summaryMatch[0], '').trim();
          if (rest) addMeasure(groups.user, measureText(rest));
        } else {
          addMeasure(groups.user, measureText(rawUserText));
        }
        attachments(u.media?.length ? u.media : u.items, 'user');
      } else if (s.plannerResponse) {
        assistantMessages++;
        lastAssistantAt = i;
        addMeasure(
          groups.assistant,
          measureText(s.plannerResponse.modifiedResponse || s.plannerResponse.response || s.plannerResponse.text || '')
        );
        addMeasure(groups.thinking, measureText(s.plannerResponse.thinking || ''));
        const prTools = s.plannerResponse.toolCalls || s.plannerResponse.tool_calls;
        if (prTools) addMeasure(groups.tools, measureText(content(prTools)));
        attachments(s.plannerResponse, 'assistant');
      } else if (s.errorMessage) {
        const e = s.errorMessage.error || {};
        latestStepError = {
          index: i,
          text: e.modelErrorMessage || e.shortError || e.fullError || '',
          id: e.errorId || '',
        };
      } else if (s.checkpoint) {
        addMeasure(groups.summaries, measureText(s.checkpoint.sessionSummary || s.checkpoint.summary || ''));
      } else {
        const payload = Object.fromEntries(
          Object.entries(s).filter(([k]) => !['type', 'status', 'metadata', 'error'].includes(k))
        );
        addMeasure(groups.tools, measureText(content(payload)));
        attachments(payload, 'assistant');
      }
    }

    const total = Object.values(groups).reduce(addMeasure, emptyMeasure());
    const currentError =
      latestStepError && latestStepError.index > Math.max(lastUserAt, lastAssistantAt) ? latestStepError : null;

    return {
      groups,
      total,
      media: [...media.values()],
      steps: steps.length,
      activeSteps: steps.length - activeStart,
      compacted: activeStart > 0,
      userMessages,
      assistantMessages,
      currentError,
    };
  }

  function formatGroupTitle(raw) {
    const s = String(raw || '').trim();
    if (s === 'Gemini Models') return 'Gemini';
    if (s.toLowerCase().startsWith('claude')) return 'Claude';
    return s;
  }

  function normalizeQuotaGroups(rawGroups) {
    if (!Array.isArray(rawGroups)) return [];
    const windowOrder = { '5h': 0, weekly: 1 };
    return rawGroups.map((g) => {
      const rawName = String(g.displayName || '').trim();
      const title = formatGroupTitle(rawName);
      const descMatch = String(g.description || '').match(/models within this group:\s*([^\n.]+)/i);
      const modelsInGroup = descMatch ? descMatch[1].toLowerCase() : '';
      const buckets = [...(g.buckets || [])]
        .sort((a, b) => (windowOrder[a.window] ?? 2) - (windowOrder[b.window] ?? 2))
        .map((b) => {
          const frac = typeof b.remainingFraction === 'number' ? Math.max(0, Math.min(1, b.remainingFraction)) : null;
          const remainingPct = frac !== null ? Math.round(frac * 100) : null;
          const customLabel = String(b.displayName || b.window || '')
            .replace(/\s*limit\b/gi, '')
            .replace(/\b5h(?:ours)?\b/gi, '5 Hours')
            .trim();
          return {
            window: b.window || '',
            customLabel,
            remainingFraction: frac,
            remainingPct,
            resetTime: b.resetTime || '',
          };
        });
      const b5h = buckets.find((b) => b.window === '5h');
      const bWk = buckets.find((b) => b.window === 'weekly');
      return {
        title,
        rawName: rawName.toLowerCase(),
        modelsInGroup,
        q5hPct: b5h ? b5h.remainingPct : null,
        qWkPct: bWk ? bWk.remainingPct : null,
        buckets,
      };
    });
  }

  function matchModelQuotaGroup(composerModelText, normalizedGroups) {
    if (!Array.isArray(normalizedGroups) || normalizedGroups.length === 0) return null;
    const mt = String(composerModelText || '').trim().toLowerCase();

    if (mt) {
      // 1. Match specific non-generic group titles (e.g. "Gemini 4 Argon", "Gemini 4 Carbon", "Claude and GPT models")
      for (const g of normalizedGroups) {
        if (g.title === 'Gemini') continue;
        if (
          (g.rawName.includes('claude') || g.rawName.includes('gpt')) &&
          (mt.includes('claude') || mt.includes('sonnet') || mt.includes('opus') || mt.includes('gpt'))
        ) {
          return g;
        }
        const tokens = g.rawName
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length >= 3 && !['gemini', 'model', 'models', 'and', 'the', 'for'].includes(t));
        if (tokens.some((t) => mt.includes(t))) {
          return g;
        }
      }

      // 2. Match explicit "Models within this group: ..." description list
      const modelKeys = ['carbon', 'argon', 'hydrogen', 'flash', 'claude', 'sonnet', 'opus', 'gpt'];
      const activeKeys = modelKeys.filter((k) => mt.includes(k));
      if (activeKeys.length > 0) {
        const descHit = normalizedGroups.find(
          (g) => g.modelsInGroup && activeKeys.some((k) => g.modelsInGroup.includes(k))
        );
        if (descHit) return descHit;
      }
    }

    // 3. Fallback to main Gemini group (handles Ultra where Hydrogen/Argon belong to Gemini Models)
    return normalizedGroups.find((g) => g.title === 'Gemini') || normalizedGroups[0] || null;
  }

  return {
    SUPPORTED_LOCALES,
    I18N,
    normalizeLocale,
    detectLocaleFromCandidates,
    getDict,
    classifySpeed,
    formatModelLabel,
    getModelPoolKey,
    formatResetDateTime,
    formatResetShort,
    fmtK,
    fmtColK,
    fmtPreciseK,
    resolveModelQuota,
    classifyRequestError,
    summarizeGeneratorMeta,
    emptyMeasure,
    addMeasure,
    measureText,
    computeContextShares,
    analyzeSteps,
    formatGroupTitle,
    normalizeQuotaGroups,
    matchModelQuotaGroup,
  };
}

export function getBrowserCoreScript() {
  return `globalThis.__AGY_CAPSULE_CORE__ = (${createCapsuleCore.toString()})();`;
}

export const core = createCapsuleCore();
