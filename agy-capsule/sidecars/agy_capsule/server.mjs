import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDeckInjector } from './deck_injector.mjs';
import { createSettingsStore, DEFAULT_SETTINGS } from './settings.mjs';
import { createPresentation, getPresentationScript } from './ui.mjs';
import { summarizeGeneration, summarizeTurnSpeed } from './metrics.mjs';
import { classifyRequestError } from './errors.mjs';
import { createSqliteSnapshotCache } from './sqlite_cache.mjs';
import { startSelfReloadWatcher } from './reload.mjs';
import { summarizeTurnMetrics } from './turn_metrics.mjs';

const settingsStore = createSettingsStore();
const presentation = createPresentation();

const CONV_DIR = join(homedir(), '.gemini', 'antigravity', 'conversations');

let cachedQuotaGroups = null;
let lastQuotaFetchMs = 0;
let lsConnFailures = 0;
const QUOTA_TTL_MS = 10000;
let quotaPromise = null;

async function fetchQuotaGroups() {
  const now = Date.now();
  if (cachedQuotaGroups && now - lastQuotaFetchMs < QUOTA_TTL_MS) {
    return cachedQuotaGroups;
  }
  if (quotaPromise) return quotaPromise;
  quotaPromise = loadQuotaGroups();
  try { return await quotaPromise; }
  finally { quotaPromise = null; }
}

async function loadQuotaGroups() {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) return cachedQuotaGroups || [];
  try {
    const res = await fetch(
      `http://${lsAddr}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrf,
        },
        body: '{}',
        signal: AbortSignal.timeout(3000),
      }
    );
    lsConnFailures = 0;
    if (!res.ok) return cachedQuotaGroups || [];
    const data = await res.json();
    const groups = data?.response?.groups || data?.groups || [];
    cachedQuotaGroups = groups;
    lastQuotaFetchMs = Date.now();
    return groups;
  } catch {
    lsConnFailures++;
    if (lsConnFailures >= 2) {
      process.exit(0);
    }
    return cachedQuotaGroups || [];
  }
}

function readVarint(buf, offset) {
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
  }
  return [Number(val), i];
}

function parsePbMap(buf) {
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
        fields.get(fn).push(buf.subarray(i, i + 4));
        i += 4;
      } else if (wt === 1) {
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

function recordedTokenUsage(fields, confirmedZero = false) {
  const reported = confirmedZero || [2, 3, 5, 9, 10].some(key => fields.has(key));
  const value = key => fields.get(key)?.[0] || 0;
  const splitMatches = value(3) === value(9) + value(10);
  return {
    read: reported ? value(2) + value(5) : null,
    cachedRead: reported ? value(5) : null,
    uncachedRead: reported ? value(2) : null,
    write: reported && splitMatches ? value(10) : null,
    thinking: reported && splitMatches ? value(9) : null,
  };
}

function parseGenRow(idx, data) {
  if (!data || !Buffer.isBuffer(data)) data = Buffer.from(data || []);
  const top = parsePbMap(data);
  if (!top.has(1)) return null;
  const stepIndices = [];
  for (const value of top.get(2) || []) {
    if (typeof value === 'number') stepIndices.push(value);
    else for (let offset = 0; offset < value.length;) {
      const [idx, next] = readVarint(value, offset);
      stepIndices.push(idx);
      offset = next;
    }
  }
  const m1 = parsePbMap(top.get(1)[0]);
  const usageBuf = m1.has(4) ? m1.get(4)[0] : Buffer.alloc(0);
  const usage = parsePbMap(usageBuf);

  const uncachedIn = usage.has(2) ? usage.get(2)[0] : 0;
  const cachedIn = usage.has(5) ? usage.get(5)[0] : 0;
  const thinkTokens = usage.has(9) ? usage.get(9)[0] : 0;
  const outTokens = usage.has(10) ? usage.get(10)[0] : 0;
  const contextTokens = uncachedIn + cachedIn;
  const duration = field => {
    if (!m1.has(field)) return null;
    const fields = parsePbMap(m1.get(field)[0]);
    return (fields.get(1)?.[0] || 0) + (fields.get(2)?.[0] || 0) / 1e9;
  };
  const ttft = duration(11);
  const streaming = duration(12);
  // Verified against the installed ChatModelMetadata/RetryInfo descriptors and
  // 11 real RPC retry errors: ChatModelMetadata.retry_infos=17, RetryInfo.error=3.
  // Read the FINAL retry only; an earlier failed attempt must not survive success.
  const lastRetry = m1.get(17)?.at(-1);
  const retryError = lastRetry ? parsePbMap(lastRetry).get(3)?.[0] : null;
  const requestError = classifyRequestError(Buffer.isBuffer(retryError) ? retryError.toString('utf8') : '');
  // Proto usage.3 is TOTAL output; usage.9 and .10 are thinking and reply.
  // Missing usage/preflight rows must not become a fake zero-token result.
  const hasOutput = m1.has(4) && (usage.has(3) || (ttft !== null && streaming !== null));
  const retries = m1.get(17) || [];
  const hasAttempt = retries.length > 0 || hasOutput || ttft !== null || streaming !== null || top.has(5) || (m1.get(14)?.[0] || 0) > 0;
  const attempts = retries.map((value, index) => {
    const info = parsePbMap(value);
    const counters = parsePbMap(info.get(2)?.[0] || Buffer.alloc(0));
    const finalSuccess = index === retries.length - 1 && !info.get(3)?.[0]?.length && hasOutput;
    const reported = [2, 3, 5, 9, 10].some(key => counters.has(key));
    return { usage: recordedTokenUsage(finalSuccess && !reported ? usage : counters, finalSuccess) };
  });
  if (hasAttempt && attempts.length === 0) attempts.push({ usage: recordedTokenUsage(usage, hasOutput) });
  const expectedAttempts = hasAttempt ? Math.max(attempts.length, (m1.get(14)?.[0] || 0) + 1) : 0;
  while (attempts.length < expectedAttempts) attempts.unshift({ usage: recordedTokenUsage(new Map()) });

  let maxContextTokens = 0;
  if (m1.has(9)) {
    const m9 = parsePbMap(m1.get(9)[0]);
    if (m9.has(10)) {
      const m10 = parsePbMap(m9.get(10)[0]);
      if (m10.has(4)) {
        maxContextTokens = m10.get(4)[0];
      }
    }
  }

  let lastStepIndex = -1;
  if (m1.has(20)) {
    for (const kvBuf of m1.get(20)) {
      const kv = parsePbMap(kvBuf);
      const key = kv.has(1) ? kv.get(1)[0].toString('utf8') : '';
      if (key === 'last_step_index' && kv.has(2)) {
        const n = Number(kv.get(2)[0].toString('utf8'));
        if (Number.isFinite(n)) lastStepIndex = n;
        break;
      }
    }
  }

  return {
    turn: idx,
    uncachedIn,
    cachedIn,
    contextTokens,
    outTokens,
    thinkTokens,
    maxContextTokens,
    lastStepIndex,
    stepIndices,
    requestError,
    attempts,
    pendingAttempt: !hasAttempt && stepIndices.length > 0,
    generation: {
      requestIndex: idx, ttft, streaming,
      output: hasOutput ? usage.get(3)?.[0] || 0 : null,
      reply: hasOutput ? outTokens : null,
      thinking: hasOutput ? thinkTokens : null,
    },
  };
}

let lastDeckConvId = null; // '' when on New Conversation page, or uuid when on /c/<uuid>

function resolveLatestConvId(preferredId) {
  if (!existsSync(CONV_DIR)) return '';
  const files = readdirSync(CONV_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({
      id: basename(f, '.db'),
      mtimeMs: statSync(join(CONV_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (files.length === 0) return '';
  // Always follow the most recently modified conversation DB so switching
  // or starting a new chat in Desktop automatically updates the panel.
  return files[0].id;
}

async function makeEmptyContextResult() {
  return {
    uiVersion: 94,
    turnSpeed: null,
    turnMetrics: null,
    requestError: classifyRequestError(),
    generation: summarizeGeneration(),
    prefs: settingsStore.read(),
    cachedIn: 0,
    uncachedIn: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    lastStepEpochMs: 0,
    turn0Tokens: 0,
    totalOutputTokens: 0,
    totalThinkingTokens: 0,
    quotaGroups: await fetchQuotaGroups(),
  };
}

async function inspectConversation(convId, exact = false) {
  let targetId = '';
  if (exact) {
    lastDeckConvId = convId || '';
    if (!convId || !existsSync(join(CONV_DIR, `${convId}.db`))) {
      return await makeEmptyContextResult();
    }
    targetId = convId;
  } else {
    if (lastDeckConvId !== null) {
      if (!lastDeckConvId || !existsSync(join(CONV_DIR, `${lastDeckConvId}.db`))) {
        return await makeEmptyContextResult();
      }
      targetId = lastDeckConvId;
    } else {
      targetId =
        convId && existsSync(join(CONV_DIR, `${convId}.db`))
          ? convId
          : resolveLatestConvId(convId);
    }
    if (!targetId) {
      return await makeEmptyContextResult();
    }
  }

  const snapshot = conversationCache.read(join(CONV_DIR, `${targetId}.db`));
  if (!snapshot) return await makeEmptyContextResult();
  return {
    uiVersion: 94,
    ...snapshot,
    prefs: settingsStore.read(),
    quotaGroups: await fetchQuotaGroups(),
  };
}

const conversationCache = createSqliteSnapshotCache(readConversationSnapshot);

function readConversationSnapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rawRows = [];
  let cpRows = [];
  let lastStepEpochMs = 0;
  let userStepIndex = null;
  let turnSteps = [];
  let metricsUserStepIndex = null;
  let executors = [];
  try {
    rawRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    cpRows = db.prepare('SELECT idx FROM steps WHERE step_type = 23 ORDER BY idx DESC').all();
    // A queued user input is not a new running turn until AGY consumes it.
    userStepIndex = db.prepare('SELECT idx FROM steps WHERE step_type = 14 AND status != 11 ORDER BY idx DESC LIMIT 1').get()?.idx ?? null;
    metricsUserStepIndex = db.prepare('SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx DESC LIMIT 1').get()?.idx ?? null;
    if (metricsUserStepIndex !== null) {
      turnSteps = db.prepare('SELECT idx, step_type, status, metadata FROM steps WHERE idx >= ? ORDER BY idx').all(userStepIndex ?? metricsUserStepIndex).map(step => {
        const fields = parsePbMap(Buffer.from(step.metadata || []));
        const stamp = fields.get(7)?.[0] || fields.get(8)?.[0];
        const time = stamp ? parsePbMap(stamp) : new Map();
        const epoch = value => { const parts = parsePbMap(value || Buffer.alloc(0)); return parts.has(1) ? parts.get(1)[0] * 1000 + (parts.get(2)?.[0] || 0) / 1e6 : null; };
        const transitions = (parsePbMap(fields.get(26)?.[0] || Buffer.alloc(0)).get(1) || []).map(value => parsePbMap(value));
        const terminal = transitions.filter(item => [3, 6, 7, 12].includes(item.get(1)?.[0])).map(item => epoch(item.get(2)?.[0])).filter(value => value !== null);
        return {
          idx: step.idx, step_type: step.step_type, status: step.status,
          // Keep the existing footer-speed boundary unchanged.
          completedAtMs: (time.get(1)?.[0] || 0) * 1000 + (time.get(2)?.[0] || 0) / 1e6,
          recordedCompletedAtMs: epoch(fields.get(8)?.[0]),
          createdAtMs: epoch(fields.get(1)?.[0]),
          terminalAtMs: terminal.length ? Math.max(...terminal) : null,
          executionId: fields.get(12)?.[0]?.toString('utf8') || '',
        };
      });
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='executor_metadata'").get()) {
        executors = db.prepare('SELECT data FROM executor_metadata ORDER BY idx').all().map(row => {
          const fields = parsePbMap(Buffer.from(row.data || []));
          return { reason: fields.get(1)?.[0] || 0, lastStepIndex: fields.size ? (fields.get(3)?.[0] ?? 0) : -1, executionId: fields.get(9)?.[0]?.toString('utf8') || '' };
        });
      }
    }
    const stepRow = db.prepare('SELECT metadata FROM steps ORDER BY idx DESC LIMIT 1').get();
    if (stepRow?.metadata) {
      const sm = parsePbMap(Buffer.from(stepRow.metadata));
      if (sm.has(1)) {
        const tsMap = parsePbMap(sm.get(1)[0]);
        if (tsMap.has(1)) {
          lastStepEpochMs = Number(tsMap.get(1)[0]) * 1000;
        }
      }
    }
  } finally {
    db.close();
  }
  if (!lastStepEpochMs) {
    try {
      lastStepEpochMs = Math.max(statSync(dbPath).mtimeMs, existsSync(dbPath + '-wal') ? statSync(dbPath + '-wal').mtimeMs : 0);
    } catch {}
  }

  const turns = [];
  let maxContextTokens = 0;
  let latestGeneration = null;
  let latestRequestError = classifyRequestError();
  const parsedRequests = [];

  for (const row of rawRows) {
    const parsed = parseGenRow(row.idx, row.data);
    if (!parsed) continue;
    parsedRequests.push(parsed);
    latestGeneration = parsed.generation;
    latestRequestError = parsed.requestError;
    if (parsed.maxContextTokens > 0) {
      maxContextTokens = parsed.maxContextTokens;
    }
    if (parsed.contextTokens === 0) continue;
    turns.push(parsed);
  }

  // Start accumulating from the latest compaction checkpoint so pre-compaction
  // output/thinking tokens do not inflate the active context breakdown.
  let epochStart = 0;
  if (turns.length > 0) {
    for (const cp of cpRows) {
      const postIdx = turns.findIndex((t) => t.lastStepIndex >= cp.idx);
      if (postIdx >= 0) {
        epochStart = postIdx;
        break;
      }
    }
    for (let i = epochStart + 1; i < turns.length; i++) {
      if (turns[i].contextTokens < turns[i - 1].contextTokens * 0.7) {
        epochStart = i;
      }
    }
  }

  const latest = turns[turns.length - 1] || {
    uncachedIn: 0,
    cachedIn: 0,
    contextTokens: 0,
    outTokens: 0,
    thinkTokens: 0,
  };
  if (turns.length === 0 || latest.contextTokens === 0) {
    lastStepEpochMs = 0;
  }

  // latest.contextTokens is the prompt sent *before* latest generated its output/thinking,
  // so only accumulate prior turns within the active compaction epoch.
  let rawOut = 0;
  let rawThink = 0;
  for (let i = epochStart; i < turns.length - 1; i++) {
    rawOut += turns[i].outTokens;
    rawThink += turns[i].thinkTokens;
  }

  const turn0Tokens = Math.min(turns[epochStart]?.contextTokens || 0, latest.contextTokens);
  const availGen = Math.max(0, latest.contextTokens - turn0Tokens);
  const genSum = rawOut + rawThink;
  const genScale = genSum > availGen && genSum > 0 ? availGen / genSum : 1;
  const totalOutputTokens = Math.round(rawOut * genScale);
  const totalThinkingTokens = Math.round(rawThink * genScale);

  return {
    turnSpeed: summarizeTurnSpeed(parsedRequests, turnSteps, userStepIndex),
    turnMetrics: summarizeTurnMetrics(parsedRequests, turnSteps.map(step => ({ ...step, completedAtMs: step.recordedCompletedAtMs })), metricsUserStepIndex, executors),
    requestError: latestRequestError,
    generation: summarizeGeneration(latestGeneration),
    cachedIn: latest.cachedIn,
    uncachedIn: latest.uncachedIn,
    contextTokens: latest.contextTokens,
    maxContextTokens,
    lastStepEpochMs,
    turn0Tokens,
    totalOutputTokens,
    totalThinkingTokens,
  };
}

const PV_SVG = {
  db: '<svg class="pv-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>',
  clock: '<svg class="pv-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>',
  cal: '<svg class="pv-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  warn: '<svg class="pv-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><circle cx="12" cy="17" r=".8" fill="currentColor"/></svg>',
  ring: '<svg width="13" height="13" viewBox="0 0 18 18" style="transform:rotate(-90deg);flex-shrink:0"><circle cx="9" cy="9" r="6.5" fill="none" stroke="rgba(142,142,147,0.28)" stroke-width="2.4"/><circle cx="9" cy="9" r="6.5" fill="none" stroke="#4ea84e" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="40.84" stroke-dashoffset="6.1"/></svg>',
};

const PV_CARD_PREVIEW = {
  highlightActiveModel: `<div class="pv-active-model">
    <div class="pv-qm-row pv-qm-active"><span class="pv-qm-name">Gemini<span class="pv-qm-dot"></span></span><span class="pv-qm-bar"><span style="width:85%"></span></span><span class="pv-qm-pct">85%</span></div>
    <div class="pv-qm-row pv-qm-other"><span class="pv-qm-name">Claude</span><span class="pv-qm-bar"><span style="width:60%"></span></span><span class="pv-qm-pct">60%</span></div>
  </div>`,
  hideUnavailableQuota: `<div class="pv-hide-quota">
    <span class="pv-pill pv-hq-pill"><span class="pv-hq-miss">${PV_SVG.clock}<span>--%</span></span><span class="pv-hq-keep">${PV_SVG.cal}<span>85%</span></span></span>
    <span class="pv-pill pv-hq-pill"><span class="pv-hq-zero">${PV_SVG.clock}<span>0%</span></span><span class="pv-hq-keep">${PV_SVG.cal}<span>85%</span></span></span>
  </div>`,
  showCacheWarnings: `<div class="pv-cache-warn">
    <span class="pv-pill pv-ca-1">${PV_SVG.db}<span>&lt;3m</span></span>
    <span class="pv-pill pv-ca-2">${PV_SVG.db}<span>3m+</span></span>
    <span class="pv-pill pv-ca-3">${PV_SVG.db}<span>4m+</span></span>
  </div>`,
  showContextWarnings: `<div class="pv-ctx-warn">
    <span class="pv-pill pv-cw-1">${PV_SVG.db}<span class="pv-cw-val">40%</span></span>
    <span class="pv-pill pv-cw-2">${PV_SVG.db}<span class="pv-cw-val">75%</span></span>
    <span class="pv-pill pv-cw-3">${PV_SVG.db}<span class="pv-cw-val">90%</span></span>
  </div>`,
  showRequestErrors: `<div class="pv-err-strip">
    <span class="pv-pill">${PV_SVG.db}<span>42%</span></span>
    <span class="pv-pill">${PV_SVG.clock}<span>85%</span></span>
    <span class="pv-pill pv-pill-err">${PV_SVG.warn}<span>429</span></span>
  </div>`,
  showRequestMetrics: `<div class="pv-req-line">
    <div class="pv-pill pv-req-pill"><span>TTFT 1.0s–3.0s</span><span><b>100.0 tok/s</b></span></div>
  </div>`,
};

const renderCheckCard = ({ id, helpId = id, key, tip = '', checked = false, sub = false, inlineSample = '', preview = PV_CARD_PREVIEW[key] || '' }) => `
  <div class="setting-card${sub ? ' setting-sub' : ''}${tip ? ' metric-setting' : ''}" data-setting-card="${key}" data-checked="${checked}">
    <div class="setting-head">
      <label class="setting-check">
        <input id="${id}" name="${key}" type="checkbox"${checked ? ' checked' : ''}${tip ? ` aria-describedby="help-${helpId}"` : ''} />
        <span data-i18n="${key}"></span>
      </label>${inlineSample ? `<span class="setting-inline-sample" aria-hidden="true">${inlineSample}</span>` : ''}${tip ? `<span class="setting-help-dot" aria-hidden="true">?</span>` : ''}
    </div>
    ${preview ? `<div class="setting-preview" aria-hidden="true">${preview}</div>` : ''}
    ${tip ? `<div class="metric-help" id="help-${helpId}" role="tooltip" data-i18n="${tip}"></div>` : ''}
  </div>`;

const renderPickCard = (key, tip, cols, items, inlineIconsOnly = false) => inlineIconsOnly ? `
  <div class="setting-card" data-setting-card="${key}">
    <div class="setting-head"><span class="setting-label" data-i18n="${key}"></span>
      <div class="pv-pick-inline">
        ${items.map(([val, labelKey, iconHtml]) => `<button type="button" class="pv-swatch pv-swatch-icon" data-pick-setting="${key}" data-pick-value="${val}" data-pick-label="${labelKey}">${iconHtml}</button>`).join('')}
      </div>
    </div>
  </div>` : `
  <div class="setting-card${tip ? ' metric-setting' : ''}" data-setting-card="${key}">
    <div class="setting-head"><span class="setting-label" data-i18n="${key}"></span>${tip ? '<span class="setting-help-dot" aria-hidden="true">?</span>' : ''}</div>
    <div class="setting-preview"><div class="pv-pick-grid pv-cols-${cols}">
      ${items.map(([val, labelKey, iconHtml]) => `<button type="button" class="pv-swatch" data-pick-setting="${key}" data-pick-value="${val}">${iconHtml}<span class="pv-swatch-label" data-i18n="${labelKey}"></span></button>`).join('')}
    </div></div>
    ${tip ? `<div class="metric-help" role="tooltip" data-i18n="${tip}"></div>` : ''}
  </div>`;

const UI_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>agy-capsule</title>
  <script src="/preload.js"></script>
  <style>
    * { box-sizing: border-box; }
    html, body { scrollbar-width: none; }
    html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; width: 0; height: 0; }
    body {
      margin: 0;
      padding: 0;
      font-family: "Source Han Sans CN", "思源黑体 CN", "Source Han Sans SC", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
      font-weight: 400;
      font-variation-settings: normal;
      font-variant-ligatures: normal;
      background: var(--background, #141414);
      color: var(--foreground, #ebebeb);
      font-size: 13.5px;
      line-height: 1.32;
      user-select: none;
      -webkit-font-smoothing: antialiased;
    }
    .panel {
      width: 100%;
      max-width: 1120px;
      margin: 0 auto;
      min-width: 0;
      padding: 4px 2px;
      container-type: inline-size;
      container-name: stats;
    }
    .stats-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
      min-width: 0;
    }
    .stats-context {
      min-width: 0;
    }
    .stats-quota {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: calc(var(--agy-section-gap, 6px) + 4px);
      align-items: start;
      min-width: 0;
    }
    .divider:has(+ #quota-root:empty) {
      display: none;
    }
    .cache-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      font-size: 13.5px;
      line-height: 1.35;
      padding-bottom: var(--agy-section-gap, 6px);
      margin-bottom: var(--agy-section-gap, 6px);
      border-bottom: 1px solid var(--border, rgba(142, 142, 147, 0.24));
    }
    .cache-left {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-weight: 500;
      color: var(--foreground, #ebebeb);
      color: color-mix(in srgb, var(--foreground, #ebebeb) 88%, transparent);
      white-space: nowrap;
    }
    .cache-left > .dot {
      width: 10px;
      height: 10px;
      flex-shrink: 0;
    }
    .cache-pct {
      margin-left: 0;
      font-variant-numeric: tabular-nums;
      font-size: 13.5px;
      white-space: nowrap;
    }
    .cache-k {
      text-align: right;
      color: var(--muted-foreground, #8e8e93);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      font-size: 13.5px;
      font-weight: 400;
    }
    .cache-k:empty { display: none; }
    .summary-row {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      row-gap: 4px;
      margin-bottom: 6px;
    }
    .used-pct {
      font-size: 13.5px;
      font-weight: 400;
      color: var(--muted-foreground, #8e8e93);
    }
    .used-pct > #used-pct {
      font-weight: 500;
      color: var(--foreground, #ebebeb);
      color: color-mix(in srgb, var(--foreground, #ebebeb) 88%, transparent);
    }
    .used-fraction {
      margin-left: auto;
      white-space: nowrap;
      font-size: 13.5px;
      font-weight: 400;
      color: var(--muted-foreground, #8e8e93);
      font-variant-numeric: tabular-nums;
    }
    .progress-track {
      position: relative;
      width: 100%;
      height: 4px;
      background: rgba(142, 142, 147, 0.24);
      border-radius: 999px;
      display: flex;
      gap: 1.5px;
      overflow: hidden;
      margin-bottom: 8px;
    }
    .seg {
      height: 100%;
      border-radius: 999px;
      transition: width 0.25s ease;
    }
    .list, .turn-bar-list {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      align-items: start;
      gap: 6px;
    }
    .turn-bar-list {
      grid-template-columns: minmax(calc((100% - 18px) / 4), max-content) minmax(0, 1fr) calc((100% - 18px) / 4) calc((100% - 18px) / 4);
    }
    .item-row, .turn-bar-item {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      column-gap: 5px;
      row-gap: 2px;
      min-width: 0;
    }
    .item-left {
      display: contents;
    }
    .item-left > span:last-child, .turn-bar-label, .turn-bar-short {
      color: var(--muted-foreground, #8e8e93);
      font-size: 13.5px;
      line-height: 1.25;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .turn-bar-item[data-turn-row="requests"] { container-type: inline-size; }
    .turn-bar-short { display: none; }
    @container (max-width: 39px) {
      .turn-bar-item[data-turn-row="requests"] .turn-bar-label { display: none; }
      .turn-bar-item[data-turn-row="requests"] .turn-bar-short { display: block; }
    }
    .item-left > .dot, .turn-bar-line {
      grid-row: 1 / span 2;
      align-self: stretch;
      width: 2.5px;
      margin: 2px 0;
      border-radius: 99px;
      flex-shrink: 0;
      transition: background-color 0.25s ease, opacity 0.25s ease;
    }
    .turn-bar-line {
      background: rgba(142, 142, 147, 0.42);
      background: color-mix(in srgb, var(--muted-foreground, #8e8e93) 55%, transparent);
    }
    .dot-cached { background: #2b7fff; }
    .dot-uncached { background: #f97316; }
    .dot-meta { background: rgba(142, 142, 147, 0.55); }
    .item-k, .turn-bar-val {
      grid-column: 2;
      color: var(--muted-foreground, #8e8e93);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      font-size: 13.5px;
      font-weight: 400;
      line-height: 1.25;
    }
    .divider {
      height: 1px;
      background: var(--border, rgba(142, 142, 147, 0.24));
      margin: 8px 0;
    }
    .quota-group {
      margin-bottom: 9px;
    }
    .quota-group:last-child {
      margin-bottom: 0;
    }
    .quota-group-title {
      overflow-wrap: anywhere;
      font-size: 13.5px;
      font-weight: 500;
      color: var(--foreground, #ebebeb);
      color: color-mix(in srgb, var(--foreground, #ebebeb) 88%, transparent);
      margin-bottom: 4px;
    }
    .quota-bucket {
      margin-bottom: 4px;
    }
    .quota-bucket:last-child {
      margin-bottom: 0;
    }
    .quota-line1 {
      display: grid;
      grid-template-columns: 54px minmax(58px, 1fr) minmax(46px, auto);
      align-items: center;
      column-gap: 8px;
      font-size: 13.5px;
      font-variant-numeric: tabular-nums;
    }
    .quota-label {
      color: var(--muted-foreground, #8e8e93);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .quota-mid {
      text-align: right;
      color: var(--muted-foreground, #8e8e93);
      white-space: nowrap;
    }
    .quota-right {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 6px;
      color: var(--muted-foreground, #8e8e93);
      white-space: nowrap;
    }
    .settings { display: flex; flex-direction: column; gap: 0; width: 100%; }
    .sidebar-content { padding: 12px 14px; }
    .sidebar-view[hidden] { display: none; }
    .sidebar-nav { position: sticky; top: 0; z-index: 20; margin: -12px -14px 10px; padding: 8px 14px; background: var(--background, #141414); border-bottom: 1px solid color-mix(in srgb, var(--border, rgba(142,142,147,.24)) 65%, transparent); }
    .sidebar-tabs { position: relative; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: center; max-width: 1120px; margin: 0 auto; padding: 2.5px; border-radius: 7px; background: color-mix(in srgb, var(--foreground, #ebebeb) 6%, var(--background, #141414)); border: 1px solid color-mix(in srgb, var(--foreground, #ebebeb) 10%, transparent); }
    .sidebar-tabs button { position: relative; z-index: 1; min-width: 0; min-height: 26px; padding: 3px 8px; border: 0; border-radius: 5px; background: transparent; color: var(--muted-foreground, #8e8e93); font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; transition: color .15s ease; }
    .sidebar-tabs button[aria-selected="true"] { color: var(--foreground, #ebebeb); font-weight: 600; }
    .sidebar-tabs button:hover { color: var(--foreground, #ebebeb); }
    .sidebar-tabs button:focus-visible { outline: 2px solid #388bfd; outline-offset: 1px; }
    .sidebar-toggle-track { position: absolute; inset: 2.5px; border-radius: 5px; pointer-events: none; }
    .sidebar-toggle-thumb { display: block; width: 50%; height: 100%; border-radius: 5px; background: color-mix(in srgb, var(--foreground, #ebebeb) 14%, var(--background, #141414)); box-shadow: 0 1px 2.5px rgba(0,0,0,.22), inset 0 0 0 1px color-mix(in srgb, var(--foreground, #ebebeb) 14%, transparent); transform: translateX(0); transition: transform .18s cubic-bezier(.22,1,.36,1); }
    .sidebar-tabs[data-view="settings"] .sidebar-toggle-thumb { transform: translateX(100%); }
    @media(prefers-reduced-motion:reduce) { .sidebar-toggle-thumb { transition: none; } }
    @media(pointer:coarse) { .sidebar-tabs button { min-height: 44px; } }
    .settings-scope { margin-top: 8px; padding: 10px 0 4px; border-top: 1px solid var(--border, rgba(142,142,147,.22)); font-size: 12px; font-weight: 600; color: var(--muted-foreground, #8e8e93); letter-spacing: .01em; }
    .settings-scope.metric-setting { position: relative; }
    .settings-scope-title { font-size: 12px; font-weight: 600; color: var(--muted-foreground, #8e8e93); }
    .setting-card { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 7px 0; border-top: 1px solid color-mix(in srgb, var(--border, rgba(142,142,147,.24)) 55%, transparent); background: transparent; }
    .settings > .setting-card:first-child, .settings-scope + .setting-card { border-top: 0; }
    .setting-card.setting-sub { padding-left: 18px; border-top-style: dashed; }
    .setting-card[data-parent-off="true"], [data-parent-off="true"] { opacity: .45; }
    [data-parent-off="true"] .setting-check,
    [data-parent-off="true"] input[type="checkbox"] { cursor: not-allowed; }
    .setting-head.setting-pair-head { justify-content: flex-start; gap: 14px; flex-wrap: nowrap; }
    .setting-pair-item { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    .setting-pair-item .setting-check { flex: 0 1 auto; }
    .setting-speed-pair .setting-help-dot { margin-left: auto; }
    .pv-detail-pop { overflow: hidden; max-height: 120px; opacity: 1; margin: 2px 0 6px; transition: max-height .2s ease, opacity .18s ease, margin .2s ease; }
    .pv-detail-pop[data-open="false"] { max-height: 0; opacity: 0; margin: 0; pointer-events: none; }
    .pv-detail-card { padding: 7px 9px; border-radius: 7px; border: 1px solid color-mix(in srgb, var(--border, rgba(142,142,147,.28)) 70%, transparent); background: color-mix(in srgb, var(--foreground, #ebebeb) 4%, var(--background, #141414)); font-size: 11.5px; color: var(--muted-foreground, #8e8e93); font-variant-numeric: tabular-nums; }
    .pv-detail-bars { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: start; gap: 6px; }
    .pv-tb-item { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; column-gap: 4px; row-gap: 1.5px; min-width: 0; }
    .pv-tb-line { grid-row: 1 / span 2; align-self: stretch; width: 2px; margin: 1.5px 0; border-radius: 99px; background: color-mix(in srgb, var(--muted-foreground, #8e8e93) 55%, transparent); }
    .pv-tb-lbl, .pv-tb-val { line-height: 1.2; white-space: nowrap; }
    .pv-tb-val { grid-column: 2; }
    .setting-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-height: 22px; }
    .setting-head > label, .setting-label { font-size: 13px; color: var(--foreground, #ebebeb); min-width: 0; }
    .setting-lang-label { display: inline-flex; align-items: center; gap: 5px; }
    .setting-lang-label svg { flex-shrink: 0; color: var(--muted-foreground, #8e8e93); }
    .setting-head select { width: auto; min-width: 0; max-width: 56%; margin-left: auto; padding: 3px 7px; font: inherit; font-size: 12px; color: var(--foreground, #ebebeb); background: var(--card, #222225); border: 1px solid var(--border, #444); border-radius: 5px; }
    .setting-check { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; cursor: pointer; }
    .setting-check input[type="checkbox"] { appearance: none; -webkit-appearance: none; position: relative; margin: 0; flex-shrink: 0; width: 28px; height: 15px; border-radius: 99px; background: color-mix(in srgb, var(--foreground, #ebebeb) 13%, transparent); border: 1px solid color-mix(in srgb, var(--foreground, #ebebeb) 16%, transparent); cursor: pointer; transition: background .18s ease, border-color .18s ease; }
    .setting-check input[type="checkbox"]::after { content: ""; position: absolute; top: 1.5px; left: 1.5px; width: 10px; height: 10px; border-radius: 50%; background: var(--muted-foreground, #8e8e93); transform: translateX(0); transition: transform .18s cubic-bezier(.22,1,.36,1), background .18s ease; }
    .setting-check input[type="checkbox"]:checked { background: rgba(78, 168, 78, .24); border-color: rgba(78, 168, 78, .65); }
    .setting-check input[type="checkbox"]:checked::after { transform: translateX(13px); background: #4ea84e; }
    .setting-check input[type="checkbox"]:focus-visible { outline: 2px solid #388bfd; outline-offset: 1px; }
    .setting-check > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .setting-inline-sample { flex-shrink: 0; font-size: 11.5px; color: var(--muted-foreground, #8e8e93); font-variant-numeric: tabular-nums; white-space: nowrap; transition: opacity .15s ease; }
    .setting-inline-sample b { color: var(--foreground, #ebebeb); font-weight: 600; }
    .setting-card[data-checked="false"]:not([data-setting-card="speedAnimation"]) .setting-inline-sample { opacity: .42; text-decoration: line-through; }
    .setting-help-dot { flex-shrink: 0; width: 15px; height: 15px; padding: 0; border-radius: 50%; border: 1px solid var(--border, rgba(142,142,147,.4)); background: transparent; color: var(--muted-foreground, #8e8e93); font: inherit; font-size: 10.5px; line-height: 13px; text-align: center; cursor: help; }
    .metric-help { position: absolute; bottom: calc(100% + 5px); left: 0; z-index: 10; box-sizing: border-box; width: 100%; max-width: 360px; padding: 10px 12px; border: 1px solid var(--border, #444); border-radius: 6px; background: var(--card, #222225); color: var(--foreground, #ebebeb); line-height: 1.5; overflow-wrap: anywhere; box-shadow: 0 3px 12px #0003; visibility: hidden; pointer-events: none; }
    .metric-setting:not([data-help-dismissed]) .setting-head:hover ~ .metric-help,
    .metric-setting:not([data-help-dismissed]):focus-within .metric-help { visibility: visible; }
    .setting-preview { padding: 2px 0 1px; background: transparent; border: 0; font-size: 11.5px; line-height: 1.25; color: var(--muted-foreground, #8e8e93); font-variant-numeric: tabular-nums; overflow: hidden; }
    .pv-svg { width: 11px; height: 11px; flex-shrink: 0; }
    .pv-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 5px; background: var(--secondary, rgba(128,128,128,.16)); color: var(--muted-foreground, #8e8e93); white-space: nowrap; }
    /* Same-row clickable block pickers */
    .pv-pick-grid { display: grid; gap: 5px; }
    .pv-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .pv-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .pv-pick-inline { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; }
    .pv-swatch { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 0; min-height: 27px; padding: 4px 6px; border-radius: 5px; border: 1px solid var(--border, rgba(142,142,147,.28)); background: var(--card, #222225); color: var(--muted-foreground, #8e8e93); font: inherit; font-size: 11px; cursor: pointer; transition: border-color .12s ease, color .12s ease; }
    .pv-swatch-icon { min-width: 38px; padding: 4px 10px; }
    .pv-swatch:hover { background: var(--secondary, #303034); color: var(--foreground, #ebebeb); }
    .pv-swatch[data-active="true"] { border-color: #2b7fff; color: var(--foreground, #ebebeb); background: color-mix(in srgb, #2b7fff 14%, var(--card, #222225)); font-weight: 500; }
    .pv-swatch-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pv-ico-layout { display: inline-flex; align-items: flex-end; gap: 2.5px; height: 12px; flex-shrink: 0; }
    .pv-ico-layout i { display: block; width: 5px; border: 1.2px solid currentColor; border-radius: 1.5px; }
    .pv-il-tall { height: 12px; }
    .pv-il-short { height: 7.5px; }
    .pv-ico-density { display: inline-flex; flex-direction: column; justify-content: center; width: 12px; height: 12px; flex-shrink: 0; }
    .pv-ico-density i { display: block; height: 1.5px; width: 100%; background: currentColor; border-radius: 1px; }
    .pv-ico-density i:nth-child(2) { width: 75%; }
    .pv-id-compact { gap: 1.5px; }
    .pv-id-standard { gap: 2.8px; }
    .pv-id-spacious { gap: 4px; }
    .pv-ico-bar { width: 16px; height: 4px; border-radius: 99px; background: rgba(142,142,147,.3); overflow: hidden; flex-shrink: 0; }
    .pv-ico-bar i { display: block; width: 78%; height: 100%; background: #4ea84e; border-radius: inherit; }
    /* Active model highlight: state-driven */
    .pv-active-model { display: flex; flex-direction: column; gap: 4px; }
    .pv-qm-row { display: grid; grid-template-columns: 58px 1fr auto; align-items: center; gap: 6px; transition: opacity .2s ease; }
    .pv-qm-name { display: inline-flex; align-items: center; gap: 4px; color: var(--foreground, #ebebeb); font-weight: 500; }
    .pv-qm-dot { width: 4.5px; height: 4.5px; border-radius: 50%; background: #4ea84e; opacity: 0; transform: scale(.5); transition: opacity .2s ease, transform .2s ease; }
    .pv-qm-bar { height: 4px; border-radius: 99px; background: rgba(142,142,147,.24); overflow: hidden; }
    .pv-qm-bar > span { display: block; height: 100%; background: #4ea84e; border-radius: inherit; }
    .pv-qm-pct { font-size: 10.5px; }
    .pv-qm-other { opacity: 1; transition: opacity .2s ease; }
    [data-setting-card="highlightActiveModel"][data-checked="true"] .pv-qm-other { opacity: .38; }
    [data-setting-card="highlightActiveModel"][data-checked="true"] .pv-qm-dot { opacity: 1; transform: scale(1); }
    /* Hide absent quota windows: unchecked shows --%, checked hides --% while keeping 0% */
    .pv-hide-quota { display: flex; align-items: center; gap: 6px; }
    .pv-hq-pill { flex: 1; justify-content: center; gap: 0; }
    .pv-hq-miss, .pv-hq-zero, .pv-hq-keep { display: inline-flex; align-items: center; gap: 3px; overflow: hidden; white-space: nowrap; }
    .pv-hq-miss { max-width: 56px; opacity: 1; margin-right: 6px; transition: max-width .22s ease, opacity .18s ease, margin-right .22s ease; }
    .pv-hq-zero { margin-right: 6px; color: #ef4444; font-weight: 600; }
    [data-setting-card="hideUnavailableQuota"][data-checked="true"] .pv-hq-miss { max-width: 0; opacity: 0; margin-right: 0; }
    /* Cache expiry warning: unchecked all neutral, checked 3m+ yellow icon, 4m+ red icon */
    .pv-cache-warn { display: flex; align-items: center; gap: 6px; }
    .pv-cache-warn .pv-pill { flex: 1; justify-content: center; }
    .pv-cache-warn .pv-svg { transition: color .18s ease; }
    [data-setting-card="showCacheWarnings"][data-checked="true"] .pv-ca-2 .pv-svg { color: #d4940a; }
    [data-setting-card="showCacheWarnings"][data-checked="true"] .pv-ca-3 .pv-svg { color: #e06c75; }
    /* Context warning colors: normal stays neutral; only 75% / 90% change color. */
    .pv-ctx-warn { display: flex; align-items: center; gap: 6px; }
    .pv-ctx-warn .pv-pill { flex: 1; justify-content: center; }
    .pv-cw-val { color: var(--muted-foreground, #8e8e93); font-weight: 400; transition: color .18s ease; }
    [data-setting-card="showContextWarnings"][data-checked="true"] .pv-cw-2 .pv-cw-val { color: #d4940a; font-weight: 600; }
    [data-setting-card="showContextWarnings"][data-checked="true"] .pv-cw-3 .pv-cw-val { color: #e06c75; font-weight: 600; }
    /* Request failure capsule: unchecked hides 3rd error pill, checked shows it */
    .pv-err-strip { display: flex; align-items: center; gap: 6px; }
    .pv-err-strip .pv-pill { flex: 1; justify-content: center; }
    .pv-pill-err { color: #e06c75; background: rgba(224,108,117,.14); font-weight: 600; max-width: 120px; opacity: 1; overflow: hidden; transition: max-width .22s ease, opacity .18s ease, padding .22s ease, flex .22s ease; }
    [data-setting-card="showRequestErrors"][data-checked="false"] .pv-pill-err { max-width: 0; opacity: 0; padding-left: 0; padding-right: 0; flex: 0; }
    .pv-req-line { display: flex; }
    .pv-req-pill { flex: 1; display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 4px 8px; transition: opacity .18s ease; }
    .pv-req-pill b { font-weight: 500; color: color-mix(in srgb, var(--foreground, #ebebeb) 88%, transparent); }
    [data-setting-card="showRequestMetrics"][data-checked="false"] .pv-req-pill { opacity: .38; }
    /* Speed breathing & cooldown */
    .pv-speed-cap { display: flex; align-items: center; }
    .pv-speed-cap .pv-pill { gap: 5px; }
    .pv-sc-val { display: inline-flex; align-items: center; gap: 4px; max-width: 90px; opacity: 1; overflow: hidden; white-space: nowrap; transition: max-width .22s ease, opacity .18s ease, margin .22s ease; }
    [data-setting-card="showSpeed"][data-checked="false"] .pv-sc-val { max-width: 0; opacity: 0; margin-left: -5px; }
    .pv-sc-val .pv-sa-dot { display: none; }
    [data-setting-card="showSpeed"][data-speed-fx="true"] .pv-sc-val { color: light-dark(#16a34a, #4ea84e); font-weight: 600; }
    [data-setting-card="showSpeed"][data-speed-fx="true"] .pv-sc-val .pv-sa-dot { display: inline-block; }
    .pv-sa-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex-shrink: 0; animation: dk-speed-breathe 1.2s ease-in-out infinite; }
    [data-setting-card="showSpeed"][data-speed-fx="true"]:hover .pv-sc-val,
    [data-setting-card="showSpeed"][data-speed-fx="true"]:focus-within .pv-sc-val { animation: pv-speed-lifecycle 3.6s ease-in-out infinite; }
    @keyframes dk-speed-breathe { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.78); } }
    @keyframes pv-speed-lifecycle { 0%,60% { color: light-dark(#16a34a, #4ea84e); } 75%,95% { color: var(--muted-foreground, #8e8e93); } 100% { color: light-dark(#16a34a, #4ea84e); } }
    @media (prefers-reduced-motion: reduce) {
      .setting-card *, .setting-card *::before, .setting-card *::after { animation: none !important; transition: none !important; }
    }
    .quota-meter { display: inline-block; flex: 1; min-width: 20px; max-width: none; height: 4px; background: rgba(142,142,147,.24); border-radius: 99px; overflow: hidden; }
    .quota-meter > span { display: block; height: 100%; border-radius: inherit; }
    .generation-block { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border, rgba(142,142,147,.24)); color: var(--muted-foreground, #8e8e93); font-variant-numeric: tabular-nums; }
    .generation-grid { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 10px; align-items: baseline; }
    .generation-row { display: inline-flex; align-items: baseline; gap: 4px; min-width: 0; font-size: 13.5px; font-weight: 400; color: var(--muted-foreground, #8e8e93); }
    [data-generation-row="speed"] { justify-self: end; }
    .generation-row > :first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .generation-row > :last-child { flex-shrink: 0; white-space: nowrap; font-weight: 500; color: var(--foreground, #ebebeb); color: color-mix(in srgb, var(--foreground, #ebebeb) 88%, transparent); }
    [data-generation-row="timing"] > :last-child { font-weight: 400; color: var(--muted-foreground, #8e8e93); }
    .generation-heading { margin-bottom: 8px; font-size: 13.5px; font-weight: 500; color: var(--foreground, #ebebeb); color: color-mix(in srgb, var(--foreground, #ebebeb) 88%, transparent); }
    .generation-row[hidden], [data-generation-group][hidden] { display: none; }
    .panel .list { row-gap: var(--agy-row-gap); }
    .panel .quota-group { margin: 0; min-width: 0; }
    .panel .quota-group-title { margin-bottom: var(--agy-row-gap); }
    .panel .quota-bucket { margin-bottom: var(--agy-row-gap); }
    .panel .quota-bucket:last-child { margin-bottom: 0; }
    .panel .generation-block { margin-top: var(--agy-section-gap); padding-top: var(--agy-section-gap); }
    .panel [data-generation-block]:not([hidden]) + [data-turn-metrics-block] { border-top: 0; padding-top: 0; margin-top: var(--agy-section-gap); }
    .panel .generation-grid { row-gap: var(--agy-row-gap); }
    .panel .generation-heading { margin-bottom: var(--agy-row-gap); }
    body[data-quota-indicator="bar"] .quota-right { min-width: 0; justify-content: flex-start; }
    body[data-quota-indicator="bar"] .quota-right > span:first-child { min-width: 34px; text-align: right; }
    body[data-quota-indicator="bar"] .quota-line1 { grid-template-columns: 54px minmax(0, 1fr) minmax(46px, auto); }
    body[data-language^="zh"] .quota-line1 { grid-template-columns: 42px minmax(58px, 1fr) minmax(46px, auto); }
    body[data-language^="zh"][data-quota-indicator="bar"] .quota-line1 { grid-template-columns: 42px minmax(0, 1fr) minmax(46px, auto); }
    .quota-group:not(:has(.quota-mid:not(:empty))) .quota-line1 { grid-template-columns: 54px minmax(0, 1fr); }
    body[data-language^="zh"] .quota-group:not(:has(.quota-mid:not(:empty))) .quota-line1 { grid-template-columns: 42px minmax(0, 1fr); }
    .quota-group:not(:has(.quota-mid:not(:empty))) .quota-mid { display: none; }
    @container stats (min-width: 420px) {
      .stats-layout {
        gap: calc(var(--agy-section-gap, 6px) + 6px);
      }
      .stats-context,
      .panel .quota-group {
        padding: calc(var(--agy-pad-y, 8px) + 2px) calc(var(--agy-pad-x, 10px) + 2px);
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--border, rgba(142, 142, 147, 0.24)) 72%, transparent);
        background: color-mix(in srgb, var(--foreground, #ebebeb) 3%, transparent);
      }
      .divider {
        display: none;
      }
      .stats-quota {
        grid-template-columns: repeat(auto-fit, minmax(195px, 1fr));
        gap: calc(var(--agy-section-gap, 6px) + 4px);
      }
    }
    @container stats (min-width: 540px) {
      .stats-layout {
        grid-template-columns: clamp(250px, 36%, 350px) minmax(0, 1fr);
        align-items: start;
      }
      .stats-layout:has(> #quota-root:empty) {
        grid-template-columns: minmax(0, 380px);
        justify-content: center;
      }
      .stats-quota {
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      }
    }
    body[data-label-case="lowercase"] .panel .cache-left,
    body[data-label-case="lowercase"] .panel .used-pct,
    body[data-label-case="lowercase"] .panel .item-left > span:last-child,
    body[data-label-case="lowercase"] .panel .turn-bar-label,
    body[data-label-case="lowercase"] .panel .turn-bar-short,
    body[data-label-case="lowercase"] .panel .quota-label { text-transform: lowercase; }
    @media(pointer:coarse) { .pv-swatch { min-height: 40px; } }
  </style>
</head>
<body>
  <main class="sidebar-content">
  <div class="sidebar-nav">
    <div class="sidebar-tabs" role="tablist" aria-label="Sidebar 页面" data-view="stats">
      <button type="button" id="sidebar-tab-stats" role="tab" aria-selected="true" aria-controls="sidebar-stats" tabindex="0">统计</button>
      <span class="sidebar-toggle-track" aria-hidden="true"><span class="sidebar-toggle-thumb"></span></span>
      <button type="button" id="sidebar-tab-settings" role="tab" aria-selected="false" aria-controls="sidebar-settings" tabindex="-1">设置</button>
    </div>
  </div>
  <div class="panel sidebar-view" id="sidebar-stats" role="tabpanel" aria-labelledby="sidebar-tab-stats" tabindex="0">
    <div class="stats-layout">
      <section class="stats-context">
        <div class="cache-bar" id="row-cached">
          <div class="cache-left"><span data-i18n="cache">Cache</span><span class="cache-pct" id="val-cache-hit">0%</span><span class="dot" id="dot-cached" style="display:inline-flex;align-items:center;justify-content:center;background:transparent"></span></div>
          <div class="cache-k" id="val-cache-hit-k"></div>
        </div>

        <div class="summary-row">
          <div class="used-pct" data-context-tip="overview"><span id="used-pct">0%</span> <span data-i18n="used">used</span></div>
          <div class="used-fraction" id="used-fraction" data-context-tip="overview">0 / --</div>
        </div>

        <div class="progress-track" id="progress-track" data-context-tip="overview">
          <div class="seg" id="seg-turn0" style="width: 0%; background: #d4940a"></div>
          <div class="seg" id="seg-read" style="width: 0%; background: #388bfd"></div>
          <div class="seg" id="seg-think" style="width: 0%; background: #00b386"></div>
          <div class="seg" id="seg-out" style="width: 0%; background: #e86a24"></div>
        </div>

        <div class="list">
          <div class="item-row" id="row-turn0" data-context-tip="turn0">
            <div class="item-left"><span class="dot" style="background:#d4940a"></span><span data-i18n="turn0">Turn0</span></div>
            <div class="item-k" id="val-turn0-k">0</div>
          </div>

          <div class="item-row" id="row-read" data-context-tip="read">
            <div class="item-left"><span class="dot" style="background:#388bfd"></span><span data-i18n="read">Read</span></div>
            <div class="item-k" id="val-read-k">0</div>
          </div>

          <div class="item-row" id="row-think" data-context-tip="think">
            <div class="item-left"><span class="dot" style="background:#00b386"></span><span data-i18n="think">Think</span></div>
            <div class="item-k" id="val-think-k">0</div>
          </div>

          <div class="item-row" id="row-out" data-context-tip="write">
            <div class="item-left"><span class="dot" style="background:#e86a24"></span><span data-i18n="write">Write</span></div>
            <div class="item-k" id="val-out-k">0</div>
          </div>
        </div>

        <div class="generation-block" data-generation-block>
          ${presentation.generationMarkup()}
        </div>
        ${presentation.turnMetricsMarkup()}
      </section>
      <div class="divider"></div>
      <div id="quota-root" class="stats-quota"></div>
    </div>
  </div>

  <section class="settings sidebar-view" id="sidebar-settings" role="tabpanel" aria-labelledby="sidebar-tab-settings" tabindex="0" hidden>
    ${renderPickCard('settingsLanguage', '', 3, [
      ['en', '', 'EN'],
      ['zh-CN', '', '简'],
      ['zh-TW', '', '繁'],
    ], true)}
    ${renderPickCard('language', '', 3, [
      ['en', '', 'EN'],
      ['zh-CN', '', '简'],
      ['zh-TW', '', '繁'],
    ], true)}

    <div class="settings-scope" data-i18n="appearanceSection"></div>
    ${renderPickCard('panelLayout', '', 2, [
      ['natural', 'naturalLayout', '<span class="pv-ico-layout"><i class="pv-il-tall"></i><i class="pv-il-short"></i></span>'],
      ['matched', 'matchedLayout', '<span class="pv-ico-layout"><i class="pv-il-tall"></i><i class="pv-il-tall"></i></span>'],
    ], true)}
    ${renderPickCard('density', '', 3, [
      ['compact', 'compact', '<span class="pv-ico-density pv-id-compact"><i></i><i></i><i></i></span>'],
      ['standard', 'standard', '<span class="pv-ico-density pv-id-standard"><i></i><i></i><i></i></span>'],
      ['spacious', 'spacious', '<span class="pv-ico-density pv-id-spacious"><i></i><i></i><i></i></span>'],
    ], true)}
    ${renderPickCard('quotaIndicator', '', 2, [
      ['ring', 'ring', PV_SVG.ring],
      ['bar', 'bar', '<span class="pv-ico-bar"><i></i></span>'],
    ], true)}
    ${renderPickCard('labelCase', '', 2, [
      ['lowercase', 'lowercase', 'aa'],
      ['titlecase', 'titlecase', 'Aa'],
    ], true)}
    ${renderPickCard('resetFormat', '', 2, [
      ['compact', 'compactTime', '4h 55m'],
      ['localized', 'localizedTime', '<span data-i18n="localizedTimeSample"></span>'],
    ], true)}

    <div class="settings-scope" data-settings-scope="features" data-i18n="featuresSection"></div>
    ${renderCheckCard({ id: 'setting-highlight-active-model', key: 'highlightActiveModel', checked: false })}
    ${renderCheckCard({ id: 'setting-hide-unavailable-quota', key: 'hideUnavailableQuota', checked: false })}
    ${renderCheckCard({ id: 'setting-cache-warnings', key: 'showCacheWarnings', checked: true })}
    ${renderCheckCard({ id: 'setting-context-warnings', key: 'showContextWarnings', checked: true })}
    ${renderCheckCard({ id: 'setting-request-errors', key: 'showRequestErrors', checked: true })}
    <div class="setting-card setting-speed-pair metric-setting" data-setting-card="showSpeed" data-checked="true" data-speed-fx="false">
      <div class="setting-head setting-pair-head">
        <div class="setting-pair-item">
          <label class="setting-check">
            <input id="setting-show-speed" name="showSpeed" type="checkbox" checked aria-describedby="help-speed-pair" />
            <span data-i18n="showSpeed"></span>
          </label>
        </div>
        <div class="setting-pair-item" data-setting-card="speedAnimation" data-checked="false" data-parent-off="false">
          <label class="setting-check">
            <input id="setting-speed-animation" name="speedAnimation" type="checkbox" aria-describedby="help-speed-pair" />
            <span data-i18n="speedAnimation"></span>
          </label>
        </div>
        <button type="button" class="setting-help-dot" aria-describedby="help-speed-pair">?</button>
      </div>
      <div class="setting-preview" aria-hidden="true">
        <div class="pv-speed-cap">
          <span class="pv-pill">${PV_SVG.db}<span>42%</span><span class="pv-sc-val"><span class="pv-sa-dot"></span><span>38.4 tok/s</span></span></span>
        </div>
      </div>
      <div class="metric-help" id="help-speed-pair" role="tooltip" data-i18n="speedPairTip"></div>
    </div>
    ${renderCheckCard({ id: 'setting-show-request-metrics', helpId: 'request-metrics', key: 'showRequestMetrics', tip: 'requestSectionTip', checked: true })}
    ${renderCheckCard({ id: 'setting-show-turn-metrics', helpId: 'turn-metrics', key: 'showTurnMetrics', tip: 'turnSectionTip', checked: true })}
    <div class="pv-detail-pop" data-preview-group="turn" data-open="true" aria-hidden="true">
      <div class="pv-detail-card">
        <div class="pv-detail-bars">
          <div class="pv-tb-item"><span class="pv-tb-line"></span><span class="pv-tb-lbl" data-i18n="turnLabel"></span><span class="pv-tb-val">42s</span></div>
          <div class="pv-tb-item"><span class="pv-tb-line"></span><span class="pv-tb-lbl" data-i18n="turnReqsLabel"></span><span class="pv-tb-val">2</span></div>
          <div class="pv-tb-item"><span class="pv-tb-line"></span><span class="pv-tb-lbl" data-i18n="turnThinking"></span><span class="pv-tb-val">640</span></div>
          <div class="pv-tb-item"><span class="pv-tb-line"></span><span class="pv-tb-lbl" data-i18n="turnWrite"></span><span class="pv-tb-val">1.4K</span></div>
        </div>
      </div>
    </div>
  </section>

  </main>
  <script>
    ${getPresentationScript()}
    const presentation = globalThis.__agyCapsulePresentation;
    let prefs = ${JSON.stringify(DEFAULT_SETTINGS)};
    let labels = presentation.apply(document.body, prefs);
    let settingsLabels = presentation.dictionaries[prefs.settingsLanguage];
    let savingSettings = false;
    let settingsEpoch = 0;
    let lastData = null;
    const sidebarTabs = document.querySelector('.sidebar-tabs');
    let sidebarView = 'stats';
    const sidebarScroll = { stats: 0, settings: 0 };
    function selectSidebarView(view, focus = false) {
      if (view !== sidebarView) {
        sidebarScroll[sidebarView] = window.scrollY;
        sidebarView = view;
        sidebarTabs.dataset.view = view;
        for (const name of ['stats', 'settings']) {
          const selected = name === view;
          const tab = document.getElementById('sidebar-tab-' + name);
          tab.setAttribute('aria-selected', String(selected));
          tab.tabIndex = selected ? 0 : -1;
          document.getElementById('sidebar-' + name).hidden = !selected;
        }
        window.scrollTo({ top: sidebarScroll[view], behavior: 'instant' });
      }
      if (focus) document.getElementById('sidebar-tab-' + view).focus({ preventScroll: true });
    }
    for (const view of ['stats', 'settings']) {
      document.getElementById('sidebar-tab-' + view).addEventListener('click', () => selectSidebarView(view));
    }
    sidebarTabs.querySelector('.sidebar-toggle-track').addEventListener('click', () => selectSidebarView(sidebarView === 'stats' ? 'settings' : 'stats', true));
    sidebarTabs.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const view = event.key === 'Home' ? 'stats' : event.key === 'End' ? 'settings' : sidebarView === 'stats' ? 'settings' : 'stats';
      selectSidebarView(view, true);
    });
    document.getElementById('row-cached').addEventListener('mouseenter', () => {
      if (lastData) document.getElementById('row-cached').title = presentation.cacheTooltip(lastData, labels, Date.now(), prefs);
    });
    for (const setting of document.querySelectorAll('.metric-setting')) {
      const resetHelp = () => {
        for (const other of document.querySelectorAll('.metric-setting')) other.dataset.helpDismissed = 'true';
        const help = setting.querySelector('.metric-help');
        if (help) {
          const roomAbove = setting.getBoundingClientRect().top - document.querySelector('.sidebar-nav').getBoundingClientRect().bottom;
          const below = roomAbove < help.getBoundingClientRect().height + 8;
          help.style.top = below ? 'calc(100% + 5px)' : 'auto';
          help.style.bottom = below ? 'auto' : 'calc(100% + 5px)';
        }
        setting.removeAttribute('data-help-dismissed');
      };
      setting.addEventListener('mouseenter', resetHelp);
      setting.addEventListener('focusin', resetHelp);
    }
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') for (const setting of document.querySelectorAll('.metric-setting')) setting.dataset.helpDismissed = 'true';
    });
    function applySettings(next) {
      prefs = { ...prefs, ...next };
      labels = presentation.apply(document.body, prefs);
      settingsLabels = presentation.dictionaries[prefs.settingsLanguage] || presentation.dictionaries['zh-CN'];
      sidebarTabs.lang = prefs.settingsLanguage;
      sidebarTabs.setAttribute('aria-label', settingsLabels.sidebarNavigation);
      document.getElementById('sidebar-tab-stats').textContent = settingsLabels.sidebarStats;
      document.getElementById('sidebar-tab-settings').textContent = settingsLabels.sidebarSettings;
      document.getElementById('sidebar-stats').lang = document.body.dataset.language;
      for (const select of document.querySelectorAll('.settings select[name]')) select.value = prefs[select.name];
      for (const checkbox of document.querySelectorAll('.settings input[type="checkbox"]')) {
        const checked = prefs[checkbox.name] === true;
        checkbox.checked = checked;
        const card = checkbox.closest('[data-setting-card]');
        if (card) card.dataset.checked = String(checked);
      }
      const speedCard = document.querySelector('[data-setting-card="showSpeed"]');
      if (speedCard) speedCard.dataset.speedFx = String(prefs.showSpeed !== false && prefs.speedAnimation === true);
      const speedAnimCard = document.querySelector('[data-setting-card="speedAnimation"]');
      if (speedAnimCard) speedAnimCard.dataset.parentOff = String(prefs.showSpeed === false);
      const turnPreview = document.querySelector('[data-preview-group="turn"]');
      if (turnPreview) turnPreview.dataset.open = String(prefs.showTurnMetrics !== false);
      updateControlState();
      for (const swatch of document.querySelectorAll('[data-pick-setting]')) {
        const active = String(prefs[swatch.dataset.pickSetting] === swatch.dataset.pickValue);
        swatch.dataset.active = active;
        swatch.setAttribute('aria-pressed', active);
        const label = settingsLabels[swatch.dataset.pickLabel] || ({ en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文' })[swatch.dataset.pickValue] || swatch.dataset.pickValue;
        const name = settingsLabels[swatch.dataset.pickSetting] + ': ' + label;
        swatch.setAttribute('aria-label', name);
        swatch.removeAttribute('title');
      }
      if (lastData) renderData(lastData);
    }
    applySettings(prefs);
    function apiOptions(path) {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token') || window.sidecar?.token || '';
      const query = new URLSearchParams();
      if (token) query.set('token', token);
      return { url: path + (query.size ? '?' + query : ''), headers: token ? { 'X-Sidecar-Token': token } : {} };
    }
    async function saveSettings(patch) {
        if (savingSettings) return;
        const previous = { ...prefs };
        savingSettings = true;
        settingsEpoch++;
        applySettings(patch);
        updateControlState();
        try {
          const api = apiOptions('/api/settings');
          const res = await fetch(api.url, { method: 'POST', headers: { ...api.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
          const data = await res.json();
          if (!res.ok || data.error) throw new Error('Save failed');
          applySettings(data);
        } catch {
          applySettings(previous);
          window.alert(settingsLabels.saveFailed);
        } finally {
          settingsEpoch++;
          savingSettings = false;
          updateControlState();
        }
    }
    for (const select of document.querySelectorAll('.settings select[name], .settings input[name]')) {
      select.addEventListener('change', () => {
        const value = select.type === 'checkbox' ? select.checked : select.value;
        const patch = { [select.name]: value };
        if (select.name === 'showSpeed' && !value) patch.speedAnimation = false;
        void saveSettings(patch);
      });
    }
    for (const swatch of document.querySelectorAll('[data-pick-setting]')) {
      swatch.addEventListener('click', () => {
        const key = swatch.dataset.pickSetting;
        const value = swatch.dataset.pickValue;
        if (prefs[key] !== value) void saveSettings({ [key]: value });
      });
    }
    function fmtK(n) {
      return presentation.formatTokens(n);
    }

    function fmtColK(n) {
      return presentation.formatTokens(n);
    }

    function makeRingSvg(frac) {
      const clamped = Math.max(0, Math.min(1, Number(frac || 0)));
      const r = 6.5;
      const c = 2 * Math.PI * r;
      const offset = c * (1 - clamped);
      const pctLeft = Math.round(clamped * 100);
      const color = pctLeft <= 10 ? '#ef4444' : (pctLeft <= 25 ? '#f59e0b' : '#4ea84e');
      return (
        '<svg width="18" height="18" viewBox="0 0 18 18" style="transform: rotate(-90deg); flex-shrink: 0;">' +
        '<circle cx="9" cy="9" r="' + r + '" fill="none" stroke="rgba(142,142,147,0.28)" stroke-width="2.2"/>' +
        '<circle cx="9" cy="9" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="2.2" stroke-linecap="round" ' +
        'stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + offset.toFixed(2) + '"/>' +
        '</svg>'
      );
    }

    function formatGroupTitle(raw) {
      const s = String(raw || '').trim();
      if (s === 'Gemini Models') return 'Gemini';
      if (s.toLowerCase().startsWith('claude')) return 'Claude';
      return s;
    }

    function renderQuota(groups) {
      const root = document.getElementById('quota-root');
      if (!Array.isArray(groups) || groups.length === 0) return;
      let html = '';
      const windowOrder = { '5h': 0, weekly: 1 };
      for (const g of groups) {
        html += '<div class="quota-group">';
        html += '<div class="quota-group-title">' + presentation.escapeHtml(formatGroupTitle(g.displayName)) + '</div>';
        const buckets = [...(g.buckets || [])].sort(
          (a, b) => (windowOrder[a.window] ?? 2) - (windowOrder[b.window] ?? 2)
        );
        for (const b of buckets) {
          const baseLabel =
            b.window === 'weekly'
              ? labels.weekly
              : b.window === '5h'
                ? labels.fiveHours
                : String(b.displayName || b.window || '')
                    .replace(/\\s*limit\\b/gi, '')
                    .replace(/\\b5h(?:ours)?\\b/gi, '5 Hours')
                    .trim();
          const resetShort = presentation.formatReset(b.resetTime, prefs);
          const pctLeft = Math.round((b.remainingFraction || 0) * 100);
          html += '<div class="quota-bucket">';
          html += '  <div class="quota-line1" data-quota-tooltip="' + presentation.escapeHtml(JSON.stringify({ pool: formatGroupTitle(g.displayName), window: b.window, displayName: b.displayName, remainingFraction: b.remainingFraction, resetTime: b.resetTime })) + '">';
          const color = pctLeft <= 10 ? '#ef4444' : pctLeft <= 25 ? '#f59e0b' : '#4ea84e';
          const indicator = presentation.appearance(prefs).quotaIndicator === 'bar'
            ? '<span class="quota-meter"><span style="width:' + Math.max(0, Math.min(100, pctLeft)) + '%;background:' + color + '"></span></span>'
            : makeRingSvg(b.remainingFraction);
          html += '    <span class="quota-label">' + presentation.escapeHtml(baseLabel) + '</span>';
          html += '    <span class="quota-right"><span class="notranslate" translate="no">' + pctLeft + '%</span>' + indicator + '</span>';
          html += '    <span class="quota-mid notranslate" translate="no">' + presentation.escapeHtml(resetShort) + '</span>';
          html += '  </div>';
          html += '</div>';
        }
        html += '</div>';
      }
      root.innerHTML = html;
      presentation.applyQuotaTooltips(root, labels);
    }

    async function refresh() {
      const requestedSettingsEpoch = settingsEpoch;
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const token = urlParams.get('token') || '';
        const convId = window.sidecar?.conversationId || urlParams.get('conversationId') || '';
        const qs = new URLSearchParams();
        if (convId) qs.set('conversationId', convId);
        if (token) qs.set('token', token);
        const qStr = qs.toString() ? '?' + qs.toString() : '';
        const headers = token ? { 'X-Sidecar-Token': token } : {};
        const res = await fetch('/api/context' + qStr, { method: 'GET', headers });
        const d = await res.json();
        if (d.error) return;
        if (d.uiVersion && d.uiVersion !== 94) {
          window.location.reload();
          return;
        }
        lastData = d;
        if (!savingSettings && requestedSettingsEpoch === settingsEpoch) applySettings(d.prefs);
        else renderData(d);
      } catch (e) {
        console.error(e);
      }
    }

    function renderData(d) {
        presentation.renderContextTooltips(document.querySelector('.panel'), d, labels);
        presentation.renderAlerts(document.body, d, prefs, labels);
        presentation.renderGeneration(document.querySelector('.panel'), d.generation, labels, prefs);
        presentation.renderTurnMetrics(document.querySelector('.panel'), d.turnMetrics, labels, prefs);
        const maxCtx = d.maxContextTokens || 0;
        const ctx = d.contextTokens || 0;
        const cached = d.cachedIn || 0;
        const out = d.totalOutputTokens || 0;
        const think = d.totalThinkingTokens || 0;
        const turn0 = d.turn0Tokens || 0;
        const read = Math.max(0, ctx - turn0 - out - think);

        const hasMax = maxCtx > 0;
        const usedPct = hasMax ? Math.round((ctx / maxCtx) * 100) : 0;
        const usedPctExact = hasMax ? Math.min(100, (ctx / maxCtx) * 100) : 0;
        const compSum = read + out + think + turn0;
        const scale = compSum > 0 ? usedPctExact / compSum : 0;

        const pctStr = (val) => (hasMax ? Math.round((val / maxCtx) * 100) + '%' : (ctx === 0 ? '0%' : '--%'));
        const readPct = pctStr(read);
        const outPct = pctStr(out);
        const thinkPct = pctStr(think);
        const turn0Pct = pctStr(turn0);

        const usedPctEl = document.getElementById('used-pct');
        usedPctEl.textContent = (hasMax ? usedPct : ctx === 0 ? '0' : '--') + '%';

        document.getElementById('used-fraction').textContent = fmtK(ctx) + ' / ' + (hasMax ? fmtK(maxCtx) : '--');

        const dotCachedEl = document.getElementById('dot-cached');
        document.getElementById('seg-read').style.width = (read * scale).toFixed(2) + '%';
        document.getElementById('seg-out').style.width = (out * scale).toFixed(2) + '%';
        document.getElementById('seg-think').style.width = (think * scale).toFixed(2) + '%';
        document.getElementById('seg-turn0').style.width = (turn0 * scale).toFixed(2) + '%';

        const cache = presentation.cacheView(d, prefs);
        const valCacheHitEl = document.getElementById('val-cache-hit');
        const valCacheHitKEl = document.getElementById('val-cache-hit-k');
        dotCachedEl.innerHTML = cache.iconSvg;
        valCacheHitEl.style.color = cache.valColor;
        valCacheHitEl.style.textDecoration = cache.valDeco;
        valCacheHitEl.style.opacity = cache.valOp;
        valCacheHitEl.textContent = cache.text;
        if (valCacheHitKEl) {
          valCacheHitKEl.style.color = cache.valColor || 'var(--muted-foreground, #8e8e93)';
          valCacheHitKEl.textContent = cache.countdown;
        }
        document.getElementById('row-cached').title = presentation.cacheTooltip(d, labels, Date.now(), prefs);

        document.getElementById('val-turn0-k').textContent = fmtColK(turn0);
        document.getElementById('val-read-k').textContent = fmtColK(read);
        document.getElementById('val-think-k').textContent = fmtColK(think);
        document.getElementById('val-out-k').textContent = fmtColK(out);

        if (d.quotaGroups) {
          renderQuota(d.quotaGroups);
        }
    }

    function updateControlState() {
      const busy = savingSettings;
      for (const control of document.querySelectorAll('.settings select, .settings input, .settings button:not(.setting-help-dot)')) {
        control.disabled = busy || (control.name === 'speedAnimation' && prefs.showSpeed === false);
      }
    }
    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;

export { inspectConversation, UI_HTML, parseGenRow, readConversationSnapshot };

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const { SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();
  app.page('/', () => UI_HTML);
  app.page('/ui.html', () => UI_HTML);
  app.api('/api/context', (data) => inspectConversation(data?.conversationId || app.config.conversationId), 'GET');
  app.api('/api/settings', () => settingsStore.read(), 'GET');
  app.api('/api/settings', (data) => settingsStore.update(data), 'POST');
  app.run();
}
if (process.env.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const injector = startDeckInjector(inspectConversation);
  let stopping = false;
  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    stopWatching();
    console.log('[agy-capsule] restarting/stopping:', reason);
    try { await injector.stop(); }
    finally { process.exit(0); }
  };
  const stopWatching = startSelfReloadWatcher(dirname(fileURLToPath(import.meta.url)), () => void shutdown('plugin files changed'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void shutdown(signal));
}
